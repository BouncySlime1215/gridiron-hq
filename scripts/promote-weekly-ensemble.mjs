#!/usr/bin/env node
/**
 * Phase 1a — stop production running frozen 2023 weights that lose to a moving average.
 *
 * `activeWeeklyWeightSet()` falls back to the hardcoded `WEEKLY_ENSEMBLE_WEIGHTS`
 * because `weekly_ensemble_fits` is empty. Measured 2026-09-17 on the 2025
 * walk-forward: frozen 4.455 MAE, season_to_date 4.386, fitted 4.334. Production
 * is losing to a naive average and a validated fit was never persisted.
 *
 * Two stages, in this order, and the second only runs if the first passes:
 *
 *   1. GATE (cutoff-safe, exactly as scripts/fit-weekly-ensemble.mjs ran it):
 *      fit weights on 2023 -> choose the architecture on 2024 -> open 2025 ONCE.
 *      Pass requires beating BOTH trivial baselines significantly (paired
 *      bootstrap), no rank degradation, 80% coverage in [0.78, 0.82], and CRPS
 *      no worse than structural.
 *
 *   2. PRODUCTION FIT: refit the same architecture on 2023+2024+2025 pooled and
 *      persist it with through_season=2025, through_week=18. That cutoff is what
 *      makes it legal for 2026: `activeWeeklyWeightSet({season, week})` only
 *      returns a fit whose cutoff is strictly before the week being predicted.
 *      The gate's numbers are stored alongside so the promotion is auditable.
 *
 * --dry-run  runs the gate and prints the production weights without writing.
 */
import { replaySeasonWeekly } from '../server/services/weekly-backtest.js';
import { activeKVector } from '../server/services/shrinkage-fit.js';
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';
import { spearman } from '../server/services/backtest.js';
import { WEEKLY_ROLE_RECENCY, weeklyEnsemblePrediction } from '../server/services/weekly-ensemble.js';
import { saveWeeklyFit, activeWeeklyWeightSet, weeklyFitHistory } from '../server/services/weekly-weight-store.js';

const DRY = process.argv.includes('--dry-run');
const HEADS = ['structural', 'season_to_date', 'last3', 'last1', 'median'];
// Identical harness settings to scripts/fit-weekly-ensemble.mjs — the gate is
// only meaningful if it reproduces that run exactly.
const common = {
  startWeek: 5, endWeek: 18, distributions: false,
  kOverride: activeKVector(), roleRecency: WEEKLY_ROLE_RECENCY,
};
const replay = (season, extra = {}) => replaySeasonWeekly(season, { ...common, ...extra });
const mae = (data, p) => data.reduce((s, r) => s + Math.abs(p(r) - r.actual), 0) / data.length;
const rankOf = (data, p) => spearman(data.map(r => ({ pred: p(r), act: r.actual })));
const weighted = (w, r) => HEADS.reduce((s, h, i) => s + w[i] * r[h], 0);

/** Every convex combination of the five heads on a 0.05 grid. */
function weightGrid(step = 0.05) {
  const out = [];
  const n = Math.round(1 / step);
  for (let a = 0; a <= n; a++) for (let b = 0; a + b <= n; b++) for (let c = 0; a + b + c <= n; c++)
    for (let d = 0; a + b + c + d <= n; d++) {
      const e = n - a - b - c - d;
      out.push([a, b, c, d, e].map(x => x * step));
    }
  return out;
}
const GRID = weightGrid();
function fitWeights(data) {
  let best = null, bestMae = Infinity;
  for (const w of GRID) {
    const m = mae(data, r => weighted(w, r));
    if (m < bestMae) { bestMae = m; best = w; }
  }
  return best;
}
const named = w => Object.fromEntries(HEADS.map((h, i) => [h, w[i]]));

console.log('--- stage 1: cutoff-safe gate (fit 2023 -> select 2024 -> open 2025 once) ---');
const train = replay(2023)._predictions;
const discovery = replay(2024)._predictions;
const globalWeights = fitWeights(train);
const positions = ['QB', 'RB', 'WR', 'TE'];
const positionWeights = Object.fromEntries(positions.map(p => {
  const subset = train.filter(r => r.position === p);
  return [p, subset.length >= 200 ? fitWeights(subset) : globalWeights];
}));
const predictors = {
  global: r => weighted(globalWeights, r),
  position: r => weighted(positionWeights[r.position] ?? globalWeights, r),
};
const baseline = {
  mae: mae(discovery, r => r.season_to_date),
  spearman: rankOf(discovery, r => r.season_to_date),
};
const selected = Object.entries(predictors)
  .map(([architecture, p]) => ({ architecture, mae: mae(discovery, p), spearman: rankOf(discovery, p) }))
  .filter(r => r.mae < baseline.mae && r.spearman >= baseline.spearman)
  .sort((a, b) => a.mae - b.mae)[0];

console.log('2023 fitted global weights:', named(globalWeights));
console.log('2024 discovery — season_to_date baseline MAE', baseline.mae.toFixed(4), 'spearman', baseline.spearman.toFixed(4));
if (!selected) {
  console.log(JSON.stringify({ discovery_gate: 'FAIL', validation_opened: false, promoted: false }, null, 2));
  process.exit(1);
}
console.log(`discovery passed with "${selected.architecture}" (MAE ${selected.mae.toFixed(4)}); opening 2025 once.`);

const weightsFor = r => (selected.architecture === 'position'
  ? (positionWeights[r.position] ?? globalWeights) : globalWeights);
const predictionHead = ctx => {
  const row = HEADS.reduce((acc, h) => ({ ...acc, [h]: ctx[h] }), { position: ctx.position });
  return weighted(weightsFor(row), row);
};

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
  { model: 'fixed_60_40 (PRODUCTION today)', ...candidate.point.blend },
]);
const beatsBoth = vsStd.mean_diff < 0 && vsStd.significant && vsBlend.mean_diff < 0 && vsBlend.significant;
const rankOk = candidate.point.model.spearman >= Math.max(candidate.point.season_to_date.spearman, candidate.point.blend.spearman);
const coverageOk = candidate.distribution.coverage_80 >= 0.78 && candidate.distribution.coverage_80 <= 0.82;
const crpsOk = candidate.distribution.crps <= structural.distribution.crps;
const gate = beatsBoth && rankOk && coverageOk && crpsOk;
console.log(JSON.stringify({
  validation_gate: gate ? 'PASS' : 'FAIL', architecture: selected.architecture,
  beats_both_trivial_baselines_significantly: beatsBoth, rank_not_degraded: rankOk,
  coverage_in_0_78_0_82: coverageOk, crps_not_degraded: crpsOk,
  vs_season_to_date: vsStd, vs_fixed_60_40: vsBlend,
}, null, 2));
if (!gate) { console.log('gate FAILED — nothing promoted, production keeps frozen weights.'); process.exit(1); }

console.log('\n--- stage 2: production fit on 2023+2024+2025, cutoff 2025-W18 ---');
// The gate proved the architecture. Production uses every season we have, which
// is still strictly before any 2026 week it will be asked to predict.
const validation = replay(2025)._predictions;
const pooled = [...train, ...discovery, ...validation];
const prodGlobal = fitWeights(pooled);
const prodPosition = Object.fromEntries(positions.map(p => {
  const subset = pooled.filter(r => r.position === p);
  return [p, subset.length >= 200 ? fitWeights(subset) : prodGlobal];
}));
// STORAGE SHAPE IS LOAD-BEARING. `weeklyEnsemblePrediction` does
// `weightSet[context.position]` and expects an array of five numbers; anything
// else makes it return `context.structural` — i.e. silently demote production to
// the single worst head. So a "global" fit is stored as the same array under
// every position, never as a bare array.
const prodWeights = selected.architecture === 'position'
  ? Object.fromEntries(positions.map(p => [p, prodPosition[p]]))
  : Object.fromEntries(positions.map(p => [p, prodGlobal]));
console.log('pooled sample', pooled.length, 'player-weeks');
console.log('production weights:', Object.fromEntries(positions.map(p => [p, named(prodWeights[p])])));
for (const p of positions) {
  const w = prodWeights[p];
  if (!Array.isArray(w) || w.length !== HEADS.length || Math.abs(w.reduce((a, b) => a + b, 0) - 1) > 1e-9) {
    console.error(`REFUSING TO PROMOTE: weights for ${p} are not a convex 5-vector:`, w);
    process.exit(1);
  }
}

// Grade the PRODUCTION path, not the fitting path: same replay, but the head is
// `weeklyEnsemblePrediction` reading exactly what will be in the database.
const prodCheck = replay(2025, { predictionHead: ctx => weeklyEnsemblePrediction(ctx, prodWeights) });
console.log('production-path 2025 MAE', prodCheck.point.model.mae,
  '| spearman', prodCheck.point.model.spearman,
  '| vs season_to_date', prodCheck.point.season_to_date.mae,
  '| vs frozen/60-40', prodCheck.point.blend.mae);
if (!(prodCheck.point.model.mae < prodCheck.point.season_to_date.mae
      && prodCheck.point.model.mae < prodCheck.point.blend.mae)) {
  console.error('REFUSING TO PROMOTE: production path does not beat both baselines on 2025.');
  process.exit(1);
}

if (DRY) { console.log('\n--dry-run: nothing written.'); process.exit(0); }

const saved = saveWeeklyFit({
  data_hash: `phase1a:${selected.architecture}:${HEADS.join('+')}:2023-2025:grid0.05`,
  through_season: 2025, through_week: 18,
  weights: prodWeights,
  sample_size: pooled.length, validation_size: validation.length,
  candidate_mae: prodCheck.point.model.mae, champion_mae: prodCheck.point.blend.mae,
  candidate_spearman: prodCheck.point.model.spearman, champion_spearman: prodCheck.point.blend.spearman,
  coverage_80: candidate.distribution.coverage_80,
  promoted: 1, rejection_reason: null,
});
console.log('saveWeeklyFit:', { inserted: saved.inserted, hash: saved.stored_data_hash, epoch: saved.epoch_id });
const active = activeWeeklyWeightSet({ season: 2026, week: 3 });
console.log('activeWeeklyWeightSet(2026 W3):', { id: active.id, source: active.source, weights: active.weights });
console.log('history rows:', weeklyFitHistory(5).length);
if (active.source !== 'adaptive') { console.error('PROMOTION DID NOT TAKE — still', active.source); process.exit(1); }
// Read it back out of the DB and re-grade, so what production loads is what was graded.
const roundTrip = replay(2025, { predictionHead: ctx => weeklyEnsemblePrediction(ctx, active.weights) });
console.log('round-trip 2025 MAE from the stored row:', roundTrip.point.model.mae);
if (Math.abs(roundTrip.point.model.mae - prodCheck.point.model.mae) > 1e-6) {
  console.error('STORED WEIGHTS DO NOT REPRODUCE THE GRADED MODEL.'); process.exit(1);
}
console.log('\nOK — production now runs the fitted weights.');
