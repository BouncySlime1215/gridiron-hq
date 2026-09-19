#!/usr/bin/env node
/**
 * Stage 2 walk-forward validation (Giant Plan Step 4b). Assumes
 * GRIDIRON_DB_PATH already points at a safe /tmp snapshot built by
 * `_prepare-validation-db.mjs` — see that file's header for why this cannot
 * run against the real data.sqlite directly (importing server/db/index.js
 * opens whatever path it is given read-write).
 *
 * SAMPLE SIZE, STATED UP FRONT: `ensembleLine` re-fits the full walk-forward
 * ensemble weight set from scratch for every distinct (season, week) cutoff
 * it has not already fit in this process (~4 minutes each, measured directly
 * against this validation database before writing this loop — see
 * PROPS_TO_SPREAD_REPORT.md). A full 3-season x 18-week sweep is 54 distinct
 * cutoffs, ~3.5 hours, impractical for this pass. TEST_POINTS below is a
 * fixed, small, EXPLICIT sample instead — three weeks (early/mid/late season)
 * per test season — so the honest n this validation runs on is stated in the
 * code, not discovered later. `buildPlayerWeekEngine` and the bottom-up
 * aggregation are NOT the bottleneck (~1s per week); only the ensemble
 * comparison is sample-limited.
 *
 * WHAT THIS MEASURES
 *  1. Bottom-up team total: sum Gridiron's own player-week engine (usage x
 *     efficiency) into team points, calibrated against real box scores.
 *  2. Whether that total adds anything the existing top-down spread ensemble
 *     does not already have, via walk-forward RMSE against real final scores
 *     on real held-out games/weeks the calibration never trained on.
 *  3. Whether the bottom-up skill (if any) is coming from projecting USAGE
 *     or EFFICIENCY, by nulling each in turn and re-scoring.
 *  4. Whether correlating teammates (nfl-prop-correlation.js archetypes)
 *     instead of summing them independently changes the team total's
 *     variance — a real, separate question from (2): correlation cannot
 *     move a SUM's mean, only its spread, so it is graded on the naive-vs-
 *     correlated variance ratio, not RMSE. Computed for every team-week in
 *     the same sample (cheap: pure in-process Monte Carlo, no DB, no
 *     ensemble fit).
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';

// The marker below identified the production database by its old Artifacts path. That file was
// deleted on 2026-09-16 and the real database now lives at server/data.sqlite, so the marker
// stopped matching it -- leaving this worker free to run against production. Resolve the real
// path and refuse it directly; the old marker stays as a catch for stale env values.
const dbPath = process.env.GRIDIRON_DB_PATH;
const REAL_MARKER = 'fantasy-football-dashboard/server/data.sqlite';
const REAL_DB = new URL('../server/data.sqlite', import.meta.url).pathname;
if (!dbPath
    || path.resolve(dbPath) === path.resolve(REAL_DB)
    || dbPath.includes(REAL_MARKER)) {
  throw new Error('Refusing to run: GRIDIRON_DB_PATH must point at a validation snapshot, not the real database.');
}
if (!existsSync(dbPath)) {
  throw new Error(`GRIDIRON_DB_PATH does not exist: ${dbPath}. Run scripts/_prepare-validation-db.mjs first.`);
}
console.log(`[worker] using validation database: ${dbPath}`);

const { rows } = await import('../server/db/index.js');
const { buildPlayerWeekEngine, clearPlayerWeekEngineCache } = await import('../server/services/player-week-engine.js');
const { ensembleLine } = await import('../server/services/nfl-ensemble.js');
const {
  fitTeamTotalCalibration, positionAverageEfficiency, positionStatSigma,
  teamBottomUpScenarios, teamBottomUpDistribution
} = await import('../server/services/bottom-up-team-total.js');

const FIT_MAX_SEASON = 2022; // calibration + league-average efficiency trained only through here
const TEST_POINTS = [
  { season: 2023, week: 3 }, { season: 2023, week: 9 }, { season: 2023, week: 15 },
  { season: 2024, week: 3 }, { season: 2024, week: 9 }, { season: 2024, week: 15 },
  { season: 2025, week: 3 }, { season: 2025, week: 9 }, { season: 2025, week: 15 }
];

console.log('='.repeat(78));
console.log('CALIBRATION (real box scores, season <= ' + FIT_MAX_SEASON + ' only)');
console.log('='.repeat(78));
const calibration = fitTeamTotalCalibration({ maxSeason: FIT_MAX_SEASON });
console.log(calibration);
if (calibration.error) { console.error('Cannot proceed without a calibration fit.'); process.exit(1); }
const leagueAvg = positionAverageEfficiency({ maxSeason: FIT_MAX_SEASON });
console.log('\nposition-average efficiency (train-only):', leagueAvg);
const sigmas = positionStatSigma({ maxSeason: FIT_MAX_SEASON });
console.log('\nposition-stat sigmas (train-only):', sigmas);

console.log('\n' + '='.repeat(78));
console.log(`WALK-FORWARD TEST — ${TEST_POINTS.length} explicit (season,week) cutoffs`);
console.log('(each costs ~4 minutes to fit the ensemble walk-forward weights — this');
console.log(' loop is expected to run roughly ' + (TEST_POINTS.length * 4) + ' minutes)');
console.log('='.repeat(78));

const records = [];
const varianceRows = [];
let ensembleSkipped = 0;

for (const { season, week } of TEST_POINTS) {
  const t0 = Date.now();
  const slate = rows(`SELECT team AS home, opponent AS away FROM game_lines
                      WHERE season=? AND week=? AND home=1`, season, week);
  if (!slate.length) { console.log(`  ${season} wk${week}: no slate, skipping`); continue; }

  let engine;
  try {
    engine = buildPlayerWeekEngine({ season, week });
  } catch (err) {
    console.log(`  ${season} wk${week}: engine build failed (${err.message}), skipping`);
    continue;
  }

  let gamesUsed = 0;
  for (const { home, away } of slate) {
    const homeActual = rows(`SELECT team_score FROM game_lines WHERE season=? AND week=? AND team=?`,
      season, week, home)[0]?.team_score;
    const awayActual = rows(`SELECT team_score FROM game_lines WHERE season=? AND week=? AND team=?`,
      season, week, away)[0]?.team_score;
    if (homeActual == null || awayActual == null) continue; // game not final in this snapshot

    let ens;
    try { ens = ensembleLine(season, week, home, away); } catch { ens = { error: 'threw' }; }
    if (ens.error) { ensembleSkipped += 2; continue; }
    const margin = ens.ensemble.projected_margin, total = ens.ensemble.projected_total;
    if (margin == null || total == null) { ensembleSkipped += 2; continue; }
    const ensembleHome = (total + margin) / 2;
    const ensembleAway = (total - margin) / 2;
    gamesUsed++;

    for (const [team, actual, ensembleTotal] of [[home, homeActual, ensembleHome], [away, awayActual, ensembleAway]]) {
      const scenarios = teamBottomUpScenarios(engine, team, { calibration, leagueAvg });
      if (!scenarios.participants) continue;
      records.push({
        season, week, team, actual, ensemble_total: +ensembleTotal.toFixed(2),
        bottom_up_full: scenarios.full.points,
        bottom_up_usage_nulled: scenarios.usage_nulled.points,
        bottom_up_efficiency_nulled: scenarios.efficiency_nulled.points,
        bottom_up_pass_yards: scenarios.full.pass_yards, bottom_up_rush_yards: scenarios.full.rush_yards,
        bottom_up_tds: scenarios.full.offensive_tds
      });

      const dist = teamBottomUpDistribution(engine, team, { calibration, sigmas, trials: 3000, seed: 517 });
      if (dist) varianceRows.push({ season, week, team, ...dist });
    }
  }
  clearPlayerWeekEngineCache();
  console.log(`  ${season} wk${week}: ${gamesUsed} games used, engine+ensemble fit took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

console.log(`\nrecords: ${records.length} (team-observations skipped for missing ensemble output: ${ensembleSkipped})`);
if (records.length < 10) { console.error('Too few records to report anything meaningful. Stopping.'); process.exit(1); }

const rmse = key => Math.sqrt(records.reduce((s, r) => s + (r[key] - r.actual) ** 2, 0) / records.length);
const mae = key => records.reduce((s, r) => s + Math.abs(r[key] - r.actual), 0) / records.length;
const bias = key => records.reduce((s, r) => s + (r[key] - r.actual), 0) / records.length;
const corr = (a, b) => {
  const n = records.length;
  const ma = records.reduce((s, r) => s + r[a], 0) / n, mb = records.reduce((s, r) => s + r[b], 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (const r of records) { const da = r[a] - ma, db = r[b] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return sab / Math.sqrt(saa * sbb);
};

console.log('\n' + '='.repeat(78));
console.log('WALK-FORWARD ACCURACY vs REAL FINAL TEAM SCORE (n=' + records.length + ')');
console.log('='.repeat(78));
console.log('existing ensemble (top-down)   RMSE', rmse('ensemble_total').toFixed(3), ' MAE', mae('ensemble_total').toFixed(3), ' bias', bias('ensemble_total').toFixed(3));
console.log('bottom-up FULL                 RMSE', rmse('bottom_up_full').toFixed(3), ' MAE', mae('bottom_up_full').toFixed(3), ' bias', bias('bottom_up_full').toFixed(3));
console.log('bottom-up USAGE-NULLED         RMSE', rmse('bottom_up_usage_nulled').toFixed(3), ' MAE', mae('bottom_up_usage_nulled').toFixed(3), ' bias', bias('bottom_up_usage_nulled').toFixed(3));
console.log('bottom-up EFFICIENCY-NULLED    RMSE', rmse('bottom_up_efficiency_nulled').toFixed(3), ' MAE', mae('bottom_up_efficiency_nulled').toFixed(3), ' bias', bias('bottom_up_efficiency_nulled').toFixed(3));

console.log('\ncorrelation(bottom_up_full, ensemble_total):', corr('bottom_up_full', 'ensemble_total').toFixed(3));
console.log('correlation(bottom_up_full, actual):', corr('bottom_up_full', 'actual').toFixed(3));
console.log('correlation(ensemble_total, actual):', corr('ensemble_total', 'actual').toFixed(3));

console.log('\n' + '-'.repeat(78));
console.log('ADDITIVE-VALUE CHECK: blend(w) = w*ensemble + (1-w)*bottom_up_full');
console.log('(blend weight swept ON THIS SAME TEST SET — a ceiling on what a fitted');
console.log(' blend could achieve with free access to the answers, not a forward-');
console.log(' validated result. A real forward test needs a train/test split on the');
console.log(' blend weight itself, which this n is too small to support honestly.)');
console.log('-'.repeat(78));
let best = { w: 1, rmse: rmse('ensemble_total') };
for (let w = 0; w <= 1.001; w += 0.05) {
  const errs = records.map(r => (w * r.ensemble_total + (1 - w) * r.bottom_up_full) - r.actual);
  const rmseW = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
  if (rmseW < best.rmse) best = { w: +w.toFixed(2), rmse: rmseW };
}
console.log(`best blend weight on ensemble: w=${best.w} (1=pure ensemble, 0=pure bottom-up) -> RMSE ${best.rmse.toFixed(3)}`);
console.log(`pure ensemble RMSE: ${rmse('ensemble_total').toFixed(3)}  ->  improvement from best in-sample blend: ${(rmse('ensemble_total') - best.rmse).toFixed(3)} points`);

console.log('\n' + '='.repeat(78));
console.log(`CORRELATION MODEL: does it change the team total's variance? (n=${varianceRows.length} team-weeks)`);
console.log('(mean should match the deterministic FULL scenario above up to Monte');
console.log(' Carlo noise — only the spread differs between the two runs)');
console.log('='.repeat(78));
const meanAbsMeanGap = varianceRows.length
  ? varianceRows.reduce((s, r) => {
    const rec = records.find(x => x.season === r.season && x.week === r.week && x.team === r.team);
    return s + Math.abs((rec?.bottom_up_full ?? r.mean_points) - r.mean_points);
  }, 0) / varianceRows.length : null;
console.log(`mean |MC mean - deterministic full points| across ${varianceRows.length} team-weeks: ${meanAbsMeanGap?.toFixed(3)} (consistency check)`);
const ratios = varianceRows.map(r => r.variance_ratio_naive_over_correlated).filter(x => x != null);
const avgRatio = ratios.length ? ratios.reduce((s, x) => s + x, 0) / ratios.length : null;
const medianRatio = ratios.length ? [...ratios].sort((a, b) => a - b)[Math.floor(ratios.length / 2)] : null;
console.log(`variance ratio (naive-independent / correlated), n=${ratios.length}: mean=${avgRatio?.toFixed(3)}  median=${medianRatio?.toFixed(3)}`);
console.log('(ratio > 1 means the naive independent-sum approach UNDERSTATES the real,');
console.log(' correlated variance of the team total; ratio < 1 means it OVERSTATES it;');
console.log(' 1 would mean teammate correlation barely matters for this sum.)');
console.log('sample of individual team-weeks:');
for (const r of varianceRows.slice(0, 12)) {
  console.log(`  ${r.season} wk${r.week} ${r.team}: mean=${r.mean_points} sd_correlated=${r.sd_points_correlated} sd_naive=${r.sd_points_naive_independent} ratio=${r.variance_ratio_naive_over_correlated} (legs=${r.legs})`);
}

console.log('\n' + '='.repeat(78));
console.log('USAGE vs EFFICIENCY: which one carries the signal?');
console.log('='.repeat(78));
const deltaUsage = rmse('bottom_up_usage_nulled') - rmse('bottom_up_full');
const deltaEfficiency = rmse('bottom_up_efficiency_nulled') - rmse('bottom_up_full');
console.log(`Nulling USAGE (equal split among teammates, own efficiency kept) moves RMSE by ${deltaUsage.toFixed(3)}`);
console.log(`Nulling EFFICIENCY (position-average rate, own touches kept) moves RMSE by ${deltaEfficiency.toFixed(3)}`);
console.log(Math.abs(deltaEfficiency) > Math.abs(deltaUsage)
  ? 'EFFICIENCY carries more of the team-total skill than USAGE allocation does.'
  : 'USAGE carries as much or more of the team-total skill than EFFICIENCY does — worth a second look.');

const outPath = process.argv[2] ?? null;
if (outPath) {
  writeFileSync(outPath, JSON.stringify({ calibration, leagueAvg, sigmas, test_points: TEST_POINTS, records, varianceRows }, null, 2));
  console.log(`\n[worker] raw records written to ${outPath}`);
}
console.log('\n[worker] done.');
