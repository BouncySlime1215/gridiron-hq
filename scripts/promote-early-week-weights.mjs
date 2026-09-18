#!/usr/bin/env node
/**
 * Early-week blend — weeks 2-4 get weights fit for 1, 2 or 3 prior in-season games.
 *
 * THE PROBLEM. The promoted blend (fit-1: 0.20 structural, 0.40 season_to_date, 0.15
 * last3, 0.05 last1, 0.20 median) was fit and graded on weeks 5-18 and applied from
 * week 2. With one prior game the four history heads are all that one score, so 80%
 * of a week-2 projection was last week's box score.
 *
 * THE GATE — pre-registered 2026-09-18 before any candidate was graded (copy in the
 * item's scratch GATE.md). Nothing below may move after results are seen.
 *
 *   Design. Bucket n = in-season games before the predicted week (harness
 *   `prior_weeks`; production `priorWeeks.length`; both from player_week_usage).
 *   Buckets 1-3, applied ONLY in weeks 2-4 (stored `early.weeks = [2, 4]`); 4+ games
 *   or any other week runs the live 5-vector untouched, so weeks 5-18 and the week-1
 *   cold start are identical to live by construction.
 *
 *   Data. replaySeasonWeekly(s, weeks 2-5, no distributions, WEEKLY_ROLE_RECENCY,
 *   production shrinkage constants) for s = 2021..2025; fit and grade on played rows
 *   of weeks 2-4. Weeks 5-18 of 2024 and 2025 are replayed for the identity check.
 *
 *   Candidates.
 *     (a) live fit-1, no early buckets (baseline).
 *     (b) structural only for 1-3 prior games in weeks 2-4.
 *     (c) per-bucket convex weights on the 0.05 grid, minimising MAE. Global across
 *         positions unless per-position wins on the earlier season: for target t, fit
 *         both on 2021..t-2 and grade on t-1; per-position only if its MAE is lower AND
 *         the player-clustered paired bootstrap is significant. Per-position fits a
 *         position only with >= 200 rows in that bucket (else the bucket's global);
 *         a bucket with < 200 rows is structural-only. Then refit on 2021..t-1.
 *     (d) shrinkage: w_structural = k/(n+k), each history head (n/(n+k)) * L_i/(1-L_0)
 *         with L the live vector; one global k on 0.00..100.00 step 0.05.
 *   Walk-forward: validation season s in {2024, 2025} is graded with every fitted
 *   parameter from 2021..s-1 only.
 *
 *   Pass rule, all of it, in BOTH 2024 and 2025 (weeks 2-4, played rows):
 *     G1 beats (a) significantly: pairedBootstrapDiff(err_a, err_cand, {seed 20260918,
 *        groups: player_id, 2000 iterations}) mean_diff < 0 and significant (90% CI
 *        excludes 0).
 *     G2 not worse than (b): MAE_cand <= MAE_b.
 *     G3 weeks 5-18 unchanged: every 2024/2025 week 5-18 context gets a prediction
 *        === live (a)'s (0 mismatches); also for the production set, and
 *        activeWeeklyWeightSet({2026, week 1 and 5-18}) carries no `early`.
 *   Selection: among (b), (d), (c) passing G1-G3, the lowest pooled 2024+2025 MAE;
 *   exact ties to the simpler (b, then d, then c). That choice among PASSING
 *   candidates uses validation data, so margins between them are optimistic. None
 *   passing: nothing is written.
 *
 *   Production fit (only on PASS): refit the chosen candidate on 2021-2025 weeks 2-4
 *   ((c) architecture re-decided on 2025 with fit on 2021-2024), store through
 *   promoteWeeklyFitChecked with a new data_hash, through 2025-W18, promoted; candidate_* /
 *   champion_* are the 2025 held-out figures (candidate fit <= 2024; champion = (a)).
 *   Round trip: the row read back by activeWeeklyWeightSet({2026, week 3}) must
 *   reproduce the graded predictions bit for bit, and live exactly on weeks 5-18;
 *   if it does not, the fit is demoted again before the script exits 1.
 *
 *   Report only: per-week / per-bucket MAE, bias, Spearman, decision MAE with DNP = 0,
 *   start/sit pair accuracy (weeks 2-4 decision rows, same week and position, both
 *   projected >= 4 by every model: one common pair set; ties score 0.5), CRPS and
 *   coverage_80 on 2025 weeks 2-4 for (a), (b) and the shipped candidate.
 *
 * Usage: node scripts/promote-early-week-weights.mjs [--dry-run] [--out results.json] [--baseline-fit 1]
 * --dry-run grades and prints everything, writes nothing.
 * --baseline-fit picks the stored fit whose position vectors are baseline (a), by id
 * (default 1, the fit-1 this gate was graded against). It used to be whatever
 * activeWeeklyWeightSet({2026, week 3}) returned, so a later promotion of new position
 * vectors would have changed (a) without anyone deciding to.
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

export const HEADS = ['structural', 'season_to_date', 'last3', 'last1', 'median'];
export const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
export const EARLY_WEEKS = [2, 4];
export const EARLY_BUCKETS = [1, 2, 3];
export const FIRST_SEASON = 2021;
export const VALIDATION_SEASONS = [2024, 2025];
export const SEED = 20260918;
const MIN_ROWS = 200;
const STRUCTURAL_ONLY = [1, 0, 0, 0, 0];

/** Every convex combination of the five heads on a 0.05 grid (same order as promote-weekly-ensemble.mjs). */
export function weightGrid(step = 0.05) {
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
export const K_GRID = Array.from({ length: 2001 }, (_, i) => i * 0.05);

const perPosition = vector => Object.fromEntries(POSITIONS.map(p => [p, [...vector]]));
const weighted = (w, r) => HEADS.reduce((s, h, i) => s + w[i] * r[h], 0);
const meanOf = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Lowest-MAE grid point; ties keep the first (grid order). */
export function convexGridFit(data, grid = GRID) {
  const n = data.length;
  const cols = HEADS.map(h => Float64Array.from(data, r => r[h]));
  const actual = Float64Array.from(data, r => r.actual);
  const [h0, h1, h2, h3, h4] = cols;
  let best = null, bestMae = Infinity;
  for (const w of grid) {
    const [w0, w1, w2, w3, w4] = w;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      // Same summation order as weighted() / weeklyEnsemblePrediction().
      const pred = 0 + w0 * h0[i] + w1 * h1[i] + w2 * h2[i] + w3 * h3[i] + w4 * h4[i];
      sum += Math.abs(pred - actual[i]);
    }
    const m = sum / n;
    if (m < bestMae) { bestMae = m; best = w; }
  }
  return { weights: best, mae: bestMae };
}

/** (d): structural gets k/(n+k); the history heads split n/(n+k) in the live proportions. */
export function shrinkageVector(live, n, k) {
  const history = live.slice(1).reduce((a, b) => a + b, 0);
  const share = n / (n + k);
  return [1 - share, ...live.slice(1).map(x => share * x / history)];
}

/** One global k for (d), minimising pooled MAE over all early rows. */
export function fitShrinkageK(data, liveByPosition, kGrid = K_GRID) {
  let best = { k: null, mae: Infinity };
  for (const k of kGrid) {
    const vectors = new Map();
    const vectorFor = (position, n) => {
      const key = `${position}|${n}`;
      if (!vectors.has(key)) vectors.set(key, shrinkageVector(liveByPosition[position], n, k));
      return vectors.get(key);
    };
    let sum = 0;
    for (const r of data) sum += Math.abs(weighted(vectorFor(r.position, r.prior_weeks), r) - r.actual);
    const m = sum / data.length;
    if (m < best.mae) best = { k, mae: m };
  }
  return best;
}

/**
 * Start/sit pair accuracy on ONE common pair set: rows in the same week and position
 * where every model projects both players >= threshold. 1 when the higher-projected
 * player scored more, 0 when not, 0.5 when projections or actuals tie.
 */
export function startSitPairAccuracy(rowsIn, models, { threshold = 4 } = {}) {
  const groups = new Map();
  for (const r of rowsIn) {
    if (!models.every(m => r.preds[m] >= threshold)) continue;
    const key = `${r.week}|${r.position}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const score = Object.fromEntries(models.map(m => [m, 0]));
  let pairs = 0;
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const x = list[i], y = list[j];
      pairs++;
      for (const m of models) {
        const px = x.preds[m], py = y.preds[m];
        score[m] += (x.actual === y.actual || px === py) ? 0.5 : ((px > py) === (x.actual > y.actual) ? 1 : 0);
      }
    }
  }
  return { pairs, accuracy: Object.fromEntries(models.map(m => [m, pairs ? score[m] / pairs : null])) };
}

/** G1-G3 for one candidate, per validation season. See the header for the rule. */
export function earlyGateVerdict(bySeason, seasons = VALIDATION_SEASONS) {
  const reasons = [];
  for (const s of seasons) {
    const x = bySeason?.[s];
    if (!x) { reasons.push(`${s}: not graded`); continue; }
    const b = x.vs_live ?? {};
    if (b.error || !(b.mean_diff < 0) || b.significant !== true) {
      reasons.push(`${s}: G1 not significantly better than live (${JSON.stringify(b.error ?? { mean_diff: b.mean_diff, ci90: b.ci90 })})`);
    }
    if (!(x.mae <= x.mae_structural)) reasons.push(`${s}: G2 MAE ${x.mae} worse than structural-only ${x.mae_structural}`);
    if (x.weeks5_18_mismatches !== 0) reasons.push(`${s}: G3 ${x.weeks5_18_mismatches} week 5-18 predictions moved`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** The stored shape: live per-position vectors untouched, early buckets beside them. */
export function buildEarlyWeightSet(liveWeights, buckets, meta = {}) {
  return {
    ...Object.fromEntries(POSITIONS.map(p => [p, liveWeights[p]])),
    early: { ...meta, weeks: [...EARLY_WEEKS], buckets }
  };
}

/** (c) buckets: global per bucket, or per position where a position has the rows. */
export function fitBuckets(train, byPosition) {
  const out = {};
  for (const n of EARLY_BUCKETS) {
    const rowsN = train.filter(r => r.prior_weeks === n);
    const global = rowsN.length >= MIN_ROWS ? convexGridFit(rowsN).weights : STRUCTURAL_ONLY;
    out[n] = Object.fromEntries(POSITIONS.map(p => {
      if (!byPosition || global === STRUCTURAL_ONLY) return [p, [...global]];
      const sub = rowsN.filter(r => r.position === p);
      return [p, [...(sub.length >= MIN_ROWS ? convexGridFit(sub).weights : global)]];
    }));
  }
  return out;
}

async function main() {
  process.env.SCHEDULER_DISABLED = '1';
  const DRY = process.argv.includes('--dry-run');
  const outIdx = process.argv.indexOf('--out');
  const OUT = outIdx > 0 ? process.argv[outIdx + 1] : null;
  const { replaySeasonWeekly } = await import('../server/services/weekly-backtest.js');
  const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');
  const { spearman } = await import('../server/services/backtest.js');
  const { WEEKLY_ROLE_RECENCY, weeklyEnsemblePrediction, weeklyWeightSetForWeek } =
    await import('../server/services/weekly-ensemble.js');
  const { activeWeeklyWeightSet, weeklyWeightSetById, promoteWeeklyFitChecked, validateEarlyWeights } =
    await import('../server/services/weekly-weight-store.js');
  const { dbPath } = await import('../server/db/index.js');

  const report = { db: dbPath, dry_run: DRY, gate: 'see header', seasons: {} };
  const baselineIdx = process.argv.indexOf('--baseline-fit');
  const live = weeklyWeightSetById(baselineIdx > 0 ? Number(process.argv[baselineIdx + 1]) : 1);
  // Baseline (a) is the per-position vectors only, even if an early block is already live.
  const liveWeights = Object.fromEntries(POSITIONS.map(p => [p, live.weights[p]]));
  for (const p of POSITIONS) {
    if (!Array.isArray(liveWeights[p]) || liveWeights[p].length !== HEADS.length) {
      throw new Error(`live set ${live.id} has no 5-vector for ${p}`);
    }
  }
  report.live = { id: live.id, source: live.source, weights: liveWeights, already_has_early: !!live.weights.early };
  console.log(`db ${dbPath}\nlive (a): ${live.id} (${live.source})`, JSON.stringify(liveWeights.WR),
    live.weights.early ? '| NOTE: active set already carries early buckets; (a) uses its position vectors only' : '');

  const predict = (set, ctx) => weeklyEnsemblePrediction(ctx, set);
  const key = x => `${x.player_id}|${x.week}`;
  function replayCapture(season, startWeek, endWeek) {
    const contexts = new Map();
    const r = replaySeasonWeekly(season, {
      startWeek, endWeek, distributions: false, roleRecency: WEEKLY_ROLE_RECENCY,
      predictionHead: ctx => { contexts.set(key(ctx), ctx); return predict(liveWeights, ctx); }
    });
    return { played: r._predictions, decision: r._decision_rows, contexts, point: r.point };
  }

  const early = {};
  for (let s = FIRST_SEASON; s <= 2025; s++) {
    const r = replayCapture(s, 2, 5);
    early[s] = { ...r, rows: r.played.filter(x => x.week >= EARLY_WEEKS[0] && x.week <= EARLY_WEEKS[1]) };
    console.log(`replayed ${s} weeks 2-5: ${early[s].rows.length} graded week 2-4 rows`);
  }
  const late = {};
  for (const s of VALIDATION_SEASONS) {
    late[s] = replayCapture(s, 5, 18);
    console.log(`replayed ${s} weeks 5-18: ${late[s].contexts.size} contexts; live MAE ${late[s].point.model.mae}`);
  }
  // TRAINING rows only: QB/RB/WR/TE. Any other position has no vector, so every
  // candidate (and live) predicts it with the bare structural head; it stays in the
  // graded rows (identical under every model) but would only distort a fit.
  const rowsFor = (from, to) => {
    const out = [];
    for (let s = from; s <= to; s++) out.push(...early[s].rows.filter(r => POSITIONS.includes(r.position)));
    return out;
  };

  const B = buildEarlyWeightSet(liveWeights, Object.fromEntries(EARLY_BUCKETS.map(n => [n, perPosition(STRUCTURAL_ONLY)])),
    { candidate: 'b' });
  function chooseArchitecture(target) {
    const archTrain = rowsFor(FIRST_SEASON, target - 2), archEval = early[target - 1].rows;
    const g = buildEarlyWeightSet(liveWeights, fitBuckets(archTrain, false));
    const p = buildEarlyWeightSet(liveWeights, fitBuckets(archTrain, true));
    const eg = archEval.map(r => Math.abs(predict(g, r) - r.actual));
    const ep = archEval.map(r => Math.abs(predict(p, r) - r.actual));
    const boot = pairedBootstrapDiff(eg, ep, { seed: SEED, groups: archEval.map(r => r.player_id) });
    const position = meanOf(ep) < meanOf(eg) && boot.significant === true && boot.mean_diff < 0;
    return { architecture: position ? 'position' : 'global', decided_on: target - 1,
      fit_on: [FIRST_SEASON, target - 2], mae_global: +meanOf(eg).toFixed(4), mae_position: +meanOf(ep).toFixed(4),
      ci90: boot.ci90 };
  }
  function fitC(target) {
    const arch = chooseArchitecture(target);
    const buckets = fitBuckets(rowsFor(FIRST_SEASON, target - 1), arch.architecture === 'position');
    return { set: buildEarlyWeightSet(liveWeights, buckets, { candidate: 'c', architecture: arch.architecture }), arch };
  }
  function fitD(target) {
    const fit = fitShrinkageK(rowsFor(FIRST_SEASON, target - 1), liveWeights);
    const buckets = Object.fromEntries(EARLY_BUCKETS.map(n => [n,
      Object.fromEntries(POSITIONS.map(p => [p, shrinkageVector(liveWeights[p], n, fit.k)]))]));
    return { set: buildEarlyWeightSet(liveWeights, buckets, { candidate: 'd', k: fit.k }), k: fit.k,
      k_at_grid_edge: fit.k === K_GRID.at(-1) };
  }
  const mismatches5to18 = (set, season) => {
    let n = 0;
    for (const ctx of late[season].contexts.values()) if (predict(set, ctx) !== predict(liveWeights, ctx)) n++;
    return n;
  };

  const verdictInput = { b: {}, c: {}, d: {} };
  const pooledErr = { a: [], b: [], c: [], d: [] };
  const validationSets = {};
  for (const s of VALIDATION_SEASONS) {
    const c = fitC(s), d = fitD(s);
    const sets = { a: liveWeights, b: B, c: c.set, d: d.set };
    validationSets[s] = sets;
    const val = early[s].rows;
    const groups = val.map(r => r.player_id);
    const err = Object.fromEntries(Object.entries(sets).map(([m, set]) => [m, val.map(r => Math.abs(predict(set, r) - r.actual))]));
    const mae = Object.fromEntries(Object.entries(err).map(([m, e]) => [m, meanOf(e)]));
    for (const m of Object.keys(pooledErr)) pooledErr[m].push(...err[m]);
    const perModel = {};
    for (const [m, set] of Object.entries(sets)) {
      const byWeek = {}, byBucket = {};
      for (const w of [2, 3, 4]) { const sub = val.filter(r => r.week === w); byWeek[w] = +meanOf(sub.map(r => Math.abs(predict(set, r) - r.actual))).toFixed(3); }
      for (const n of EARLY_BUCKETS) { const sub = val.filter(r => r.prior_weeks === n); byBucket[n] = { n: sub.length, mae: +meanOf(sub.map(r => Math.abs(predict(set, r) - r.actual))).toFixed(3) }; }
      const decision = early[s].decision.filter(x => x.week <= EARLY_WEEKS[1]);
      const decisionMae = meanOf(decision.map(x => Math.abs(predict(set, early[s].contexts.get(key(x))) - x.actual)));
      perModel[m] = {
        mae: +mae[m].toFixed(4), bias: +meanOf(val.map(r => predict(set, r) - r.actual)).toFixed(3),
        spearman: spearman(val.map(r => ({ pred: predict(set, r), act: r.actual }))),
        mae_by_week: byWeek, mae_by_bucket: byBucket, decision_mae_dnp0: +decisionMae.toFixed(4)
      };
      if (m !== 'a') {
        const boot = pairedBootstrapDiff(err.a, err[m], { seed: SEED, groups });
        perModel[m].vs_live = boot;
        perModel[m].weeks5_18_mismatches = mismatches5to18(set, s);
        verdictInput[m][s] = { vs_live: boot, mae: mae[m], mae_structural: mae.b, weeks5_18_mismatches: perModel[m].weeks5_18_mismatches };
      }
    }
    const decisionRows = early[s].decision.filter(x => x.week <= EARLY_WEEKS[1]).map(x => ({
      week: x.week, position: x.position, actual: x.actual,
      preds: Object.fromEntries(Object.entries(sets).map(([m, set]) => [m, predict(set, early[s].contexts.get(key(x)))]))
    }));
    const pairs = startSitPairAccuracy(decisionRows, Object.keys(sets));
    report.seasons[s] = { n: val.length, players: new Set(groups).size, models: perModel, start_sit_pairs: pairs,
      c_architecture: c.arch, c_weights: c.set.early.buckets, d_k: d.k, d_k_at_grid_edge: d.k_at_grid_edge };
    console.log(`\n=== ${s} weeks 2-4 (fit on ${FIRST_SEASON}-${s - 1}; ${val.length} player-weeks, ${new Set(groups).size} players) ===`);
    console.table(Object.fromEntries(Object.entries(perModel).map(([m, x]) => [m, {
      mae: x.mae, bias: x.bias, spearman: x.spearman, 'wk2': x.mae_by_week[2], 'wk3': x.mae_by_week[3], 'wk4': x.mae_by_week[4],
      'decision(DNP=0)': x.decision_mae_dnp0, 'pair acc': +pairs.accuracy[m].toFixed(4),
      'vs a diff': x.vs_live ? +x.vs_live.mean_diff.toFixed(4) : '', 'ci90': x.vs_live ? x.vs_live.ci90?.map(v => +v.toFixed(4)).join('..') : '',
      'sig': x.vs_live ? x.vs_live.significant : '', '5-18 moved': x.weeks5_18_mismatches ?? ''
    }])));
    console.log(`start/sit pairs: ${pairs.pairs}; (c) architecture ${c.arch.architecture} (decided on ${c.arch.decided_on}: global ${c.arch.mae_global} vs position ${c.arch.mae_position}); (d) k = ${d.k}`);
  }

  const verdicts = Object.fromEntries(['b', 'd', 'c'].map(m => [m, earlyGateVerdict(verdictInput[m])]));
  const pooled = Object.fromEntries(Object.entries(pooledErr).map(([m, e]) => [m, meanOf(e)]));
  let chosen = null;
  for (const m of ['b', 'd', 'c']) {
    if (!verdicts[m].pass) continue;
    if (!chosen || pooled[m] < pooled[chosen] - 1e-12) chosen = m;
  }
  report.verdicts = verdicts;
  report.pooled_mae = Object.fromEntries(Object.entries(pooled).map(([m, v]) => [m, +v.toFixed(4)]));
  report.chosen = chosen;
  console.log('\npooled 2024+2025 weeks 2-4 MAE:', report.pooled_mae);
  for (const [m, v] of Object.entries(verdicts)) console.log(`(${m}) ${v.pass ? 'PASS' : 'FAIL'}`, v.reasons.join(' | '));

  // Report only: distributions on 2025 weeks 2-4.
  const distFor = set => {
    const r = replaySeasonWeekly(2025, { startWeek: 2, endWeek: 4, distributions: true, runs: 200,
      roleRecency: WEEKLY_ROLE_RECENCY, predictionHead: ctx => predict(set, ctx) });
    return { mae: r.point.model.mae, crps: r.distribution.crps, coverage_80: r.distribution.coverage_80 };
  };
  report.distribution_2025 = { a: distFor(liveWeights), b: distFor(B) };
  if (chosen && chosen !== 'b') report.distribution_2025[chosen] = distFor(validationSets[2025][chosen]);
  console.log('2025 weeks 2-4 distributions (report only):', JSON.stringify(report.distribution_2025));

  const writeReport = () => { if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); };
  if (!chosen) {
    console.log('\nGATE FAILED for every candidate — nothing promoted, production keeps the live blend in weeks 2-4.');
    writeReport();
    process.exit(1);
  }
  console.log(`\nGATE PASSED: (${chosen}). Production fit on ${FIRST_SEASON}-2025 weeks 2-4.`);

  const prodTrain = rowsFor(FIRST_SEASON, 2025);
  let prod, prodMeta;
  if (chosen === 'b') { prod = B; prodMeta = {}; }
  if (chosen === 'c') { const c = fitC(2026); prod = c.set; prodMeta = { architecture: c.arch }; }
  if (chosen === 'd') { const d = fitD(2026); prod = d.set; prodMeta = { k: d.k }; }
  prod = buildEarlyWeightSet(liveWeights, prod.early.buckets, {
    ...prod.early, candidate: chosen, fit_seasons: [FIRST_SEASON, 2025], fit_rows: prodTrain.length,
    gate: 'scripts/promote-early-week-weights.mjs header'
  });
  validateEarlyWeights(prod.early);
  report.production = { weights: prod, meta: prodMeta };
  console.log('production early buckets:', JSON.stringify(prod.early.buckets));

  // Pre-save round trip: exactly what the store will serve (JSON, then the week window).
  const stored = JSON.parse(JSON.stringify(prod));
  const served = week => weeklyWeightSetForWeek(stored, week);
  for (const s of VALIDATION_SEASONS) {
    const moved = mismatches5to18(prod, s) + mismatches5to18(served(5), s);
    if (moved) { console.error(`REFUSING TO PROMOTE: production set moves ${moved} week 5-18 predictions in ${s}.`); process.exit(1); }
  }
  const early2025 = [...early[2025].contexts.values()].filter(c => c.week <= EARLY_WEEKS[1]);
  const graded = early2025.map(c => predict(prod, c));
  const viaStore = early2025.map(c => predict(served(c.week), c));
  if (graded.some((v, i) => v !== viaStore[i])) { console.error('REFUSING TO PROMOTE: stored shape does not reproduce the graded predictions.'); process.exit(1); }
  const inSample = meanOf(early[2025].rows.map(r => Math.abs(predict(prod, r) - r.actual)));
  console.log(`production set on 2025 weeks 2-4 (IN-SAMPLE, not evidence): MAE ${inSample.toFixed(4)}`);

  if (DRY) { writeReport(); console.log('\n--dry-run: nothing written.'); process.exit(0); }

  const held = report.seasons[2025].models;
  // Post-save round trip through the real store. A failure (or a throw) demotes the fit
  // before the script exits (weekly-weight-store.js#promoteWeeklyFitChecked).
  let active = null;
  const result = promoteWeeklyFitChecked({
    data_hash: `early-week:${chosen}:${prod.early.architecture ?? (chosen === 'd' ? `k${prod.early.k}` : 'fixed')}` +
      `:buckets1-3:weeks${EARLY_WEEKS.join('-')}:${FIRST_SEASON}-2025:grid0.05:live-${live.id}`,
    through_season: 2025, through_week: 18, weights: prod,
    // Held-out 2025 weeks 2-4 (candidate fit on <= 2024; champion = live (a)). These
    // describe WEEKS 2-4, not the weeks 5-18 figures fit-1's row carries.
    sample_size: prodTrain.length, validation_size: report.seasons[2025].n,
    candidate_mae: held[chosen].mae, champion_mae: held.a.mae,
    candidate_spearman: held[chosen].spearman, champion_spearman: held.a.spearman,
    coverage_80: report.distribution_2025[chosen]?.coverage_80 ?? null,
    rejection_reason: null
  }, saved => {
    report.saved = { inserted: saved.inserted, stored_data_hash: saved.stored_data_hash, epoch_id: saved.epoch_id };
    console.log('saveWeeklyFit:', report.saved);
    const failures = [];
    active = activeWeeklyWeightSet({ season: 2026, week: 3 });
    if (active.fit?.data_hash !== saved.stored_data_hash) failures.push(`active week-3 set is ${active.id} (${active.fit?.data_hash}), not the new row`);
    if (JSON.stringify(active.weights.early) !== JSON.stringify(stored.early)) failures.push('stored early block differs from the graded one');
    for (const week of [1, 5, 10, 18]) {
      const w = activeWeeklyWeightSet({ season: 2026, week }).weights;
      if (w.early) failures.push(`week ${week} set carries early`);
      for (const p of POSITIONS) if (JSON.stringify(w[p]) !== JSON.stringify(liveWeights[p])) failures.push(`week ${week} ${p} vector changed`);
    }
    for (const week of [2, 4]) if (!activeWeeklyWeightSet({ season: 2026, week }).weights.early) failures.push(`week ${week} set lacks early`);
    const readBack = early2025.map(c => predict(activeWeeklyWeightSet({ season: 2026, week: c.week }).weights, c));
    if (readBack.some((v, i) => v !== graded[i])) failures.push('read-back weeks 2-4 predictions differ from graded');
    for (const s of VALIDATION_SEASONS) { const moved = mismatches5to18(active.weights, s); if (moved) failures.push(`${s}: ${moved} week 5-18 predictions moved via the week-3 set`); }
    const harness = replaySeasonWeekly(2025, { startWeek: 2, endWeek: 4, distributions: false, roleRecency: WEEKLY_ROLE_RECENCY,
      predictionHead: ctx => predict(activeWeeklyWeightSet({ season: 2026, week: 3 }).weights, ctx) });
    if (Math.abs(harness.point.model.mae - +inSample.toFixed(3)) > 0.0005) failures.push(`harness MAE ${harness.point.model.mae} vs graded ${inSample.toFixed(4)}`);
    return failures;
  });
  report.round_trip = { active_id: active?.id ?? null, failures: result.failures, demoted: result.demoted };
  writeReport();
  if (!result.ok) {
    console.error('STORED WEIGHTS DO NOT REPRODUCE THE GRADED MODEL:', result.failures);
    console.error(`Demoted ${result.saved.stored_data_hash} (promoted=0); it is no longer served.`);
    process.exit(1);
  }
  console.log(`\nOK — ${active.id} serves early-week buckets in weeks 2-4; weeks 1 and 5-18 unchanged.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
