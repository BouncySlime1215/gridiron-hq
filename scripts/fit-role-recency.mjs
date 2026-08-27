#!/usr/bin/env node
/**
 * Stage 1.3 — fit opportunity-memory separately from efficiency-memory.
 *
 * Search is restricted to 2023-24. The chosen setting gets exactly one 2025
 * evaluation, and only when it improves discovery MAE without reducing rank.
 */
import { replaySeasonWeekly } from '../server/services/weekly-backtest.js';
import { activeKVector } from '../server/services/shrinkage-fit.js';
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';

const DISCOVERY = [2023, 2024];
const VALIDATION = 2025;
const settings = [];
for (const seasonDecay of [0.35, 0.20, 0.10, 0.05, 0]) {
  for (const weekHalfLife of [null, 12, 8, 5, 3]) settings.push({ seasonDecay, weekHalfLife });
}
const common = { startWeek: 5, endWeek: 18, distributions: false, kOverride: activeKVector() };
const replay = (season, roleRecency, distributions = false) => replaySeasonWeekly(season, {
  ...common, roleRecency, distributions, runs: distributions ? 300 : 200
});
const average = (rows, field) => rows.reduce((sum, row) => sum + row[field], 0) / rows.length;

const results = [];
for (const roleRecency of settings) {
  const seasons = DISCOVERY.map(season => replay(season, roleRecency).point.model);
  results.push({ roleRecency, mae: average(seasons, 'mae'), spearman: average(seasons, 'spearman') });
}
results.sort((a, b) => a.mae - b.mae || b.spearman - a.spearman);
console.log('Top discovery settings (2023-24 only):');
console.table(results.slice(0, 10).map(row => ({
  season_decay: row.roleRecency.seasonDecay,
  week_half_life: row.roleRecency.weekHalfLife ?? 'off',
  mae: row.mae,
  spearman: row.spearman
})));

const baseline = results.find(row => row.roleRecency.seasonDecay === 0.35
  && row.roleRecency.weekHalfLife == null);
const best = results.find(row => row.mae < baseline.mae && row.spearman >= baseline.spearman);
if (!best) {
  console.log(JSON.stringify({ discovery_gate: 'FAIL', baseline, validation_opened: false }, null, 2));
  process.exit(2);
}

console.log(`Discovery passed with ${JSON.stringify(best.roleRecency)}; opening ${VALIDATION} once.`);
const candidate = replay(VALIDATION, best.roleRecency, true);
const flat = replay(VALIDATION, undefined, true);
const vsStd = pairedBootstrapDiff(candidate._errors.season_to_date, candidate._errors.model, { seed: 20260829 });
const vsBlend = pairedBootstrapDiff(candidate._errors.blend, candidate._errors.model, { seed: 20260829 });
console.table([
  { model: 'active', mae: flat.point.model.mae, spearman: flat.point.model.spearman,
    crps: flat.distribution.crps, coverage: flat.distribution.coverage_80 },
  { model: 'role_recency', mae: candidate.point.model.mae, spearman: candidate.point.model.spearman,
    crps: candidate.distribution.crps, coverage: candidate.distribution.coverage_80 },
  { model: 'season_to_date', ...candidate.point.season_to_date },
  { model: 'blend', ...candidate.point.blend }
]);
const beatsBoth = vsStd.mean_diff < 0 && vsStd.significant && vsBlend.mean_diff < 0 && vsBlend.significant;
const rankOk = candidate.point.model.spearman >= Math.max(
  candidate.point.season_to_date.spearman, candidate.point.blend.spearman);
const coverageOk = candidate.distribution.coverage_80 >= 0.78 && candidate.distribution.coverage_80 <= 0.82;
console.log(JSON.stringify({
  validation_gate: beatsBoth && rankOk && coverageOk ? 'PASS' : 'FAIL',
  selected_on_discovery: best.roleRecency,
  beats_both_trivial_baselines_significantly: beatsBoth,
  rank_not_degraded: rankOk,
  coverage_in_0_78_0_82: coverageOk,
  vs_season_to_date: vsStd,
  vs_blend: vsBlend
}, null, 2));
