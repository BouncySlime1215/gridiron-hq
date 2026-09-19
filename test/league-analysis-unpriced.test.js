import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-league-analysis-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { default: leaguesRouter } = await import('../server/routes/leagues.js');
const { requireAuthenticated, hashSessionToken } = await import('../server/platform/auth.js');
const express = (await import('express')).default;

// Same mounting rationale as test/league-removal.test.js: plain
// requireAuthenticated, because leagues.js does its own per-league member check
// and this suite is about what the analysis says, not about rate limiting.
const app = express();
app.use(express.json());
app.use('/api/leagues', requireAuthenticated, leaguesRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/api/leagues`;

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

// ESPN's defaultPositionId encoding, as leagues.js reads it.
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };

function insertPlayer(name, position) {
  // Deliberately no espn_id — that is the live state, and it is what forces the
  // join in extractRosters onto its name|position fallback.
  run('INSERT INTO players (name, position, fantasy_relevant) VALUES (?,?,1)', name, position);
  return row('SELECT last_insert_rowid() AS id').id;
}

const known = {
  QB: [insertPlayer('Alpha Passer', 'QB'), insertPlayer('Bravo Passer', 'QB')],
  RB: [insertPlayer('Alpha Runner', 'RB'), insertPlayer('Bravo Runner', 'RB')],
  WR: [insertPlayer('Alpha Catcher', 'WR'), insertPlayer('Bravo Catcher', 'WR')],
  TE: [insertPlayer('Alpha Tight', 'TE'), insertPlayer('Bravo Tight', 'TE')]
};
const nameOf = id => row('SELECT name FROM players WHERE id = ?', id).name;
const posOf = id => row('SELECT position FROM players WHERE id = ?', id).position;

let espnId = 0;
function entry(name, position) {
  espnId += 1;
  return { playerPoolEntry: { player: { id: 900000 + espnId, fullName: name, defaultPositionId: POS_ID[position] } } };
}

// Two teams so the league average is a real average. Each team also carries one
// player the local table has never heard of, which is what a real roster looks
// like when the player universe has not synced.
const payload = {
  teams: [0, 1].map(i => ({
    id: i + 1,
    name: `Team ${i + 1}`,
    roster: {
      entries: [
        ...['QB', 'RB', 'WR', 'TE'].map(pos => entry(nameOf(known[pos][i]), posOf(known[pos][i]))),
        entry(`Unknown Player ${i + 1}`, 'WR')
      ]
    }
  }))
};

run(`INSERT INTO leagues (platform, league_id, season, name, payload, roster_positions)
     VALUES ('espn','analysis-league',2026,'Analysis League',?,?)`,
  JSON.stringify(payload), JSON.stringify(['QB', 'RB', 'WR', 'TE']));
const leagueId = row('SELECT last_insert_rowid() AS id').id;

const token = 'league-analysis-token';
run('INSERT INTO users (subject, display_name) VALUES (?,?)', 'analysis-tester', 'Analysis Tester');
const userId = row('SELECT last_insert_rowid() AS id').id;
run('INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,?)', leagueId, userId, 'commissioner');
run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now','+1 day'))`,
  userId, hashSessionToken(token));

const analysis = async () => {
  const res = await fetch(`${base}/${leagueId}/analysis`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  return res.json();
};

test('with no trade values loaded, the analysis refuses to grade instead of calling every position a need', async () => {
  const body = await analysis();
  assert.equal(body.values_missing, true,
    'a league whose players carry no fc_value must be reported as unpriced');
  assert.deepEqual(body.rosters, [],
    'no roster verdicts may be emitted when nothing has a value');
  assert.match(body.message, /trade values/i);
});

test('coverage reports the rostered players the local table could not match', async () => {
  const body = await analysis();
  assert.equal(body.coverage.rostered_in_payload, 10, 'both teams put five players on the wire');
  assert.equal(body.coverage.matched_to_player_table, 8, 'the two unknown players cannot join');
  assert.equal(body.coverage.priced, 0);
});

test('a position nobody in the league has a value for reads as unknown, not as a need', async () => {
  // Price the quarterbacks only. Every other position stays at a league average
  // of zero, which is precisely the case that used to divide by `|| 1` and come
  // back as a confident NEED 0% for every team.
  run(`INSERT INTO player_metrics (player_id, source, value) VALUES (?,'fc_value',?)`, known.QB[0], 8000);
  run(`INSERT INTO player_metrics (player_id, source, value) VALUES (?,'fc_value',?)`, known.QB[1], 4000);

  const body = await analysis();
  assert.equal(body.values_missing, undefined, 'one priced position is enough to grade that position');
  assert.equal(body.coverage.priced, 2);

  for (const ro of body.rosters) {
    for (const pos of ['RB', 'WR', 'TE']) {
      assert.equal(ro.positions[pos].status, 'unknown',
        `${ro.owner} ${pos} has no values anywhere in the league, so it has no verdict`);
      assert.equal(ro.positions[pos].ratio, null);
      assert.ok(!ro.needs.includes(pos), `${pos} must not be reported as a need on no data`);
      assert.ok(!ro.surplus.includes(pos), `${pos} must not be reported as a surplus on no data`);
    }
  }

  // The graded position still grades: 8000 vs 4000 against a 6000 average is a
  // surplus and a need respectively, which is the behaviour being preserved.
  const byOwner = Object.fromEntries(body.rosters.map(ro => [ro.owner, ro]));
  assert.equal(byOwner['Team 1'].positions.QB.status, 'surplus');
  assert.equal(byOwner['Team 2'].positions.QB.status, 'need');
});

test('a team defence matches instead of being silently dropped', async () => {
  // ESPN sends D/ST as defaultPositionId 16. The map in extractRosters used to
  // stop at 5, so every defence keyed with an empty position, matched nothing
  // and was dropped by the filter — while trade-engine.js, which has 16 in its
  // copy of the same map, still counted it.
  const defId = insertPlayer('Alpha Defense', 'DEF');
  const defPayload = {
    teams: [{
      id: 1,
      name: 'Defence Team',
      roster: { entries: [{ playerPoolEntry: { player: { id: 990001, fullName: nameOf(defId), defaultPositionId: 16 } } }] }
    }]
  };
  run(`INSERT INTO leagues (platform, league_id, season, name, payload, roster_positions)
       VALUES ('espn','defence-league',2026,'Defence League',?,?)`,
    JSON.stringify(defPayload), JSON.stringify(['QB', 'RB', 'WR', 'TE', 'DEF']));
  const defLeagueId = row('SELECT last_insert_rowid() AS id').id;
  run('INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,?)', defLeagueId, userId, 'commissioner');

  const res = await fetch(`${base}/${defLeagueId}/analysis`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.coverage.rostered_in_payload, 1);
  assert.equal(body.coverage.matched_to_player_table, 1, 'the defence must join, not vanish');
});
