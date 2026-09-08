#!/usr/bin/env node
/**
 * Run and freeze one Package D role-scenario research artifact.
 *
 * Read-only against the live database: every query is a SELECT against
 * player_week_usage / nfl_injuries / player_week_snaps. Output is written
 * only to server/data/role-scenario-lab, never to data.sqlite.
 */
import { runRoleScenarioExperiment, freezeRoleScenarioExperiment } from '../server/services/role-scenario-lab.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const report = runRoleScenarioExperiment({
  fitSeasons: args['fit-seasons'] ? String(args['fit-seasons']).split(',').map(Number) : [2022, 2023],
  discoverySeason: args['discovery-season'] ? Number(args['discovery-season']) : 2024,
  holdoutSeason: args['holdout-season'] ? Number(args['holdout-season']) : 2025
});

console.log(`Changepoint detector: chosen threshold ${report.results.changepoint_detection.chosen_threshold}`);
console.log(`  discovery (${report.results.changepoint_detection.discovery.season}): scan_statistic F1=${report.results.changepoint_detection.discovery.scan_statistic.f1}, existing F1=${report.results.changepoint_detection.discovery.existing_threshold_detector.f1}, n=${report.results.changepoint_detection.discovery.n}`);
console.log(`  holdout (${report.results.changepoint_detection.holdout.season}): scan_statistic F1=${report.results.changepoint_detection.holdout.scan_statistic.f1}, existing F1=${report.results.changepoint_detection.holdout.existing_threshold_detector.f1}, n=${report.results.changepoint_detection.holdout.n}`);

console.log(`\nCascade conservation audit: ${report.results.cascade_conservation_audit.violations}/${report.results.cascade_conservation_audit.n_starters_checked} starters have beneficiaries whose combined gain exceeds the starter's own opportunity (rate ${report.results.cascade_conservation_audit.violation_rate})`);

for (const [label, r] of [['discovery', report.results.reallocation.discovery], ['holdout', report.results.reallocation.holdout]]) {
  console.log(`\nReallocation test (${label}, season ${r.season}, n=${r.n}):`);
  console.log(`  touches: baseline MAE ${r.touches.baseline_mae} vs scenario MAE ${r.touches.scenario_mae} — improves=${r.touches.improves}`);
  console.log(`  yards:   baseline MAE ${r.yards.baseline_mae} vs scenario MAE ${r.yards.scenario_mae} — improves=${r.yards.improves}`);
}

console.log(`\nVerdict: ${report.verdict}`);

const result = freezeRoleScenarioExperiment(report);
console.log(result.existing
  ? `\nRun ${result.hash} already frozen at ${result.dir}`
  : `\nFroze run ${result.hash} at ${result.dir}`);
