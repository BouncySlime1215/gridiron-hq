#!/usr/bin/env node
/**
 * Build Order 1.2, measured week-by-week — make the 80% interval cover 80%.
 *
 * Fits the weekly parameter-uncertainty draw (see WEEKLY_LEVEL in
 * projections.js) on 2023 + 2024 and validates on 2025. Scored on distance to
 * the coverage target plus PIT flatness, so a setting cannot win by inflating
 * the interval until it swallows everything.
 *
 * Usage: node scripts/fit-weekly-coverage.mjs
 */
import { replaySeasonWeekly } from '../server/services/weekly-backtest.js';
import { activeKVector } from '../server/services/shrinkage-fit.js';
import { WEEKLY_ROLE_RECENCY, weeklyEnsemblePrediction } from '../server/services/weekly-ensemble.js';
import { activeWeeklyWeightSet } from '../server/services/weekly-weight-store.js';
import { WEEKLY_LEVEL } from '../server/services/projections.js';

/*
 * PRODUCTION CONFIGURATION, and it changes the answer. This script used to call
 * replaySeasonWeekly with no kOverride, no roleRecency and no predictionHead. That
 * is not what production runs: weekly-backtest defaults kOverride to null (which
 * projections.js reads as "suppress activeKVector()", since it only defaults on
 * `undefined`), leaves the role recency off, and — with no head — centres the
 * sampled distribution on the STRUCTURAL head with shift 0, while production
 * centres it on the ensemble. Measured on 2025 at sigma 0.45: as-fitted coverage
 * 0.795; production k + role recency on the structural head 0.765, OUTSIDE the
 * [0.78, 0.82] gate; production k + role recency + ensemble head 0.789. The
 * shipped combination happens to land back inside the gate, but the cited figure
 * was measured on a model the app does not run.
 *
 * The centring head is the champion legitimately available for each replayed
 * season — activeWeeklyWeightSet({ season, week: startWeek }) — so the fit stays
 * cutoff-clean and picks up future promoted fits automatically.
 */
const production = season => {
  const champion = activeWeeklyWeightSet({ season, week: 5 });
  return {
    kOverride: undefined /* cutoff-safe default: shrinkage-fit.js cutoffSafeKVector */, roleRecency: WEEKLY_ROLE_RECENCY,
    predictionHead: ctx => weeklyEnsemblePrediction(ctx, champion.weights),
  };
};

const FIT_SEASONS = [2023, 2024];
const VALIDATION_SEASON = 2025;
const TARGET = 0.80, GATE = [0.78, 0.82];
const RUNS = 300;

const grid = [];
for (const sigma of [0, 0.15, 0.25, 0.35, 0.45, 0.55, 0.70]) {
  for (const downMult of [1.0, 1.3, 1.6]) {
    if (sigma === 0 && downMult !== 1.0) continue;      // downMult is inert at sigma 0
    grid.push({ sigma, downMult });
  }
}

/*
 * The 10x weight on coverage distance is a hand-picked constant, and it is what
 * picks the winner: sigma 0.45 wins on the fit seasons (cov 0.7965, calib 0.115,
 * score 0.150) over sigma 0.35 / downMult 1.6 (cov 0.7905, calib 0.0895, score
 * 0.1845), which has FLATTER PIT but slightly worse coverage. Under any weighting
 * that values PIT flatness more than 10:1 against coverage distance, the runner-up
 * wins. It interacts with a defect in the shock itself — `exp(z * sigma)` is not
 * mean-preserving (see WEEKLY_LEVEL), inflating the simulated mean ~10% at 0.45,
 * which buys coverage cheaply by fattening the right tail while degrading PIT —
 * and this criterion is built to accept that trade. Fix the two together: make the
 * shock mean-preserving, then select on a proper scoring rule (CRPS) with coverage
 * as a hard constraint, and report the argmin's sensitivity to the weight. Not
 * changed in isolation, because refitting on the current shock would re-select a
 * sigma for a distribution that is already known to be mis-centred.
 */
const score = (cov, cal) => Math.abs(cov - TARGET) * 10 + cal;

console.log(`Sweeping ${grid.length} weekly level settings on ${FIT_SEASONS.join(' + ')}, ` +
  `validating on ${VALIDATION_SEASON}.\n`);

const results = [];
for (const level of grid) {
  const per = FIT_SEASONS.map(s => replaySeasonWeekly(s, { ...production(s), level, runs: RUNS }).distribution);
  const cov = per.reduce((s, d) => s + d.coverage_80, 0) / per.length;
  const cal = per.reduce((s, d) => s + d.calibration_error, 0) / per.length;
  const crps = per.reduce((s, d) => s + d.crps, 0) / per.length;
  results.push({ level, cov, cal, crps, score: score(cov, cal) });
}
results.sort((a, b) => a.score - b.score);

console.log('Top settings on the FIT seasons:');
console.log('  sigma  down |  coverage  calib   crps');
for (const r of results.slice(0, 8)) {
  console.log(`  ${r.level.sigma.toFixed(2)}   ${r.level.downMult.toFixed(1)} |   ` +
    `${r.cov.toFixed(3)}   ${r.cal.toFixed(3)}  ${r.crps.toFixed(3)}`);
}

const best = results[0];
console.log('\nBest on fit seasons:', best.level);

console.log(`\n=== VALIDATION on ${VALIDATION_SEASON} (never used to fit) ===`);
// "shipped" is whatever WEEKLY_LEVEL currently holds; it used to be hardcoded to
// sigma 0, which stopped being the shipped value once 0.45 was adopted.
const shipped = replaySeasonWeekly(VALIDATION_SEASON, { ...production(VALIDATION_SEASON), level: WEEKLY_LEVEL, runs: RUNS }).distribution;
const fitted = replaySeasonWeekly(VALIDATION_SEASON, { ...production(VALIDATION_SEASON), level: best.level, runs: RUNS }).distribution;
console.log(`  current (shipped ${JSON.stringify(WEEKLY_LEVEL)}): coverage`, shipped.coverage_80, ' calib', shipped.calibration_error, ' crps', shipped.crps);
console.log('  fitted           : coverage', fitted.coverage_80, ' calib', fitted.calibration_error, ' crps', fitted.crps);
console.log('  PIT current:', shipped.pit_histogram);
console.log('  PIT fitted :', fitted.pit_histogram);
console.log(`  (n = ${fitted.n} player-weeks; each PIT bin should hold ~${Math.round(fitted.n / 10)})`);

const pass = fitted.coverage_80 >= GATE[0] && fitted.coverage_80 <= GATE[1];
console.log(`\nGate 1.2 (weekly): coverage in [${GATE[0]}, ${GATE[1]}]: ${pass ? 'PASS' : 'FAIL'} (${fitted.coverage_80})`);
console.log(pass
  ? `\nAdopt by setting WEEKLY_LEVEL in projections.js to ${JSON.stringify(best.level)}`
  : '\nDo NOT adopt — did not hold up out of sample.');
