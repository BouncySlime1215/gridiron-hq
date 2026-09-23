/**
 * RL-5-3: buildAssetUniverse() must zero a bye-week starter's weekly range.
 *
 * trade-engine.js already treats `thisGame` (his team's game in the target week) as the
 * bye detector for `current_week_ppg` (:359, `thisGame ? currentWeekBasePpg * ... : 0`).
 * `weekDist` (:399-401, the p10/p90/mean this asset's floor/ceiling/avg come from, :437)
 * carries no such branch: it is built straight from `weekProjection`, which comes from
 * the structural/ensemble engine and knows nothing about the schedule. A player with no
 * game this week still gets a full Monte-Carlo distribution, so `floor`/`ceiling`/`avg`
 * on that asset are positive in a week he cannot score.
 *
 * See rnd/loop/r5-internal-weekly-range-counts-bye-players.md section 2: 59 of 61 W6-bye
 * assets with a `ros_ppg` had `ceiling > 0` while `current_week_ppg = 0` (Joe Burrow:
 * 0 / 0 / 26.8 / 10.95 week-points / floor / ceiling / avg).
 *
 * player-week-engine.js is mocked here: the real structural/ensemble build needs a full
 * gamelog and weekly-fit history neither this defect nor its fix touches, and the bug is
 * entirely in how trade-engine.js *uses* a projection once it has one, not in how the
 * projection itself is built. matchups.js (the bye detector, via schedule_games) is real.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-asset-bye-range-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '6';

// A fixed, made-up projection for 901 and 902 — deliberately identical, so a
// difference in the served floor/ceiling/avg can only come from the bye branch, never
// from the underlying model. Real player-week-engine.js knows nothing about byes; this
// mock reproduces that honestly (same shape for the bye player as the healthy one) so
// the test cannot pass just because the mock "knows" who is on bye.
// `params` is a real WR params shape (copied from test/lineup-spread.test.js), not a
// placeholder: lineupSpread() samples it through the real projections.js#sampleWeeks,
// and a shape it cannot read samples to 0 for EVERY player, which would hide whether
// the bye branch on WEEK_MARGINAL.activeProbability does anything (skeptic, RL-5-3).
const wrParams = targets => ({
  position: 'WR', attempts: 0, carries: 0, targets, dispersion: 10,
  ypa: 7, pass_td_rate: 0.045, int_rate: 0.025, ypc: 4.2, rush_td_rate: 0.03,
  catch_rate: 0.68, ypt: 8, rec_td_rate: 0.05
});
const WEEK_PROJECTION = { ppg: 20, params: wrParams(8), ensemble_shift: 0, volume: { target_share: 0.2 } };
// For the lineup tests: 903 is a bye-team star whose SEASON rate beats everyone (so
// a season-rate solve starts him), 904 a low-volume WR on the team that plays.
const STAR_PROJECTION = { ppg: 30, params: wrParams(10), ensemble_shift: 0, volume: { target_share: 0.25 } };
const DEPTH_PROJECTION = { ppg: 4, params: wrParams(2), ensemble_shift: 0, volume: { target_share: 0.05 } };
const WEEK_DIST = { p10: 8, p90: 32, mean: 20, boom_rate: 0.22, bust_rate: 0.11 };
let weekEngineCalls = 0;
const realWeekEngine = await import('../server/services/player-week-engine.js');
mock.module('../server/services/player-week-engine.js', {
  namedExports: {
    ...realWeekEngine,
    buildPlayerWeekEngine: () => {
      weekEngineCalls++;
      return new Map([[901, { ...WEEK_PROJECTION }], [902, { ...WEEK_PROJECTION }],
        [903, { ...STAR_PROJECTION }], [904, { ...DEPTH_PROJECTION }]]);
    },
    playerWeekDistribution: () => ({ ...WEEK_DIST })
  }
});

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { assetUniverse, lineupSpread, selfScout, evaluate } = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* --------------------------------------------------------------- fixture: 2 teams */

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (1, 'AAA', 'Alpha', 'AFC', 'East'), (2, 'BBB', 'Beta', 'NFC', 'West')`);

// AAA plays every week except week 6 (its bye); BBB has a game every week 1-14,
// including week 6. Both rows exist for weeks the other side of the bye so
// scheduleOutlook (matchups.js) sees a real slate, not "no games at all".
for (let w = 1; w <= 14; w++) {
  if (w !== 6) run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home)
                     VALUES (2026, 1, ?, 'BBB', 1)`, w);
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home)
       VALUES (2026, 2, ?, 'AAA', 0)`, w);
}

// 901 is on the bye team (AAA), 902 on the team that plays week 6 (BBB). Same
// position, same mocked projection — the only real difference between them.
run(`INSERT INTO players (id, name, position, team_id) VALUES (901, 'Bye Guy', 'WR', 1)`);
run(`INSERT INTO players (id, name, position, team_id) VALUES (902, 'Plays Guy', 'WR', 2)`);
run(`INSERT INTO players (id, name, position, team_id) VALUES (903, 'Bye Star', 'WR', 1)`);
run(`INSERT INTO players (id, name, position, team_id) VALUES (904, 'Depth Guy', 'WR', 2)`);

const lg = () => ({ id: 1, team_count: 10, ppr: 1, best_ball: 0, league_type: null, payload: null });
const universe = () => assetUniverse(lg(), deriveFormat(lg()).formatKey);

test('control: the mocked engine actually ran (a 0/0 result here would prove nothing)', () => {
  const asset = universe().get(902);
  assert.ok(asset, 'the non-bye asset must exist in the universe');
  assert.ok(weekEngineCalls > 0, 'buildPlayerWeekEngine must have been called at least once');
});

test('control: a player whose team plays this week keeps a positive range', () => {
  const plays = universe().get(902);
  assert.equal(plays.current_week_ppg > 0, true, `expected a positive current_week_ppg, got ${plays.current_week_ppg}`);
  assert.equal(plays.floor, WEEK_DIST.p10);
  assert.equal(plays.ceiling, WEEK_DIST.p90);
  assert.equal(plays.avg, WEEK_DIST.mean);
});

test('RED: a bye-week starter\'s floor/ceiling/avg must be zero, not the full distribution', () => {
  const bye = universe().get(901);
  assert.equal(bye.current_week_ppg, 0, 'sanity: thisGame is already correctly null for a bye');
  assert.equal(bye.floor, 0, `bye-week floor must be 0, got ${bye.floor}`);
  assert.equal(bye.ceiling, 0, `bye-week ceiling must be 0, got ${bye.ceiling}`);
  assert.equal(bye.avg, 0, `bye-week avg must be 0, got ${bye.avg}`);
});

/* ------------------------------------------ the consumers: lineupSpread / selfScout / evaluate */

// MyTeam's 'Weekly range' and a trade card's floor_delta/ceiling_delta are lineupSpread()
// over a lineup. For a player with a weekly model it reads WEEK_MARGINAL, not the served
// floor/ceiling/avg above, so the fields test cannot see that path.
test('control + RED: lineupSpread() over a bye starter is 0; over a playing starter it is positive', () => {
  const u = universe();
  const plays = lineupSpread({ slots: [{ player: u.get(902) }] });
  assert.ok(plays.mean > 0 && plays.ceiling > 0,
    `control: a playing starter's lineup must have a positive mean/ceiling, got ${plays.mean}/${plays.ceiling}`);
  const bye = lineupSpread({ slots: [{ player: u.get(901) }] });
  assert.equal(bye.mean, 0, `bye lineup mean must be 0, got ${bye.mean}`);
  assert.equal(bye.ceiling, 0, `bye lineup ceiling must be 0, got ${bye.ceiling}`);
});

const espnEntry = (name, id) => ({ playerPoolEntry: { player: { id, fullName: name, defaultPositionId: 3 } } });
const oneWrLeague = () => ({
  id: 1, platform: 'espn', team_count: 2, ppr: 1, best_ball: 0, league_type: null, my_team_id: '1',
  roster_positions: JSON.stringify(['WR']),
  payload: JSON.stringify({ teams: [
    { id: 1, name: 'Mine', roster: { entries: [espnEntry('Bye Star', 70903), espnEntry('Depth Guy', 70904)] } },
    { id: 2, name: 'Rival', roster: { entries: [espnEntry('Plays Guy', 70902)] } }
  ] })
});

test('control: the bye star really does out-rate the depth WR on the season rate', () => {
  const u = universe();
  assert.equal(u.get(903).current_week_ppg, 0, 'sanity: 903 is on the bye team');
  assert.ok(u.get(904).current_week_ppg > 0, 'sanity: 904 plays this week');
  assert.ok(u.get(903).adj_ppg > u.get(904).adj_ppg,
    `fixture must make a season-rate solve start the bye star: ${u.get(903).adj_ppg} vs ${u.get(904).adj_ppg}`);
});

test('RED: selfScout must not start a bye-week player; he stays on the bench', () => {
  const scout = selfScout(oneWrLeague(), '1');
  const starter = scout.lineup.slots[0].player;
  assert.equal(starter?.name, 'Depth Guy', `the WR slot must go to the player who plays, got ${starter?.name}`);
  assert.ok(scout.lineup.bench.some(p => p.name === 'Bye Star'), 'the bye star must still be listed on the bench');
  assert.ok(scout.spread.mean > 0, `the weekly range must cover the player who plays, got mean ${scout.spread.mean}`);
  // The rank beside the range uses the same lineup: my lineup points are the depth WR's.
  const depth = universe().get(904).adj_ppg;
  assert.equal(scout.lineup.points, depth, `lineup points must be the playing starter's (${depth}), got ${scout.lineup.points}`);
});

test('RED: a trade that fills a bye hole this week gets weekly-range credit on the card', () => {
  const u = universe();
  const mine = { roster_id: '1', owner: 'Mine', players: [u.get(903), u.get(904)] };
  const theirs = { roster_id: '2', owner: 'Rival', players: [u.get(902)] };
  const res = evaluate({ team: mine, gives: [] }, { team: theirs, gives: [u.get(902)] }, ['WR']);
  const side = res.me;
  assert.ok(side.ceiling_delta > 0,
    `adding a WR who plays this week over a depth WR must raise my weekly ceiling, got ${side.ceiling_delta}`);
});
