#!/usr/bin/env node
/**
 * Phase 1a — stop production running frozen 2023 weights that lose to a moving average.
 *
 * `activeWeeklyWeightSet()` falls back to the hardcoded `WEEKLY_ENSEMBLE_WEIGHTS`
 * because `weekly_ensemble_fits` is empty. Measured 2026-09-17 on the 2025
 * walk-forward: frozen WEEKLY_ENSEMBLE_WEIGHTS 4.425 MAE, season_to_date 4.386,
 * fitted 4.334. Production is losing to a naive average and a validated fit was
 * never persisted.
 *
 * CORRECTION, 2026-09-17. This header and the first stored row (id=1) used to call
 * 4.455 "frozen" / "PRODUCTION today". 4.455 is the harness's fixed 0.6*structural +
 * 0.4*season_to_date blend, which production never ran. The weights production
 * actually ran — per-position WEEKLY_ENSEMBLE_WEIGHTS — score 4.425 on the same
 * 4,532 rows (2023 4.361, 2024 4.549). The real displacement gain is therefore
 * 0.095, not the 0.125 recorded, i.e. the headline was overstated by about a third.
 * The script now grades the champion that was legitimately live before the
 * validation window and stores THAT as champion_mae; the 60/40 blend is kept only
 * as what it is, a trivial baseline.
 *
 * THE WEIGHTS ARE A PLATEAU, NOT A POINT. On pooled 2023-2025 the best grid point
 * scores 4.34629 and the 50th-best 4.34941: the top-50 spread is 0.003 MAE (0.07%),
 * 105 grid points sit within 0.005 of the best, and across the top 50
 * season_to_date ranges 0.25-0.55, median 0.10-0.35, last3 0.05-0.20. Read
 * "[0.20, 0.40, 0.15, 0.05, 0.20]" as one arbitrary point in that plateau; a
 * sentence of the form "season_to_date gets 0.40" is reading the grid, not the data.
 * The script now prints the top-50 range beside each component.
 *
 * AND THE HEADS ARE NEARLY ONE SIGNAL. Four of the five heads re-weight the same
 * series — the player's own prior fantasy points. Pooled 2023-25 (n=13,340),
 * PC1 of the 5x5 correlation matrix explains 86% of the variance and the effective
 * rank (exp of the spectral entropy) is 1.74. Structural + season_to_date alone
 * score 4.3703; adding last3, last1 and median buys 0.024 more. The five-head list
 * was chosen by hand and has never itself been selected on a holdout.
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
import { activeKVector, fitAllK, toKVector, fitHistory } from '../server/services/shrinkage-fit.js';
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';
import { spearman } from '../server/services/backtest.js';
import { WEEKLY_ROLE_RECENCY, weeklyEnsemblePrediction } from '../server/services/weekly-ensemble.js';
import { saveWeeklyFit, activeWeeklyWeightSet, weeklyFitHistory } from '../server/services/weekly-weight-store.js';

const DRY = process.argv.includes('--dry-run');
const HEADS = ['structural', 'season_to_date', 'last3', 'last1', 'median'];
// Harness settings match scripts/fit-weekly-ensemble.mjs, with ONE deliberate
// difference: the 2024 discovery baseline below is season_to_date, where that
// script used the 60/40 blend. On 2024 those are 4.4505 and 4.5752 — a 0.125 MAE
// difference in the bar — so this is a tightening, not a reproduction. The
// selection is unchanged either way (both baselines select `global`); this
// comment used to claim exact reproduction, which was false.
const common = {
  startWeek: 5, endWeek: 18, distributions: false,
  roleRecency: WEEKLY_ROLE_RECENCY,
};
// SHRINKAGE CONSTANTS, WALK-FORWARD. The active fitted k-vector is estimated on
// seasons <= 2025, so grading 2023-2025 heads with it would let each season's
// constants see that season. For every graded season s, the SAME (metric,
// position) pairs the active vector carries are re-fit on seasons <= s-1. With no
// active fit this is null for every season, i.e. the hand-picked constants.
const ACTIVE_K = activeKVector();
const ACTIVE_K_FIT = ACTIVE_K ? fitHistory(50).find(f => f.active === 1)?.id ?? null : null;
const kCache = new Map();
function kFor(season) {
  if (!ACTIVE_K) return null;
  if (!kCache.has(season)) {
    const want = new Set(Object.entries(ACTIVE_K).flatMap(([m, byPos]) => Object.keys(byPos).map(p => `${m}|${p}`)));
    const fits = fitAllK(season - 1)
      .filter(r => want.has(`${r.metric}|${r.position}`) && r.k != null && !Number.isNaN(r.k));
    if (fits.length !== want.size) throw new Error(`walk-forward refit for ${season} produced ${fits.length} of ${want.size} k`);
    kCache.set(season, toKVector(fits));
  }
  return kCache.get(season);
}
console.log('shrinkage constants:', ACTIVE_K ? `active fit #${ACTIVE_K_FIT}, re-fit walk-forward per season` : 'hand-picked (no active fit)');
const replay = (season, extra = {}) => replaySeasonWeekly(season, { ...common, kOverride: kFor(season), ...extra });
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

/**
 * The top-k grid points and each head's range across them. The MAE surface is flat
 * enough near its minimum that the argmin alone is not a statement about the data;
 * this is the statement that is.
 */
function plateau(data, k = 50) {
  const scored = GRID.map(w => ({ w, m: mae(data, r => weighted(w, r)) })).sort((a, b) => a.m - b.m);
  const top = scored.slice(0, k);
  const range = Object.fromEntries(HEADS.map((h, i) => {
    const vals = top.map(t => t.w[i]);
    return [h, [+Math.min(...vals).toFixed(2), +Math.max(...vals).toFixed(2)]];
  }));
  return {
    best_mae: +top[0].m.toFixed(5), kth_mae: +top.at(-1).m.toFixed(5),
    top_k_spread: +(top.at(-1).m - top[0].m).toFixed(5),
    within_0_005: scored.filter(t => t.m - top[0].m <= 0.005).length,
    range_across_top_k: range
  };
}

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
// Say plainly what this step bought. It was a choice between exactly two
// architectures, decided on 2024 by a margin (global 4.4284 vs position 4.4310,
// 0.0026 MAE) well inside the noise of a difference on ~4,400 player-weeks. What
// 2024 established is that SOME convex blend of these heads beats the baselines —
// the family — not that `global` is the right architecture, and not that the
// five-head set is right; the head set was chosen by hand and never selected on a
// holdout.
console.log('architecture margin on 2024 (MAE):', Object.fromEntries(Object.entries(predictors)
  .map(([a, p]) => [a, +mae(discovery, p).toFixed(4)])));

const weightsFor = r => (selected.architecture === 'position'
  ? (positionWeights[r.position] ?? globalWeights) : globalWeights);
const predictionHead = ctx => {
  const row = HEADS.reduce((acc, h) => ({ ...acc, [h]: ctx[h] }), { position: ctx.position });
  return weighted(weightsFor(row), row);
};

const candidate = replay(2025, { distributions: true, runs: 300, predictionHead });
const structural = replay(2025, { distributions: true, runs: 300 });
// Cluster the bootstrap by player. The 4,532 rows are ~560 players observed over
// up to 14 weeks each, not 4,532 independent draws, and backtest-significance.js's
// own docstring cites the NFL bootstrap literature on exactly this. Measured on
// 2025, player clustering widens the 90% interval by ~30%. `_predictions` is built
// in lockstep with `_errors` inside the replay, so the length guard accepts it.
const groups = candidate._predictions.map(r => r.player_id);
const boot = { seed: 20260830, groups };
const vsStd = pairedBootstrapDiff(candidate._errors.season_to_date, candidate._errors.model, boot);
const vsBlend = pairedBootstrapDiff(candidate._errors.blend, candidate._errors.model, boot);
// The champion this promotion would actually DISPLACE: whatever was legitimately
// live before the 2025 validation window. Grading against the 60/40 blend alone let
// the record claim a win over a model production never ran.
const displaced = activeWeeklyWeightSet({ season: 2025, week: common.startWeek });
const championErrors = candidate._predictions.map(r => Math.abs(weeklyEnsemblePrediction(r, displaced.weights) - r.actual));
const championMae = championErrors.reduce((a, b) => a + b, 0) / championErrors.length;
const championSpearman = rankOf(candidate._predictions, r => weeklyEnsemblePrediction(r, displaced.weights));
const vsChampion = pairedBootstrapDiff(championErrors, candidate._errors.model, boot);
console.table([
  { model: 'structural', mae: structural.point.model.mae, spearman: structural.point.model.spearman,
    crps: structural.distribution.crps, coverage: structural.distribution.coverage_80 },
  { model: `ensemble_${selected.architecture}`, mae: candidate.point.model.mae,
    spearman: candidate.point.model.spearman, crps: candidate.distribution.crps,
    coverage: candidate.distribution.coverage_80 },
  { model: `displaced champion (${displaced.id})`, mae: +championMae.toFixed(3), spearman: championSpearman },
  { model: 'season_to_date', ...candidate.point.season_to_date },
  { model: 'fixed_60_40 (trivial baseline, never shipped)', ...candidate.point.blend },
]);
const beatsBoth = vsStd.mean_diff < 0 && vsStd.significant && vsBlend.mean_diff < 0 && vsBlend.significant
  && vsChampion.mean_diff < 0 && vsChampion.significant;
const rankOk = candidate.point.model.spearman >= Math.max(candidate.point.season_to_date.spearman, candidate.point.blend.spearman);
const coverageOk = candidate.distribution.coverage_80 >= 0.78 && candidate.distribution.coverage_80 <= 0.82;
const crpsOk = candidate.distribution.crps <= structural.distribution.crps;
const gate = beatsBoth && rankOk && coverageOk && crpsOk;
console.log(JSON.stringify({
  validation_gate: gate ? 'PASS' : 'FAIL', architecture: selected.architecture,
  beats_baselines_and_displaced_champion_significantly: beatsBoth, rank_not_degraded: rankOk,
  coverage_in_0_78_0_82: coverageOk, crps_not_degraded: crpsOk,
  vs_season_to_date: vsStd, vs_fixed_60_40: vsBlend, vs_displaced_champion: vsChampion,
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
console.log('pooled plateau (report this, not just the argmin):', JSON.stringify(plateau(pooled)));
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
//
// This number is IN-SAMPLE. prodWeights were fit on a pool that contains every one
// of these 2025 rows, so "beats both baselines on 2025" here is close to a
// tautology — both baselines are fixed points inside the grid's own search space,
// and the argmin beats them by construction. It is printed for the round-trip
// check below, not as evidence. The check that can actually fail is the next one.
const prodCheck = replay(2025, { predictionHead: ctx => weeklyEnsemblePrediction(ctx, prodWeights) });
console.log('production-path 2025 MAE (IN-SAMPLE)', prodCheck.point.model.mae,
  '| spearman', prodCheck.point.model.spearman,
  '| vs season_to_date', prodCheck.point.season_to_date.mae,
  '| vs 60/40 baseline', prodCheck.point.blend.mae);

// A genuinely held-out refusal: the same architecture fit on 2023+2024 only and
// scored on 2025. Measured optimism of the pooled fit is ~0.008, so this is the
// honest version of the production number.
const heldOutPool = [...train, ...discovery];
const heldOutGlobal = fitWeights(heldOutPool);
const heldOutPosition = Object.fromEntries(positions.map(p => {
  const subset = heldOutPool.filter(r => r.position === p);
  return [p, subset.length >= 200 ? fitWeights(subset) : heldOutGlobal];
}));
const heldOutWeightsFor = r => (selected.architecture === 'position'
  ? (heldOutPosition[r.position] ?? heldOutGlobal) : heldOutGlobal);
const heldOutMae = mae(validation, r => weighted(heldOutWeightsFor(r), r));
const stdMae = mae(validation, r => r.season_to_date);
const blendMae = mae(validation, r => r.blend);
console.log('HELD-OUT 2025 (fit 2023+2024):', heldOutMae.toFixed(4), '| season_to_date', stdMae.toFixed(4),
  '| 60/40', blendMae.toFixed(4), '| displaced champion', championMae.toFixed(4));
if (!(heldOutMae < stdMae && heldOutMae < blendMae && heldOutMae < championMae)) {
  console.error('REFUSING TO PROMOTE: the architecture, fit without 2025, does not beat the baselines and the displaced champion on held-out 2025.');
  process.exit(1);
}

if (DRY) { console.log('\n--dry-run: nothing written.'); process.exit(0); }

const saved = saveWeeklyFit({
  data_hash: `phase1a:${selected.architecture}:${HEADS.join('+')}:2023-2025:grid0.05:k${ACTIVE_K_FIT ?? 'hand'}`,
  through_season: 2025, through_week: 18,
  weights: prodWeights,
  // candidate_* and validation_size are the GATE's held-out 2025 figures (fit on
  // 2023 only), which is what the column names claim. They used to hold the
  // in-sample production-path replay, a validation label on a training number.
  // champion_* is the champion this promotion displaced, not the 60/40 baseline.
  sample_size: pooled.length, validation_size: candidate.point.model.n,
  candidate_mae: candidate.point.model.mae, champion_mae: +championMae.toFixed(3),
  candidate_spearman: candidate.point.model.spearman, champion_spearman: championSpearman,
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
