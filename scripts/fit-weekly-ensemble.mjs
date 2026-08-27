#!/usr/bin/env node
/**
 * Stage 1.3 — cutoff-safe stacking of genuinely different weekly heads.
 *
 * 2023 fits convex weights. 2024 chooses global vs position-specific weights.
 * Only an architecture that beats the fixed 60/40 baseline in 2024 is allowed
 * one evaluation on 2025. No 2025 outcome participates in fitting or selection.
 */
import { replaySeasonWeekly } from '../server/services/weekly-backtest.js';
import { activeKVector } from '../server/services/shrinkage-fit.js';
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';
import { spearman } from '../server/services/backtest.js';
import { WEEKLY_ROLE_RECENCY } from '../server/services/weekly-ensemble.js';

const ROLE_RECENCY = WEEKLY_ROLE_RECENCY;
const HEADS = ['structural', 'season_to_date', 'last3', 'last1', 'median'];
const common = {
  startWeek: 5, endWeek: 18, distributions: false,
  kOverride: activeKVector(), roleRecency: ROLE_RECENCY
};
const replay = (season, extra = {}) => replaySeasonWeekly(season, { ...common, ...extra });
const mae = (data, predictor) => data.reduce((sum, row) => sum + Math.abs(predictor(row) - row.actual), 0) / data.length;
const rank = (data, predictor) => spearman(data.map(row => ({ pred: predictor(row), act: row.actual })));
const weighted = (weights, row) => HEADS.reduce((sum, head, index) => sum + weights[index] * row[head], 0);

function weightGrid(step = 0.05) {
  const units = Math.round(1 / step), out = [];
  for (let a = 0; a <= units; a++)
    for (let b = 0; b <= units - a; b++)
      for (let c = 0; c <= units - a - b; c++)
        for (let d = 0; d <= units - a - b - c; d++) {
          const e = units - a - b - c - d;
          out.push([a, b, c, d, e].map(value => value / units));
        }
  return out;
}

const GRID = weightGrid();
function fitWeights(data) {
  let best = null;
  for (const weights of GRID) {
    const error = mae(data, row => weighted(weights, row));
    if (!best || error < best.mae) best = { weights, mae: error };
  }
  return best.weights;
}

const train = replay(2023)._predictions;
const discovery = replay(2024)._predictions;
const globalWeights = fitWeights(train);
const positions = ['QB', 'RB', 'WR', 'TE'];
const positionWeights = Object.fromEntries(positions.map(position => {
  const subset = train.filter(row => row.position === position);
  return [position, subset.length >= 200 ? fitWeights(subset) : globalWeights];
}));
const predictors = {
  global: row => weighted(globalWeights, row),
  by_position: row => weighted(positionWeights[row.position] ?? globalWeights, row)
};
const discoveryResults = Object.entries(predictors).map(([architecture, predictor]) => ({
  architecture, mae: mae(discovery, predictor), spearman: rank(discovery, predictor)
}));
const baseline = {
  architecture: 'fixed_60_40',
  mae: mae(discovery, row => row.blend),
  spearman: rank(discovery, row => row.blend)
};
console.log('Heads:', HEADS.join(', '));
console.log('2023 fitted global weights:', Object.fromEntries(HEADS.map((head, i) => [head, globalWeights[i]])));
console.log('2023 fitted position weights:');
console.table(Object.entries(positionWeights).map(([position, weights]) => ({
  position, ...Object.fromEntries(HEADS.map((head, i) => [head, weights[i]]))
})));
console.log('Architecture selection on 2024 only:');
console.table([baseline, ...discoveryResults]);

const selected = discoveryResults
  .filter(row => row.mae < baseline.mae && row.spearman >= baseline.spearman)
  .sort((a, b) => a.mae - b.mae)[0];
if (!selected) {
  console.log(JSON.stringify({ discovery_gate: 'FAIL', validation_opened: false }, null, 2));
  process.exit(2);
}

const predictionHead = context => {
  const weights = selected.architecture === 'by_position'
    ? (positionWeights[context.position] ?? globalWeights) : globalWeights;
  return weighted(weights, context);
};
console.log(`Discovery passed with ${selected.architecture}; opening 2025 once.`);
const candidate = replay(2025, { distributions: true, runs: 300, predictionHead });
const structural = replay(2025, { distributions: true, runs: 300 });
const vsStd = pairedBootstrapDiff(candidate._errors.season_to_date, candidate._errors.model, { seed: 20260830 });
const vsBlend = pairedBootstrapDiff(candidate._errors.blend, candidate._errors.model, { seed: 20260830 });
console.table([
  { model: 'structural', mae: structural.point.model.mae, spearman: structural.point.model.spearman,
    crps: structural.distribution.crps, coverage: structural.distribution.coverage_80 },
  { model: `ensemble_${selected.architecture}`, mae: candidate.point.model.mae,
    spearman: candidate.point.model.spearman, crps: candidate.distribution.crps,
    coverage: candidate.distribution.coverage_80 },
  { model: 'season_to_date', ...candidate.point.season_to_date },
  { model: 'fixed_60_40', ...candidate.point.blend }
]);
const beatsBoth = vsStd.mean_diff < 0 && vsStd.significant && vsBlend.mean_diff < 0 && vsBlend.significant;
const rankOk = candidate.point.model.spearman >= Math.max(
  candidate.point.season_to_date.spearman, candidate.point.blend.spearman);
const coverageOk = candidate.distribution.coverage_80 >= 0.78 && candidate.distribution.coverage_80 <= 0.82;
const crpsOk = candidate.distribution.crps <= structural.distribution.crps;
console.log(JSON.stringify({
  validation_gate: beatsBoth && rankOk && coverageOk && crpsOk ? 'PASS' : 'FAIL',
  architecture: selected.architecture,
  heads: HEADS,
  beats_both_trivial_baselines_significantly: beatsBoth,
  rank_not_degraded: rankOk,
  coverage_in_0_78_0_82: coverageOk,
  crps_not_degraded: crpsOk,
  vs_season_to_date: vsStd,
  vs_fixed_60_40: vsBlend
}, null, 2));
