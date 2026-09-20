/**
 * The bye-risk page told you nothing on the wire could fix a week, without
 * saying it had never looked at two positions (2026-09-19).
 *
 * Companion to test/waiver-kicker-defense.test.js, which fixed the same defect
 * on the waiver board. `byePatches` draws its pool from the same `freeAgents`,
 * ranks every candidate through `bestLineup`, and `bestLineup` scores only
 * QB/RB/WR/TE by design. A kicker or defense therefore recovers exactly zero
 * points, is removed at `recovered > 0.25`, and the page concludes:
 *
 *   "Week 9 costs 14 points and nothing on the wire fixes it — this one has to
 *    come from a trade or be absorbed."
 *
 * Which is advice, drawn from a search that never ran on those positions. If
 * Nick's defense is on bye, that is exactly the week this page is for.
 *
 * Nothing here changes what the solver scores. It changes what the page claims
 * about what it did not score.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-byerisk-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
process.env.NFL_WEEK = '2';

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { seedIfEmpty } = await import('../server/db/seed/index.js');
seedIfEmpty();
run(`INSERT OR IGNORE INTO schedule_games (season, team_id, week, opponent_abbr, home)
     SELECT 2026, id, 1, abbr, 1 FROM nfl_teams`);
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');

const { byePatches } = await import('../server/services/roster-risk.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
const POSITION_ID = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DEF: 16 };
const project = (p, points) => run(
  `INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games) VALUES (?,2026,'projected',?,17)`,
  p.id, points);

// A roster whose starters share a bye, so the page has a week worth acting on.
const squad = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE'].map((position, i) => {
  const p = rows(`SELECT id, name FROM players WHERE position = ? AND fantasy_relevant = 1
                  ORDER BY id LIMIT 6`, position)[i];
  project(p, 240);
  return { ...p, position };
});
run(`UPDATE players SET bye_week = 9 WHERE id IN (${squad.map(p => p.id).join(',')})`);

// The only unrostered priced players are a kicker and a defense, so the ranked
// list must come back empty and the reading must say why.
const freeKicker = row(`SELECT id, name FROM players WHERE position = 'K' AND fantasy_relevant = 1 ORDER BY id LIMIT 1`);
const freeDefense = row(`SELECT id, name FROM players WHERE position = 'DEF' AND fantasy_relevant = 1 ORDER BY id LIMIT 1`);
project(freeKicker, 200);
project(freeDefense, 200);

run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id,
     roster_positions, connection_status)
     VALUES (601, 'espn', 'bye-601', 2026, 'Bye Risk', ?, 2, '1', ?, 'connected')`,
  JSON.stringify({ teams: [{ id: 1, name: 'My Team', roster: { entries: squad.map(p => ({
    playerPoolEntry: { player: { id: p.id, fullName: p.name, defaultPositionId: POSITION_ID[p.position] } } })) } }] }),
  JSON.stringify(SLOTS));

test('the page names the positions it never scored', () => {
  const result = byePatches(601, { myTeamId: '1' });
  assert.ok(result.not_modelled, 'the omission is stated');
  assert.deepEqual(result.not_modelled.positions, ['DEF', 'K']);
  assert.ok(result.not_modelled.in_pool > 0);
  assert.match(result.not_modelled.why, /not scored by the lineup solver/);
});

test('"nothing on the wire fixes it" cannot stand alone over an unscored position', () => {
  const result = byePatches(601, { myTeamId: '1' });
  const empty = (result.patches ?? []).filter(p => !p.candidates.length);
  // Asserted rather than assumed: a fixture that produced no such week would
  // make the loop below vacuous and this test would pass having checked nothing.
  assert.ok(empty.length > 0, 'the fixture must produce a week with no patch');
  for (const p of empty) {
    assert.match(p.reading, /does not score at all/,
      'a week with no patch must say what was never searched');
  }
});

test('a kicker or defense never appears as a patch', () => {
  // Saying so is not a licence to list them at a fabricated recovery.
  const result = byePatches(601, { myTeamId: '1' });
  for (const p of result.patches ?? []) {
    for (const c of p.candidates) {
      assert.ok(!['K', 'DEF'].includes(c.position),
        `${c.position} must not be offered by a solver that does not score it`);
    }
  }
});

test('the underlying outlook is unchanged', () => {
  // This PR must not move what the page says about the roster itself.
  const result = byePatches(601, { myTeamId: '1' });
  assert.equal(typeof result.from_week, 'number');
  assert.ok(Array.isArray(result.weeks));
});
