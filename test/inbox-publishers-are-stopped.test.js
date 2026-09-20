/**
 * The two engines that wrote into the Decision Inbox stop writing.
 *
 * The inbox's four routes and its mount are removed by the wiring map's
 * `caac88a` (an ancestor of `4389a7a`): server/index.js no longer imports
 * `decisionInboxRouter` and no longer mounts `/api/decision-inbox`. Nothing
 * serves the table any more, and nothing on the client ever read it — a grep for
 * `decision-inbox` across `client/src` returns no hits, and the rows that were
 * published carried `link: '/brain'`, a path App.tsx does not route and which
 * therefore fell through to its NotFound catch-all.
 *
 * So the table has two writers, no reader, and its rows point at a page that
 * does not exist. The writers stop. `publishRecommendation` itself stays where
 * it is and is still exported, and the table and its migration are untouched —
 * dropping a table is a migration and a separate decision.
 *
 * WHAT MAKES A ZERO HERE MEAN ANYTHING. "No rows were written" is the emptiest
 * assertion in testing: it passes when the table is missing, when the fixture
 * produced nothing worth publishing, and when the code under test never ran. All
 * three are ruled out below before the zero is asserted — the table exists and
 * accepts a row, the fixture produces an upgrade above the exact threshold the
 * deleted publish was gated on, and the function's own return value is checked
 * to prove it ran and still works.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-inbox-stopped-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const applied = await runMigrations();
const { seedIfEmpty } = await import('../server/db/seed/index.js');
seedIfEmpty();
// waiverUpgrades and lineupDiff price THIS week, which is 0 for a team with no
// game on the schedule; the slate is cached per process, so this lands first.
run(`INSERT OR IGNORE INTO schedule_games (season, team_id, week, opponent_abbr, home)
     SELECT 2026, id, 1, abbr, 1 FROM nfl_teams`);

await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');

const { publishRecommendation } = await import('../server/routes/decision-inbox.js');
const { waiverUpgrades } = await import('../server/services/waiver-brain.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SRC = f => fs.readFileSync(new URL(`../server/services/${f}`, import.meta.url), 'utf8');
const countRows = () => row('SELECT COUNT(*) AS n FROM decision_recommendations').n;

function insertLeague(leagueId, payload, rosterPositions) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, 'Inbox Stopped League', ?, 2, '1', ?, 'x', 'y', 'connected')`,
  leagueId, `inbox-stopped-${leagueId}`, JSON.stringify(payload), JSON.stringify(rosterPositions));
}

/* ------------------------------------------------- the zero is not vacuous */

test('the table and its migration survive — this is a writer change, not a schema change', () => {
  assert.ok(applied.includes('020_decision_recommendations'));
  assert.ok(row(`SELECT name FROM sqlite_master WHERE type='table' AND name='decision_recommendations'`),
    'decision_recommendations must still exist; dropping it is a migration and a separate decision');
});

test('publishRecommendation still exists and still works — it is the callers that stop', () => {
  assert.equal(typeof publishRecommendation, 'function');
  // A real league row: decision_recommendations carries a foreign key to it, so
  // a proof written against a league id that does not exist proves nothing and
  // fails for the wrong reason.
  insertLeague(400, { teams: [] }, ['QB', 'RB', 'WR', 'TE']);
  publishRecommendation({
    dedupKey: 'proof:1', leagueId: 400, sport: 'NFL', type: 'lineup',
    title: 'Proof that a row can still be written', sourceModel: 'test', sourceVersion: 'v1'
  });
  assert.equal(countRows(), 1, 'the table must accept a row, or every zero below proves nothing');
  run('DELETE FROM decision_recommendations');
});

/* ------------------------------------------------------ the waiver publisher */

test('waiverUpgrades() finds a real upgrade and publishes nothing', () => {
  run('DELETE FROM decision_recommendations');
  run('DELETE FROM player_season_stats');

  const [strong, weak] = rows(`SELECT id, name FROM players WHERE position = 'RB' AND fantasy_relevant = 1 ORDER BY id LIMIT 2`);
  const qb = row(`SELECT id, name FROM players WHERE position = 'QB' AND fantasy_relevant = 1 LIMIT 1`);
  const wr = row(`SELECT id, name FROM players WHERE position = 'WR' AND fantasy_relevant = 1 LIMIT 1`);
  const te = row(`SELECT id, name FROM players WHERE position = 'TE' AND fantasy_relevant = 1 LIMIT 1`);
  run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games) VALUES (?,2026,'projected',300,17)`, strong.id);
  run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games) VALUES (?,2026,'projected',50,17)`, weak.id);

  // `strong` is deliberately on no roster, so the wire has someone worth claiming.
  insertLeague(401, {
    teams: [{
      id: 1, name: 'My Team',
      roster: { entries: [
        { playerPoolEntry: { player: { id: 9301, fullName: qb.name, defaultPositionId: 1 } } },
        { playerPoolEntry: { player: { id: 9302, fullName: weak.name, defaultPositionId: 2 } } },
        { playerPoolEntry: { player: { id: 9303, fullName: wr.name, defaultPositionId: 3 } } },
        { playerPoolEntry: { player: { id: 9304, fullName: te.name, defaultPositionId: 4 } } }
      ] }
    }]
  }, ['QB', 'RB', 'WR', 'TE']);

  const result = waiverUpgrades(401, { myTeamId: '1' });

  // Proof the function ran and still does its job — without this the zero below
  // could simply mean waiverUpgrades threw, or found nothing.
  assert.ok(result.upgrades?.length, 'the fixture must still produce at least one upgrade');
  assert.equal(result.upgrades[0].player.name, strong.name);
  // The exact bar the deleted publish was gated on. Clearing it is what makes
  // the zero meaningful: this is a row the old code WOULD have written.
  assert.ok(result.upgrades[0].expected_value > 0.75,
    'the top upgrade must clear the old publish threshold, or nothing was suppressed');

  assert.equal(countRows(), 0, 'waiverUpgrades must not write to the Decision Inbox');
});

/* ------------------------------------------------------------ source guards */

test('neither engine imports the publisher any more', () => {
  for (const f of ['waiver-brain.js', 'trade-engine.js']) {
    assert.doesNotMatch(SRC(f), /import\s*\{[^}]*publishRecommendation[^}]*\}\s*from/,
      `${f} still imports publishRecommendation`);
    assert.doesNotMatch(SRC(f), /^\s*publishRecommendation\(/m,
      `${f} still calls publishRecommendation`);
  }
});

test('neither engine writes decision_recommendations by hand either', () => {
  // The other way to keep a writer: leave the SQL and drop the helper. The
  // lineup publisher had an `else` branch that expired its own open row, and a
  // retirement that removed the publish and kept the UPDATE would still be a
  // writer to a table nothing reads.
  for (const f of ['waiver-brain.js', 'trade-engine.js']) {
    assert.doesNotMatch(SRC(f), /decision_recommendations/,
      `${f} still names the decision_recommendations table`);
  }
});
