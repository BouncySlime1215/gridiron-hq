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

const score = (cov, cal) => Math.abs(cov - TARGET) * 10 + cal;

console.log(`Sweeping ${grid.length} weekly level settings on ${FIT_SEASONS.join(' + ')}, ` +
  `validating on ${VALIDATION_SEASON}.\n`);

const results = [];
for (const level of grid) {
  const per = FIT_SEASONS.map(s => replaySeasonWeekly(s, { level, runs: RUNS }).distribution);
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
const shipped = replaySeasonWeekly(VALIDATION_SEASON, { level: { sigma: 0, downMult: 1 }, runs: RUNS }).distribution;
const fitted = replaySeasonWeekly(VALIDATION_SEASON, { level: best.level, runs: RUNS }).distribution;
console.log('  current (shipped): coverage', shipped.coverage_80, ' calib', shipped.calibration_error, ' crps', shipped.crps);
console.log('  fitted           : coverage', fitted.coverage_80, ' calib', fitted.calibration_error, ' crps', fitted.crps);
console.log('  PIT current:', shipped.pit_histogram);
console.log('  PIT fitted :', fitted.pit_histogram);
console.log(`  (n = ${fitted.n} player-weeks; each PIT bin should hold ~${Math.round(fitted.n / 10)})`);

const pass = fitted.coverage_80 >= GATE[0] && fitted.coverage_80 <= GATE[1];
console.log(`\nGate 1.2 (weekly): coverage in [${GATE[0]}, ${GATE[1]}]: ${pass ? 'PASS' : 'FAIL'} (${fitted.coverage_80})`);
console.log(pass
  ? `\nAdopt by setting WEEKLY_LEVEL in projections.js to ${JSON.stringify(best.level)}`
  : '\nDo NOT adopt — did not hold up out of sample.');
