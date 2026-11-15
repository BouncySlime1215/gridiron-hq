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

const { byePatches, byeOutlook } = await import('../server/services/roster-risk.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
const POSITION_ID = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DEF: 16 };
const project = (p, points) => run(
  `INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games) VALUES (?,2026,'projected',?,17)`,
  p.id, points);

// A roster whose starters share a bye, so the page has a week worth acting on.
const squad = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE'].map((position, i) => {
  const p = rows(`SELECT p.id, p.name, p.team_id, t.abbr AS team_abbr FROM players p
                  JOIN nfl_teams t ON t.id = p.team_id
                  WHERE p.position = ? AND p.fantasy_relevant = 1
                  ORDER BY p.id LIMIT 6`, position)[i];
  project(p, 240);
  return { ...p, position };
});

// Every bye in this fixture, and why it is set by hand. `matchupModel` calls the
// first week from 4 to 14 with no scheduled game a team's bye (matchups.js:324),
// and the only schedule row seeded above is week 1 — so left alone, EVERY team
// byes in week 4: the squad and the whole wire together. A free agent on the same
// bye is dropped by `fa.bye !== bad.week` before anything scores him, which means
// no candidate can ever rank and every assertion about the ranked list below is
// vacuous. `players.bye_week` does not enter this; it was never populated and
// nothing here reads it.
//
// So every team EXCEPT the squad's is given a week-4 game, moving the whole wire's
// bye to 5 and leaving the squad's at 4. The wire is then held off the list only
// by what the code does, which is the single thing these tests exist to check.
const SQUAD_TEAMS = squad.map(p => p.team_id);
run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home)
     SELECT 2026, id, 4, 'OPP', 1 FROM nfl_teams WHERE id NOT IN (${SQUAD_TEAMS.join(',')})`);

// The only unrostered priced players in league 601 are a kicker and a defense, so
// its ranked list must come back empty and the reading must say why.
const onWire = position => row(
  `SELECT p.id, p.name, p.team_id FROM players p
   WHERE p.position = ? AND p.fantasy_relevant = 1 AND p.team_id NOT IN (${SQUAD_TEAMS.join(',')})
   ORDER BY p.id LIMIT 1`, position);
const freeKicker = onWire('K');
const freeDefense = onWire('DEF');
project(freeKicker, 200);
project(freeDefense, 200);

// A genuinely rankable patch: a receiver who byes in week 5 like the rest of the
// wire and would plainly crack a lineup with seven empty slots. He is rostered by
// the other team in league 601, so 601's wire still holds nothing but the kicker
// and the defense and the two tests below are unaffected — and he is left off
// league 602's payload, where he is the free agent that makes the K/DEF assertion
// mean something.
const freeWideout = onWire('WR');
assert.ok(freeWideout, 'the seed must hold a receiver on none of the squad\'s teams');
project(freeWideout, 300);

const entry = p => ({ playerPoolEntry: { player: {
  id: p.id, fullName: p.name, defaultPositionId: POSITION_ID[p.position] } } });
const myTeam = { id: 1, name: 'My Team', roster: { entries: squad.map(entry) } };

run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id,
     roster_positions, connection_status)
     VALUES (601, 'espn', 'bye-601', 2026, 'Bye Risk', ?, 2, '1', ?, 'connected')`,
  JSON.stringify({ teams: [myTeam, { id: 2, name: 'Them',
    roster: { entries: [entry({ ...freeWideout, position: 'WR' })] } }] }),
  JSON.stringify(SLOTS));

// Same roster, same bye, but the receiver above is unowned. This league is the
// one that can produce a ranked candidate at all, which is what test 3 needs:
// an assertion about what is NOT in a list proves nothing over an empty list.
run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id,
     roster_positions, connection_status)
     VALUES (602, 'espn', 'bye-602', 2026, 'Bye Risk, live wire', ?, 2, '1', ?, 'connected')`,
  JSON.stringify({ teams: [myTeam] }), JSON.stringify(SLOTS));

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

test('a kicker or defense never appears as a patch, on a wire that can produce one', () => {
  // Saying so is not a licence to list them at a fabricated recovery.
  //
  // Read against league 602, not 601. In 601 the wire holds nothing but a kicker
  // and a defense, so every candidate list is empty and a loop asserting "no K or
  // DEF in this list" would pass over nothing at all — a defect injection that
  // widened `bestLineup`'s SCORED set and deleted the filter here left this test
  // green, which is how that was found. 602 has a receiver who genuinely ranks,
  // so the list is non-empty and the absence is a fact about the filter.
  const result = byePatches(602, { myTeamId: '1' });
  const candidates = (result.patches ?? []).flatMap(p => p.candidates);
  assert.ok(candidates.length > 0,
    'the fixture must produce at least one ranked patch, or this test checks nothing');
  // Matched on name because a candidate carries no id (roster-risk.js:200).
  assert.ok(candidates.some(c => c.name === freeWideout.name),
    'and the one it produces must be the receiver, not something incidental');
  for (const c of candidates) {
    assert.ok(!['K', 'DEF'].includes(c.position),
      `${c.position} must not be offered by a solver that does not score it`);
  }
});

test('the underlying outlook is unchanged', () => {
  // This PR must not move what the page says about the roster itself. Compared
  // field by field against `byeOutlook`, the function `byePatches` spreads, rather
  // than type-checked: an injection that nudged every week's points_lost by one
  // left the original `typeof from_week === 'number'` assertion green.
  const patched = byePatches(601, { myTeamId: '1' });
  const plain = byeOutlook(601, { myTeamId: '1' });
  assert.equal(patched.from_week, plain.from_week);
  assert.equal(patched.reading, plain.reading);
  assert.deepEqual(patched.weeks, plain.weeks);
  assert.ok(plain.weeks.length > 0, 'and the outlook being compared must be non-empty');
});
