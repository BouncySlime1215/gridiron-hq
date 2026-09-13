/**
 * Coverage for `bottom-up-team-total.js`'s two load-bearing pieces:
 *
 *  - `fitTeamTotalCalibration` / `positionAverageEfficiency` /
 *    `positionStatSigma` actually recover the right numbers from real-shaped
 *    rows (synthetic here, seeded with a known relationship) rather than
 *    silently returning something plausible-looking but wrong.
 *  - `teamBottomUpScenarios`' usage-vs-efficiency ablation — the "honest
 *    caution" check the giant-plan instructions asked for by name — actually
 *    isolates what it claims to. This is exercised against a hand-built
 *    `engine` Map, not `buildPlayerWeekEngine`: every field it reads is
 *    documented in player-week-engine.js's own `teamProjectionSet`, and
 *    omitting `player_week_engine` on each fake player deliberately routes
 *    around every roster/depth-chart DB lookup (they all early-return on a
 *    non-integer season/week) so this test exercises pure aggregation math,
 *    not the shared production roster-resolution path (which real games
 *    already exercise in scripts/audit-bottom-up-team-total.mjs).
 *
 * The real walk-forward validation against actual historical games and
 * final scores lives in scripts/_bottom-up-team-total-worker.mjs and
 * PROPS_TO_SPREAD_REPORT.md — this file is a regression guard on the
 * arithmetic underneath that validation, not a substitute for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-bottom-up-team-total-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { run } = await import('../server/db/index.js');
const {
  fitTeamTotalCalibration, positionAverageEfficiency, positionStatSigma,
  teamBottomUpScenarios, teamBottomUpDistribution
} = await import('../server/services/bottom-up-team-total.js');

/* -------------------------------------------------- calibration fixtures */

// A known linear relationship, seeded with zero noise: points = 5 + 0.02*yards
// + 4*tds exactly. If the OLS fit does not recover these to a tight tolerance,
// the two-predictor normal-equations solver (or the query building the
// team-week aggregates) has a real bug.
function seedTeamWeek(season, week, team, passYards, rushYards, tds) {
  const qb = run(`INSERT INTO players (name, position, team_id) VALUES (?, 'QB', NULL)`, `${team}-QB-${season}-${week}`);
  run(`INSERT INTO player_week_usage (player_id, season, week, team, position, passing_yards, rushing_yards, rushing_tds, receiving_tds)
       VALUES (?, ?, ?, ?, 'QB', ?, 0, 0, 0)`, qb.lastInsertRowid, season, week, team, passYards);
  run(`INSERT INTO game_lines (season, week, team, opponent, home, team_score)
       VALUES (?, ?, ?, 'OPP', 1, ?)`, season, week, team, 5 + 0.02 * (passYards + rushYards) + 4 * tds);
  // rushing_yards/tds folded into a second synthetic row so the team-week
  // GROUP BY sums both without the QB's own row double-carrying them.
  const rb = run(`INSERT INTO players (name, position, team_id) VALUES (?, 'RB', NULL)`, `${team}-RB-${season}-${week}`);
  run(`INSERT INTO player_week_usage (player_id, season, week, team, position, passing_yards, rushing_yards, rushing_tds, receiving_tds)
       VALUES (?, ?, ?, ?, 'RB', 0, ?, ?, 0)`, rb.lastInsertRowid, season, week, team, rushYards, tds);
}

test('fitTeamTotalCalibration recovers a known noiseless yards+TD -> points relationship', () => {
  let n = 0;
  for (let season = 2015; season <= 2020; season++) {
    for (let week = 1; week <= 12; week++) {
      const yards = 250 + (n % 17) * 11;
      const tds = n % 4;
      seedTeamWeek(season, week, `T${n % 8}`, yards * 0.6, yards * 0.4, tds);
      n++;
    }
  }
  const cal = fitTeamTotalCalibration({ maxSeason: 2020 });
  assert.equal(cal.error, undefined, cal.error);
  assert.ok(cal.n >= 30, `expected enough fitted rows, got ${cal.n}`);
  assert.ok(Math.abs(cal.intercept - 5) < 0.5, `intercept ${cal.intercept} should be near 5`);
  assert.ok(Math.abs(cal.yards_coef - 0.02) < 0.005, `yards_coef ${cal.yards_coef} should be near 0.02`);
  assert.ok(Math.abs(cal.td_coef - 4) < 0.5, `td_coef ${cal.td_coef} should be near 4`);
  assert.ok(cal.r2 > 0.95, `r2 ${cal.r2} should be near-perfect on noiseless synthetic data`);
});

test('positionAverageEfficiency and positionStatSigma aggregate without dividing by zero on a position with no rows', () => {
  const avg = positionAverageEfficiency({ maxSeason: 2020 });
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    assert.ok(Number.isFinite(avg[pos].ypa), `${pos}.ypa should be finite`);
    assert.ok(Number.isFinite(avg[pos].ypc), `${pos}.ypc should be finite`);
  }
  const sigmas = positionStatSigma({ maxSeason: 2020 });
  assert.ok(Number.isFinite(sigmas.passing_yards));
  assert.ok(Number.isFinite(sigmas.rushing_yards.TE)); // TE has no seeded rows -> falls back to its fixed default
});

/* ---------------------------------------------- usage-vs-efficiency ablation */

// Hand-built engine entries mirror exactly what teamProjectionSet reads
// (see player-week-engine.js): `.params` for the football-event math,
// `.volume.team_pass_att` / `team_rush_att` for team pace. Deliberately no
// `player_week_engine` field, so every roster/depth-chart lookup this
// production code path can make (activeDepthRoster, recentPrimaryQb,
// historicalPrimaryQbShare) either short-circuits on a non-integer
// season/week or degrades to its documented DB-empty prior — never a crash.
function fakePlayer({ id, team, position, attempts = 0, carries = 0, targets = 0,
  ypa = 0, ypc = 0, ypt = 0, catch_rate = 0, pass_td_rate = 0, rush_td_rate = 0,
  rec_td_rate = 0, int_rate = 0, team_pass_att = 32, team_rush_att = 25 }) {
  return {
    player_id: id, name: `P${id}`, team, position, expected_games: 1,
    volume: { team_pass_att, team_rush_att },
    params: { position, attempts, carries, targets, dispersion: 12,
      ypa, ypc, ypt, catch_rate, pass_td_rate, rush_td_rate, rec_td_rate, int_rate }
  };
}

test('usage_nulled leaves the team total unchanged when two rushers already share carries and efficiency equally', () => {
  const engine = new Map([
    ['rb1', fakePlayer({ id: 'rb1', team: 'ZZ', position: 'RB', carries: 10, ypc: 4.5, rush_td_rate: 0.05 })],
    ['rb2', fakePlayer({ id: 'rb2', team: 'ZZ', position: 'RB', carries: 10, ypc: 4.5, rush_td_rate: 0.05 })]
  ]);
  const calibration = { intercept: 0, yards_coef: 0.02, td_coef: 4 };
  const scenarios = teamBottomUpScenarios(engine, 'ZZ', { calibration, leagueAvg: { RB: {}, QB: {}, WR: {}, TE: {} } });
  assert.equal(scenarios.participants, 2);
  // Already-equal shares -> redistributing evenly changes nothing.
  assert.ok(Math.abs(scenarios.usage_nulled.points - scenarios.full.points) < 1e-9,
    `usage_nulled ${scenarios.usage_nulled.points} should equal full ${scenarios.full.points} when shares were already equal`);
});

test('usage_nulled moves the team total when carries are concentrated on the more efficient back', () => {
  const engine = new Map([
    ['star', fakePlayer({ id: 'star', team: 'ZZ', position: 'RB', carries: 18, ypc: 6, rush_td_rate: 0.08 })],
    ['backup', fakePlayer({ id: 'backup', team: 'ZZ', position: 'RB', carries: 2, ypc: 3, rush_td_rate: 0.01 })]
  ]);
  const calibration = { intercept: 0, yards_coef: 0.02, td_coef: 4 };
  const scenarios = teamBottomUpScenarios(engine, 'ZZ', { calibration, leagueAvg: { RB: {}, QB: {}, WR: {}, TE: {} } });
  // Splitting the same 20 carries evenly between an efficient and an
  // inefficient back, instead of concentrating them on the efficient one,
  // must LOWER the team total.
  assert.ok(scenarios.usage_nulled.points < scenarios.full.points,
    `usage_nulled (${scenarios.usage_nulled.points}) should be below full (${scenarios.full.points}) when usage was concentrated on the better back`);
});

test('efficiency_nulled moves the team total toward the league-average rate, away from an above-average player\'s own rate', () => {
  const engine = new Map([
    ['ace', fakePlayer({ id: 'ace', team: 'ZZ', position: 'RB', carries: 15, ypc: 8, rush_td_rate: 0.1 })]
  ]);
  const leagueAvg = { RB: { ypc: 4, rush_td_rate: 0.03, ypa: 0, pass_td_rate: 0, int_rate: 0, ypt: 0, catch_rate: 0, rec_td_rate: 0 },
    QB: {}, WR: {}, TE: {} };
  const calibration = { intercept: 0, yards_coef: 0.02, td_coef: 4 };
  const scenarios = teamBottomUpScenarios(engine, 'ZZ', { calibration, leagueAvg });
  assert.ok(scenarios.efficiency_nulled.points < scenarios.full.points,
    'replacing an above-average rusher\'s own rate with the league average should lower the team total');
  // usage_nulled with a single player has nothing to redistribute -> unchanged.
  assert.ok(Math.abs(scenarios.usage_nulled.points - scenarios.full.points) < 1e-9);
});

/* --------------------------------------------------- correlated Monte Carlo */

// Regression guard for a real bug this module's own consistency check caught
// (see PROPS_TO_SPREAD_REPORT.md): `Math.max(0, mean + sigma*Z)` systematically
// INFLATES the average whenever a leg's mean sits close to its sigma — exactly
// the case for a moderate-volume rusher (mean well above zero, but not many
// sigmas above it) or any small-mean TD-count leg. `carries: 10, ypc: 3` below
// is deliberately in that danger zone (mean rushYd = 30, RB sigma ~34 in real
// data) rather than a comfortably-large mean that would hide the bug.
test('teamBottomUpDistribution\'s Monte Carlo mean matches the deterministic full points, even for a moderate-volume leg near its own sigma', () => {
  const engine = new Map([
    ['qb1', fakePlayer({ id: 'qb1', team: 'ZZ', position: 'QB', attempts: 32, ypa: 7, pass_td_rate: 0.04 })],
    ['rb1', fakePlayer({ id: 'rb1', team: 'ZZ', position: 'RB', carries: 10, ypc: 3, rush_td_rate: 0.03 })],
    ['wr1', fakePlayer({ id: 'wr1', team: 'ZZ', position: 'WR', targets: 6, ypt: 8, catch_rate: 0.6, rec_td_rate: 0.05 })]
  ]);
  const calibration = { intercept: 5, yards_coef: 0.0115, td_coef: 5.4 };
  const scenarios = teamBottomUpScenarios(engine, 'ZZ', { calibration, leagueAvg: { RB: {}, QB: {}, WR: {}, TE: {} } });
  const sigmas = { passing_yards: 71.6, rushing_yards: { QB: 25, RB: 34, WR: 12, TE: 5 } };
  const dist = teamBottomUpDistribution(engine, 'ZZ', { calibration, sigmas, trials: 20000, seed: 42 });
  assert.ok(dist, 'distribution should not be null with real legs present');
  const gap = Math.abs(dist.mean_points - scenarios.full.points);
  assert.ok(gap < 0.5,
    `MC mean (${dist.mean_points}) should match the deterministic full total (${scenarios.full.points}) within Monte Carlo noise, got gap ${gap.toFixed(3)}`);
});
