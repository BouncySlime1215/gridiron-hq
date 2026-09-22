/**
 * The waiver, bye-risk and sell-high surfaces each asked the BETTING schedule
 * table what week it was (2026-09-19).
 *
 * `tradeWeekContext()` now takes a league and reads `leagueCurrentWeek(lg)`
 * (ESPN's own `status.currentMatchupPeriod`, captured at the last league sync).
 * Its no-league fallback — the first unscored row in `game_lines`, then 1 — is
 * kept for the callers that genuinely have no league. These seven call sites
 * all had one and were not passing it, so with no betting lines loaded every
 * one of them thought it was week 1.
 *
 * Week 1 in a live season is not a small error on these surfaces. `playoffWeight`
 * ramps on it, so waiver and sell-high candidates are priced for a season that
 * has not started; `byeOutlook` counts bye weeks "remaining" from it, so weeks
 * already played come back as future problems.
 *
 * No `game_lines` rows are loaded here on purpose: that is what makes the old
 * behaviour answer 1 and the new behaviour answer the league's own week, so
 * each assertion below fails without the change rather than merely passing
 * with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-week-surfaces-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
delete process.env.NFL_WEEK;

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

const { freeAgents, waiverUpgrades, sellHigh } = await import('../server/services/waiver-brain.js');
const { waiverBoard } = await import('../server/services/waiver-wire.js');
const { byeOutlook, byePatches } = await import('../server/services/roster-risk.js');
const { tradeWeekContext } = await import('../server/services/trade-engine.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
const POSITION_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const LEAGUE_WEEK = 9;

// Only projected players are priced, so this is the whole universe the surfaces
// below can see.
const squad = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE'].map((position, i) => {
  const p = rows(`SELECT id, name FROM players WHERE position = ? AND fantasy_relevant = 1
                  ORDER BY id LIMIT 6`, position)[i];
  run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games)
       VALUES (?,2026,'projected',?,17)`, p.id, 200);
  return { ...p, position };
});
// One unrostered player, so the pools are not empty.
const spare = rows(`SELECT id, name FROM players WHERE position = 'WR' AND fantasy_relevant = 1
                    ORDER BY id DESC LIMIT 1`)[0];
run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games)
     VALUES (?,2026,'projected',280,17)`, spare.id);

const entry = p => ({ playerPoolEntry: { player: {
  id: p.id, fullName: p.name, defaultPositionId: POSITION_ID[p.position] } } });

function league(id, currentWeek) {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, current_week, connection_status)
       VALUES (?, 'espn', ?, 2026, 'Week Test', ?, 2, '1', ?, ?, 'connected')`,
    id, `week-${id}`,
    JSON.stringify({ teams: [{ id: 1, name: 'My Team', roster: { entries: squad.map(entry) } }] }),
    JSON.stringify(SLOTS), currentWeek);
  return row('SELECT * FROM leagues WHERE id = ?', id);
}

const main = league(501, LEAGUE_WEEK);
// A second league identical but for its week, for the surfaces that do not
// print the week and can only be read through what the week changes.
const late = league(502, 16);

test('no betting line is loaded, so the old path really does answer week 1', () => {
  // Pinning the premise rather than assuming it: without this, every assertion
  // below could pass for the wrong reason — each would be comparing the league's
  // week against a betting-table week that happened to agree.
  assert.equal(rows(`SELECT season FROM game_lines`).length, 0);
  // And the consequence, stated rather than left implied. The first version of
  // this test asserted only the empty table, which meant a defect injection
  // changing the no-league fallback from 1 to 7 left it green: it named a
  // behaviour ("would answer week 1") that it did not check.
  assert.equal(tradeWeekContext().week, 1);
  assert.notEqual(LEAGUE_WEEK, 1, 'and the league week must differ from it, or nothing below separates the two');
});

test('the waiver list is priced for the league\'s week', () => {
  assert.equal(waiverUpgrades(501, { myTeamId: '1' }).week, LEAGUE_WEEK);
});

test('sell-high is priced for the league\'s week', () => {
  assert.equal(sellHigh(501, { myTeamId: '1' }).week, LEAGUE_WEEK);
});

test('the waiver board is priced for the league\'s week', () => {
  assert.equal(waiverBoard(main, { myTeamId: '1' }).week, LEAGUE_WEEK);
});

test('bye risk counts from the league\'s week, not from week 1', () => {
  // The one with a visible wrong answer: counting "remaining" bye weeks from
  // week 1 in October returns weeks that have already been played.
  assert.equal(byeOutlook(501, { myTeamId: '1' }).from_week, LEAGUE_WEEK);
});

test('bye patches inherit the same week', () => {
  assert.equal(byePatches(501, { myTeamId: '1' }).from_week, LEAGUE_WEEK);
});

test('the free-agent pool itself is priced on the league\'s week', () => {
  // freeAgents does not print a week; the week reaches it through
  // playoffWeight, which is what horizon_value is built on. Two leagues that
  // differ only in their week must therefore price the same player differently,
  // and before this change they could not: both read the same empty table.
  const early = freeAgents(main, { limit: 50 }).find(p => p.id === spare.id);
  const later = freeAgents(late, { limit: 50 }).find(p => p.id === spare.id);
  assert.ok(early && later, 'the same player is in both pools');
  assert.notEqual(early.horizon_value, later.horizon_value,
    'a week-9 pool and a week-16 pool are not the same pool');
});
