import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Props audit finding: `sampleTeamWeekEvents` drew a team's weekly pass
// attempts and rush carries from a negative binomial with a hardcoded
// dispersion of 12 for both, never fit against a team's own real week-to-week
// volume. Method-of-moments against `player_week_usage` (the same real data
// projections.js's per-player dispersion fit already uses, just summed to
// team-week totals; see scripts/fit-team-volume-dispersion.mjs) puts the real
// value at ~47 for attempts and ~31 for carries — k=12 was injecting roughly
// 2.2x / 1.7x too much week-to-week noise into simulated team volume, which
// `projectWeek` turns directly into prop percentiles and probabilities.
//
// This file checks the fix at two levels: the raw math (a k=12 draw really
// does produce ~2x the variance the real team-season data shows, and the
// corrected constants land close to it), and the wiring (sampleTeamWeekEvents
// now uses the fitted constants, verified by its emitted variance).

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-props-dispersion-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { randNegBinomial, withRandomSeed } = await import('../server/services/stats-util.js');
const { sampleTeamWeekEvents } = await import('../server/services/player-week-engine.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function sampleVariance(values) {
  const mean = values.reduce((s, x) => s + x, 0) / values.length;
  return values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length;
}

test('the old hardcoded dispersion (12) overstates real team-week attempt/carry variance by ~2x', () => {
  // Real pooled figures from scripts/fit-team-volume-dispersion.mjs against
  // player_week_usage: mean~33.5 attempts with real variance~57.1, mean~27.0
  // carries with real variance~50.4.
  const attMean = 33.5, realAttVar = 57.1;
  const carMean = 27.0, realCarVar = 50.4;
  const oldAttVar = attMean + attMean ** 2 / 12;
  const oldCarVar = carMean + carMean ** 2 / 12;
  assert.ok(oldAttVar / realAttVar > 2.0,
    `k=12 attempts variance ${oldAttVar.toFixed(1)} should be >2x real ${realAttVar}`);
  assert.ok(oldCarVar / realCarVar > 1.6,
    `k=12 carries variance ${oldCarVar.toFixed(1)} should be >1.6x real ${realCarVar}`);

  // The fitted replacements land close to the real variance at the same mean.
  const newAttVar = attMean + attMean ** 2 / 47;
  const newCarVar = carMean + carMean ** 2 / 31;
  assert.ok(Math.abs(newAttVar / realAttVar - 1) < 0.15,
    `fitted attempts variance ${newAttVar.toFixed(1)} should be within 15% of real ${realAttVar}`);
  assert.ok(Math.abs(newCarVar / realCarVar - 1) < 0.15,
    `fitted carries variance ${newCarVar.toFixed(1)} should be within 15% of real ${realCarVar}`);
});

test('randNegBinomial reproduces the target dispersion at realistic NFL team means', () => {
  // Direct check on the primitive used by sampleTeamWeekEvents: draw many
  // samples at k=47 (attempts) and k=31 (carries) and confirm the empirical
  // variance matches the negative-binomial formula mean + mean^2/k, not the
  // old k=12 shape.
  const mean_ = 33.5, k = 47;
  const draws = withRandomSeed(2026, () => Array.from({ length: 40000 }, () => randNegBinomial(mean_, k)));
  const empirical = sampleVariance(draws);
  const expected = mean_ + mean_ ** 2 / k;
  const oldShapeExpected = mean_ + mean_ ** 2 / 12;
  assert.ok(Math.abs(empirical / expected - 1) < 0.08,
    `empirical variance ${empirical.toFixed(1)} should track k=${k}'s expected ${expected.toFixed(1)}`);
  assert.ok(empirical < oldShapeExpected * 0.7,
    `k=${k} draws (${empirical.toFixed(1)}) should be well below the old k=12 shape (${oldShapeExpected.toFixed(1)})`);
});

test('sampleTeamWeekEvents now draws team attempts/carries at the fitted dispersion, not the old k=12', () => {
  const params = overrides => ({
    attempts: 0, carries: 0, targets: 0, dispersion: 10,
    ypa: 7, pass_td_rate: 0.045, int_rate: 0.025,
    ypc: 4.2, rush_td_rate: 0.03, catch_rate: 0.68,
    ypt: 8, rec_td_rate: 0.05, ...overrides
  });
  // team_pass_att / team_rush_att match the real pooled means used above so
  // the simulated variance is directly comparable to the real-data figures.
  const shared = { team: 'TST', volume: { team_pass_att: 33.5, team_rush_att: 27.0 } };
  const engine = new Map([
    [1, { ...shared, player_id: 1, position: 'QB', params: params({ attempts: 32, carries: 4 }) }],
    [2, { ...shared, player_id: 2, position: 'RB', params: params({ carries: 18, targets: 4 }) }],
    [3, { ...shared, player_id: 3, position: 'RB', params: params({ carries: 6, targets: 2 }) }],
    [4, { ...shared, player_id: 4, position: 'WR', params: params({ targets: 9 }) }],
    [5, { ...shared, player_id: 5, position: 'WR', params: params({ targets: 7 }) }]
  ]);
  const samples = sampleTeamWeekEvents(engine, 'TST', { runs: 6000, seed: 4271 });
  const runs = samples.get(1).length;
  const teamAttempts = [], teamCarries = [];
  for (let i = 0; i < runs; i++) {
    let att = 0, car = 0;
    for (const arr of samples.values()) { att += arr[i].attempts; car += arr[i].carries; }
    teamAttempts.push(att); teamCarries.push(car);
  }
  const attVar = sampleVariance(teamAttempts), carVar = sampleVariance(teamCarries);
  const attMean = 33.5, carMean = 27.0;
  const oldAttVar = attMean + attMean ** 2 / 12, oldCarVar = carMean + carMean ** 2 / 12;
  const newAttVar = attMean + attMean ** 2 / 47, newCarVar = carMean + carMean ** 2 / 31;

  // The simulated variance must sit near the fitted expectation, and must NOT
  // sit near the old k=12 expectation the pre-fix code would have produced.
  assert.ok(Math.abs(attVar / newAttVar - 1) < 0.2,
    `simulated attempts variance ${attVar.toFixed(1)} should track the fitted k=47 expectation ${newAttVar.toFixed(1)}`);
  assert.ok(Math.abs(carVar / newCarVar - 1) < 0.2,
    `simulated carries variance ${carVar.toFixed(1)} should track the fitted k=31 expectation ${newCarVar.toFixed(1)}`);
  assert.ok(attVar < oldAttVar * 0.75,
    `simulated attempts variance ${attVar.toFixed(1)} should be well below the old k=12 shape ${oldAttVar.toFixed(1)}`);
  assert.ok(carVar < oldCarVar * 0.85,
    `simulated carries variance ${carVar.toFixed(1)} should be well below the old k=12 shape ${oldCarVar.toFixed(1)}`);
});
