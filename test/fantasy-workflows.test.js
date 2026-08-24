import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Same isolated-DB pattern as test/model-integrity.test.js: point GRIDIRON_DB_PATH
// at a throwaway file before anything imports server/db/index.js, so this suite
// never touches the real data.sqlite.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-fantasy-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows, row, run } = await import('../server/db/index.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
const { evaluate, bestLineup, lineupSlots } = await import('../server/services/trade-engine.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

seedIfEmpty();

/* -------------------------------------------------- draftable pool guarantee */
// The audit's P0: a fresh install used to have zero fantasy_relevant kickers,
// zero team defenses, and only ~96 relevant offensive players — a 12-team,
// 16-round draft (192 picks) could exhaust its own player pool. This asserts
// the fix actually holds, not just that it looked right in a one-off curl.

test('fresh seed has enough fantasy_relevant players for a full 12x16 draft', () => {
  const total = row(`SELECT COUNT(*) AS n FROM players WHERE fantasy_relevant = 1`).n;
  assert.ok(total >= 192, `only ${total} fantasy_relevant players seeded, need >= 192 for a 12-team/16-round draft`);
});

test('fresh seed includes real, drafted kickers and team defenses', () => {
  const k = row(`SELECT COUNT(*) AS n FROM players WHERE position = 'K' AND fantasy_relevant = 1`).n;
  const def = row(`SELECT COUNT(*) AS n FROM players WHERE position = 'DEF' AND fantasy_relevant = 1`).n;
  assert.equal(k, 32, 'every team should seed one fantasy-relevant kicker');
  assert.equal(def, 32, 'every team should seed one team DEF unit');
});

test('individual defensive players stay out of the fantasy pool (not a standard fantasy position)', () => {
  const n = row(`SELECT COUNT(*) AS n FROM players
                WHERE position IN ('EDGE','DL','LB','CB','S') AND fantasy_relevant = 1`).n;
  assert.equal(n, 0, 'EDGE/DL/LB/CB/S are depth-chart/X-and-O data, not draftable fantasy assets');
});

/* --------------------------------------------------------- draft_picks lifecycle */

test('draft_picks enforces one player per draft and one pick number per draft', () => {
  run(`INSERT INTO drafts (name, type, team_count, rounds, my_slot, pick_seconds)
       VALUES ('test draft', 'mock', 10, 2, 1, 90)`);
  const draftId = row('SELECT last_insert_rowid() AS id').id;
  const [p1, p2] = rows(`SELECT id FROM players WHERE fantasy_relevant = 1 LIMIT 2`);

  run('INSERT INTO draft_picks (draft_id, pick_number, team_slot, player_id) VALUES (?,1,1,?)', draftId, p1.id);

  assert.throws(
    () => run('INSERT INTO draft_picks (draft_id, pick_number, team_slot, player_id) VALUES (?,1,2,?)', draftId, p2.id),
    /UNIQUE/,
    'the same pick_number should never be insertable twice in one draft');

  assert.throws(
    () => run('INSERT INTO draft_picks (draft_id, pick_number, team_slot, player_id) VALUES (?,2,2,?)', draftId, p1.id),
    /UNIQUE/,
    'the same player should never be draftable twice in one draft');

  run('DELETE FROM draft_picks WHERE draft_id = ?', draftId);
  run('DELETE FROM drafts WHERE id = ?', draftId);
});

/* ------------------------------------------------------- trade realism invariant */
// This is the specific bug fixed earlier this session: the trade engine used to
// score deals purely on lineup-points/value math, blind to whether a package would
// leave the other side with an empty starting slot. bestLineup().holes was already
// computed — it just was never checked before deciding a deal was "plausible."

const SLOTS = ['QB', 'RB', 'WR', 'WR', 'TE'];
const asset = (id, position, adj_ppg, value = 1000) => ({
  id, name: `Player ${id}`, position, team_abbr: 'AAA', espn_id: null, sleeper_id: null,
  value, proj: adj_ppg * 17, ppg: adj_ppg, adj_ppg,
  age: 25, bye: 9, injury: 0, floor: null, ceiling: null, consistency: null,
  sos: 1, playoff_sos: 1
});

test('evaluate() never calls a trade plausible if it leaves the other team with an empty starting slot', () => {
  // Team B has exactly one player per slot — no bench, no depth at RB.
  const teamB = {
    roster_id: 'B', owner: 'Thin Team',
    players: [
      asset(1, 'QB', 18), asset(2, 'RB', 14), asset(3, 'WR', 12), asset(4, 'WR', 11), asset(5, 'TE', 8)
    ]
  };
  const teamA = {
    roster_id: 'A', owner: 'Me',
    // A throwaway WR, not a replacement RB — B must not get an RB back, or the
    // hole this test exists to catch gets silently filled by the incoming asset.
    players: [asset(6, 'WR', 6)]
  };

  const ev = evaluate(
    { team: teamA, gives: [asset(6, 'WR', 6)] },
    { team: teamB, gives: [teamB.players[1]] },   // B gives away their only RB, gets a WR back
    SLOTS
  );

  assert.ok(ev.them.new_holes.includes('RB'), 'the counterparty should show an RB hole after losing their only one');
  assert.equal(ev.plausible, false, 'a trade that empties a starting slot must never be marked plausible');
});

test('evaluate() allows a trade that clearly improves both lineups without holes', () => {
  const teamA = {
    roster_id: 'A', owner: 'Me',
    players: [asset(10, 'QB', 15), asset(11, 'RB', 10), asset(12, 'RB', 9), asset(13, 'WR', 9), asset(14, 'WR', 8), asset(15, 'TE', 6)]
  };
  const teamB = {
    roster_id: 'B', owner: 'Them',
    players: [asset(20, 'QB', 14), asset(21, 'RB', 16), asset(22, 'RB', 9), asset(23, 'WR', 12), asset(24, 'WR', 8), asset(25, 'TE', 7)]
  };
  // A trades its weaker RB(12) for B's stronger RB(21); B still has RB(22) as a
  // starter, and gets A's better WR(13) in return for its weaker WR(24).
  const ev = evaluate(
    { team: teamA, gives: [teamA.players[2], teamA.players[3]] },   // RB 9ppg + WR 9ppg
    { team: teamB, gives: [teamB.players[1], teamB.players[4]] },   // RB 16ppg + WR 8ppg
    SLOTS
  );
  assert.equal(ev.them.new_holes.length, 0, 'B keeps a startable RB and WR after this trade');
  assert.equal(ev.me.ppg_delta > 0, true, 'my lineup should improve — I upgraded my RB1');
});

/* ---------------------------------------------------------------- league CRUD */

test('leagues table round-trips a create/read/delete cycle', () => {
  run(`INSERT INTO leagues (platform, league_id, season, name) VALUES ('sleeper', '999', 2026, 'Test League')`);
  const id = row('SELECT last_insert_rowid() AS id').id;
  const found = row('SELECT * FROM leagues WHERE id = ?', id);
  assert.equal(found.name, 'Test League');
  run('DELETE FROM leagues WHERE id = ?', id);
  assert.equal(row('SELECT * FROM leagues WHERE id = ?', id), undefined);
});
