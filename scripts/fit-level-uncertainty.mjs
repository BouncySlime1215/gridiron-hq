#!/usr/bin/env node
/**
 * Build Order 1.2 — fit the level-uncertainty parameters so the 80% interval
 * actually covers 80%.
 *
 * The defect: seasonDistribution modelled a player's true-level uncertainty as
 * `1.15/sqrt(evidence)` clamped to [0.30, 0.70] — pure estimation error that
 * shrinks away as you observe more of a player. Measured against held-out
 * seasons that is wrong in two ways at once:
 *
 *   1. Too small. The residual spread of log(actual/predicted) is ~0.89 and
 *      does NOT shrink with evidence (measured 0.883 / 0.870 / 0.914 over the
 *      2023 / 2024 / 2025 holdouts — no trend). Most of that variance is real
 *      year-over-year change in the player, not uncertainty about a fixed
 *      truth, so more history cannot make it go away.
 *   2. Skewed the wrong way. A plain log-normal puts its fat tail on the
 *      upside; the data is consistently NEGATIVELY skewed (-0.97/-1.04/-1.36),
 *      because a lost role collapses further than a breakout climbs.
 *
 * Fitting protocol — walk-forward, never fit and report on the same season:
 *   fit on the earlier holdout(s), then report the LAST holdout as validation.
 * Scored on distance-to-target coverage plus PIT flatness, so a parameter set
 * cannot win by inflating the interval until it swallows everything (that
 * would hit 0.80 coverage with a badly non-flat PIT).
 *
 * Usage: node scripts/fit-level-uncertainty.mjs
 */
import { buildProjections, seasonDistribution } from '../server/services/projections.js';
import { actuals, gradeDistribution } from '../server/services/backtest.js';
import { withRandomSeed } from '../server/services/stats-util.js';

const TARGET = 0.80;
const GATE = [0.78, 0.82];
const SEED = 20260826;
const RUNS = 300;

const FIT_SEASONS = [2023, 2024];   // trained through 2022 / 2023
const VALIDATION_SEASON = 2025;     // trained through 2024 — the frozen-baseline holdout

/** Projection + truth for one holdout season, built once and reused across the sweep. */
function context(testSeason) {
  const through = testSeason - 1;
  const proj = buildProjections({ through, kOverride: null });
  const truth = actuals(testSeason);
  const prior = actuals(testSeason - 1);
  const ids = [...proj.keys()].filter(id => truth.get(id)?.games >= 4 && prior.has(id));
  return { testSeason, proj, truth: new Map(ids.map(id => [id, truth.get(id)])), ids };
}

/** Coverage + PIT flatness for one parameter set on one season. */
function evaluate(ctx, level) {
  const samples = new Map();
  withRandomSeed(SEED, () => {
    for (const id of ctx.ids) samples.set(id, seasonDistribution(ctx.proj.get(id), { runs: RUNS, level }).samples);
  });
  const g = gradeDistribution(samples, ctx.truth);
  return { coverage: g.coverage_80, calibration_error: g.calibration_error, crps: g.crps, pit: g.pit_histogram };
}

/**
 * Lower is better. Coverage error dominates (it is the gate); PIT flatness is
 * the tie-breaker that stops a too-wide interval from scoring well.
 */
const score = r => Math.abs(r.coverage - TARGET) * 10 + r.calibration_error;

console.log('Building projections for each holdout season...');
const fitCtx = FIT_SEASONS.map(context);
const valCtx = context(VALIDATION_SEASON);

// Grid over the floor `a` (the irreducible year-over-year spread), a small
// evidence-decaying term `b`, and the downside widener.
const grid = [];
for (const a of [0.30, 0.40, 0.50, 0.60, 0.70]) {
  for (const b of [0, 0.3, 0.6]) {
    for (const downMult of [1.0, 1.3, 1.6, 2.0]) {
      grid.push({ a, b, lo: 0.20, hi: 1.60, downMult, conc: 3.5 });
    }
  }
}
console.log(`Sweeping ${grid.length} parameter sets over ${FIT_SEASONS.length} fit season(s)...\n`);

const results = [];
for (const level of grid) {
  const per = fitCtx.map(ctx => evaluate(ctx, level));
  const meanCoverage = per.reduce((s, r) => s + r.coverage, 0) / per.length;
  const meanCal = per.reduce((s, r) => s + r.calibration_error, 0) / per.length;
  const agg = { coverage: meanCoverage, calibration_error: meanCal };
  results.push({ level, per, meanCoverage, meanCal, score: score(agg) });
}
results.sort((x, y) => x.score - y.score);

console.log('Top 10 parameter sets on the FIT seasons:');
console.log('   a     b    down |  cov(fit)  calib |  ' + FIT_SEASONS.map(s => `cov${s}`).join('  '));
for (const r of results.slice(0, 10)) {
  console.log(`  ${r.level.a.toFixed(2)}  ${r.level.b.toFixed(2)}  ${r.level.downMult.toFixed(2)} | ` +
    `  ${r.meanCoverage.toFixed(3)}   ${r.meanCal.toFixed(3)} |  ` +
    r.per.map(p => p.coverage.toFixed(3)).join('   '));
}

const best = results[0];
console.log('\nBest on fit seasons:', best.level);

console.log(`\n=== VALIDATION on ${VALIDATION_SEASON} (never used to fit) ===`);
const baseline = evaluate(valCtx, { a: 0, b: 1.15, lo: 0.30, hi: 0.70, downMult: 1, conc: 3.5 });
const fitted = evaluate(valCtx, best.level);
console.log('  current (shipped) params :', 'coverage', baseline.coverage, ' calib', baseline.calibration_error, ' crps', baseline.crps);
console.log('  fitted params            :', 'coverage', fitted.coverage, ' calib', fitted.calibration_error, ' crps', fitted.crps);
console.log('  PIT current:', baseline.pit);
console.log('  PIT fitted :', fitted.pit);

const pass = fitted.coverage >= GATE[0] && fitted.coverage <= GATE[1];
console.log(`\nGate (validation coverage in [${GATE[0]}, ${GATE[1]}]): ${pass ? 'PASS' : 'FAIL'} (${fitted.coverage})`);
console.log(pass
  ? `\nAdopt by setting LEVEL_UNCERTAINTY in projections.js to:\n  ${JSON.stringify(best.level)}`
  : '\nDo NOT adopt — the fitted parameters did not hold up out of sample.');
