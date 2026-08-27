#!/usr/bin/env node
/**
 * Build Order 1.1 — fit k* = sigma^2_within / sigma^2_between per metric per
 * position (see server/services/shrinkage-fit.js for the estimator), then
 * grade the fitted vector against the hardcoded K constants on identical
 * held-out data before ever adopting it.
 *
 * The rule, stated in the Build Order and enforced here rather than just
 * described: "fitted k beats hardcoded k on held-out CRPS. If it doesn't,
 * keep the constants — we've learned they were fine, which is currently
 * unknown either way." A single CRPS number on a few hundred players can
 * easily differ by sampling luck alone, so "beats" is decided by a paired
 * bootstrap over players (backtest-significance.js), not by which point
 * estimate happens to be lower — a nominal win that's within noise is treated
 * the same as a loss: keep the constants, because "we don't know" is the
 * honest read, not "the fit worked."
 *
 * Usage: node scripts/fit-shrinkage.mjs [throughSeason] [testSeason]
 *   defaults: throughSeason = testSeason - 1, testSeason = current SEASON - 1
 *   (i.e. the same 2024-train / 2025-test split the frozen baseline uses)
 */
import { buildProjections, seasonDistribution } from '../server/services/projections.js';
import { actuals, gradePoint, gradeDistribution } from '../server/services/backtest.js';
import { withRandomSeed } from '../server/services/stats-util.js';
import { fitAllK, saveFit, activateFit } from '../server/services/shrinkage-fit.js';
import { pairedBootstrapDiff, alignedAbsErrors, alignedCrps } from '../server/services/backtest-significance.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const testSeason = Number(process.argv[3]) || SEASON - 1;
const through = Number(process.argv[2]) || testSeason - 1;
const SEED = 20260826;

console.log(`Fitting shrinkage constants on data through ${through}, testing on ${testSeason}...`);

const fitted = fitAllK(through);
console.table(fitted.map(r => ({
  metric: r.metric, position: r.position,
  k: r.k == null ? null : (r.k === Infinity ? 'Inf' : r.k.toFixed(2)),
  n_groups: r.n_groups, n_obs: r.n_obs
})));

const kVector = {};
for (const r of fitted) { if (r.k != null) (kVector[r.metric] ??= {})[r.position] = r.k; }

/**
 * Grades one k-vector (or null for hardcoded) against season truth, mirroring
 * /api/model/accuracy's construction exactly, EXCEPT the distributional grade
 * runs on every eligible player rather than the first 150 — that slice was
 * fine for a quick live-page number but adds avoidable sampling noise to a
 * gate decision.
 */
function gradeFull(kOverride, seed) {
  const proj = buildProjections({ through, kOverride });
  const truth = actuals(testSeason);
  const prior = actuals(testSeason - 1);
  const ids = [...proj.keys()].filter(id => truth.get(id)?.games >= 4 && prior.has(id));
  const t = new Map(ids.map(id => [id, truth.get(id)]));
  const preds = new Map(ids.map(id => [id, proj.get(id).points]));
  const point = gradePoint(preds, t);

  const samples = new Map();
  withRandomSeed(seed, () => {
    for (const id of ids) samples.set(id, seasonDistribution(proj.get(id), { runs: 300 }).samples);
  });
  const dist = gradeDistribution(samples, t);
  return { ids, truth: t, preds, samples,
    n: ids.length, mae: point.mae, spearman: point.spearman, r2: point.r2,
    crps: dist.crps, coverage_80: dist.coverage_80, calibration_error: dist.calibration_error };
}

console.log('\nGrading on the full eligible player set (this takes a bit — full Monte Carlo per player, both models)...');
const hardcoded = gradeFull(null, SEED);
const withFit = gradeFull(kVector, SEED);

const summary = r => ({ n: r.n, mae: r.mae, spearman: r.spearman, r2: r.r2,
  crps: r.crps, coverage_80: r.coverage_80, calibration_error: r.calibration_error });
console.log('\nHardcoded K:', summary(hardcoded));
console.log('Fitted k*:  ', summary(withFit));

// Noise vs. real: bootstrap both metrics over which players ended up in the
// test set. `b` is the fitted model in both calls (mean_diff = fitted - hardcoded).
const { errA: maeHard, errB: maeFit } = alignedAbsErrors(hardcoded.preds, withFit.preds, hardcoded.truth);
const maeTest = pairedBootstrapDiff(maeHard, maeFit, { seed: SEED });

const { crpsA: crpsHard, crpsB: crpsFit } = alignedCrps(hardcoded.samples, withFit.samples, hardcoded.truth);
const crpsTest = pairedBootstrapDiff(crpsHard, crpsFit, { seed: SEED });

console.log('\nPaired bootstrap (fitted - hardcoded, 2000 resamples over players, 90% CI):');
console.log('  MAE  delta:', maeTest.mean_diff, 'CI', maeTest.ci90,
  maeTest.significant ? '— SIGNIFICANT' : '— not distinguishable from noise');
console.log('  CRPS delta:', crpsTest.mean_diff, 'CI', crpsTest.ci90,
  crpsTest.significant ? '— SIGNIFICANT' : '— not distinguishable from noise');

// Adopt only on a real, negative (fitted lower = better) CRPS delta. A
// nominal improvement that isn't significant is treated as "we don't know,"
// which the Build Order's own rule resolves to keeping the constants.
const beatsCrps = crpsTest.significant && crpsTest.mean_diff < 0;
console.log(`\nGate (fitted CRPS significantly < hardcoded CRPS): ${beatsCrps ? 'PASS' : 'FAIL'}`);

const fitId = saveFit({
  through, testSeason,
  crpsFitted: withFit.crps, crpsHardcoded: hardcoded.crps,
  maeFitted: withFit.mae, maeHardcoded: hardcoded.mae,
  kVector: fitted,
  note: beatsCrps
    ? `beat hardcoded on held-out CRPS (bootstrap-significant, delta=${crpsTest.mean_diff}); activated`
    : `did not significantly beat hardcoded (CRPS delta=${crpsTest.mean_diff}, CI ${crpsTest.ci90}); kept constants`
});

if (beatsCrps) {
  activateFit(fitId);
  console.log(`\nFit #${fitId} activated — buildProjections() now uses the fitted vector by default.`);
} else {
  console.log(`\nFit #${fitId} recorded but NOT activated — hardcoded constants remain in effect.`);
}
