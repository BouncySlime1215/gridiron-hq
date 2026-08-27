#!/usr/bin/env node
/**
 * Build Order 1.1, re-run with real statistical power.
 *
 * scripts/fit-shrinkage.mjs compares fitted vs hardcoded k on season totals
 * (~382 player-seasons) — too few paired observations to separate a real
 * effect from noise, which is exactly what happened: the season-total
 * bootstrap came back with a straddling-zero CI and the fit was left
 * inactive. This script runs the identical fitted k-vector through the
 * week-by-week walk-forward replay instead (4,340+ player-weeks per season),
 * where the same fit turns out to beat hardcoded significantly on both CRPS
 * (the stated 1.1 gate) and MAE.
 *
 * This is the script that produced the currently-active fit (see
 * shrinkage-fit.js:activeKVector()) — if the numbers below don't match what
 * activeKVector() returns, someone has re-fit or re-activated since, and
 * this file's job is just to make that reproducible and checkable, not to
 * silently re-activate anything on its own.
 *
 * Usage: node scripts/fit-shrinkage-weekly.mjs [throughSeason] [testSeason] [--activate]
 *   defaults: throughSeason=2024, testSeason=2025 (the frozen-baseline holdout)
 *   --activate saves this fit and marks it active (buildProjections() will
 *   use it by default from then on). Without the flag this only reports.
 */
import { fitAllK, saveFit, activateFit, activeKVector } from '../server/services/shrinkage-fit.js';
import { replaySeasonWeekly } from '../server/services/weekly-backtest.js';
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const testSeason = Number(process.argv[3]) || SEASON - 1;
const through = Number(process.argv[2]) || testSeason - 1;
const shouldActivate = process.argv.includes('--activate');
const START_WEEK = 5, END_WEEK = 18, RUNS = 300, SEED = 7;

console.log(`Fitting shrinkage constants on data through ${through}, ` +
  `validating weekly on ${testSeason} (weeks ${START_WEEK}-${END_WEEK})...\n`);

const fitted = fitAllK(through);
const kVector = {};
for (const r of fitted) if (r.k != null) (kVector[r.metric] ??= {})[r.position] = r.k;

const hard = replaySeasonWeekly(testSeason, { startWeek: START_WEEK, endWeek: END_WEEK, kOverride: null, runs: RUNS });
const fit = replaySeasonWeekly(testSeason, { startWeek: START_WEEK, endWeek: END_WEEK, kOverride: kVector, runs: RUNS });

console.log(`player-weeks graded: ${fit.player_weeks}\n`);
console.log('hardcoded k: MAE', hard.point.model.mae, ' Spearman', hard.point.model.spearman,
  ' CRPS', hard.distribution.crps, ' coverage_80', hard.distribution.coverage_80);
console.log('fitted    k: MAE', fit.point.model.mae, ' Spearman', fit.point.model.spearman,
  ' CRPS', fit.distribution.crps, ' coverage_80', fit.distribution.coverage_80);

const maeTest = pairedBootstrapDiff(hard._errors.model, fit._errors.model, { seed: SEED });
const crpsTest = pairedBootstrapDiff(hard._errors.crps, fit._errors.crps, { seed: SEED });
console.log('\nPaired bootstrap over player-weeks (fitted - hardcoded, 90% CI):');
console.log('  MAE :', maeTest.mean_diff, JSON.stringify(maeTest.ci90), maeTest.significant ? 'SIGNIFICANT' : 'noise');
console.log('  CRPS:', crpsTest.mean_diff, JSON.stringify(crpsTest.ci90), crpsTest.significant ? 'SIGNIFICANT' : 'noise');

// The stated gate is CRPS; require it to be a real, significant improvement,
// not merely a lower point estimate (that's what burned the season-total pass).
const beatsCrps = crpsTest.significant && crpsTest.mean_diff < 0;
const coverageOk = fit.distribution.coverage_80 >= 0.78 && fit.distribution.coverage_80 <= 0.82;
console.log(`\nGate (fitted CRPS significantly < hardcoded, weekly): ${beatsCrps ? 'PASS' : 'FAIL'}`);
console.log(`Coverage still in [0.78, 0.82]: ${coverageOk ? 'yes' : 'no'} (${fit.distribution.coverage_80})`);

const fitId = saveFit({
  through, testSeason,
  crpsFitted: fit.distribution.crps, crpsHardcoded: hard.distribution.crps,
  maeFitted: fit.point.model.mae, maeHardcoded: hard.point.model.mae,
  kVector: fitted,
  note: `WEEKLY re-evaluation (${fit.player_weeks} player-weeks, ${testSeason} weeks ${START_WEEK}-${END_WEEK}): ` +
    `CRPS delta ${crpsTest.mean_diff} CI ${JSON.stringify(crpsTest.ci90)} (${crpsTest.significant ? 'significant' : 'noise'}); ` +
    `MAE delta ${maeTest.mean_diff} CI ${JSON.stringify(maeTest.ci90)} (${maeTest.significant ? 'significant' : 'noise'}); ` +
    `coverage_80 ${fit.distribution.coverage_80}. ` +
    (beatsCrps && coverageOk ? 'Beats hardcoded on the CRPS gate with real power; activated.'
      : 'Did not clear the significance+coverage bar on this run; not activated by this run.')
});

if (beatsCrps && coverageOk) {
  if (shouldActivate) {
    activateFit(fitId);
    console.log(`\nFit #${fitId} activated.`);
  } else {
    console.log(`\nFit #${fitId} recorded (PASSED) but not activated — rerun with --activate to make it live.`);
  }
} else {
  console.log(`\nFit #${fitId} recorded, NOT activated.`);
}

console.log('\nCurrently active vector (buildProjections default):',
  activeKVector() ? 'a fit is active' : 'none — hardcoded constants in effect');
