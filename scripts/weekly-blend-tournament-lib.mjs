/**
 * BLEND-01 study library: the fits, grades, selection rule and ship rule of the pre-registered
 * blend tournament (docs/evidence/2026-09-22/weekly-blend-tournament-preregistration.md).
 *
 * This file produces no served number. Every candidate's number comes from the served module
 * (server/services/weekly-blend.js blendWeekPoints), so the grade grades what would be served.
 * Reused, never copied: constrainedLeastSquares (forecast-combination.js:159) for fitted
 * weights, startSitPairAccuracy (promote-early-week-weights.mjs:153) and S-02's
 * decisionWinRate (weekly-construction-grade-lib.mjs:196) as parity checks on this file's own
 * pair enumeration, and S-02's mde80.
 *
 * Sign convention: every difference is candidate − reference; positive favours the candidate
 * (pair accuracy, win rate, points per decision). MAE differences are candidate − reference
 * too, so there a NEGATIVE value favours the candidate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { constrainedLeastSquares } from '../server/services/forecast-combination.js';
import { blendWeekPoints, CANDIDATES, PHASES, phaseFor, BLEND_POSITIONS } from '../server/services/weekly-blend.js';
import { startSitPairAccuracy } from './promote-early-week-weights.mjs';
import { decisionWinRate, mde80 } from './weekly-construction-grade-lib.mjs';

export const THRESHOLD = 4;
export const ITERATIONS = 2000;
export const SEED = 1;
export const FIT_SEASONS_FOR = Object.freeze({ 2023: [2022], 2024: [2022, 2023] });
export const GRADED_SEASONS = Object.freeze([2023, 2024]);
export const SHIP_FIT_SEASONS = Object.freeze([2022, 2023, 2024]);
/** The pre-registered ladder (§6.3); equal numbers are one rung. */
export const LADDER = Object.freeze(Object.fromEntries(Object.entries(CANDIDATES).map(([k, v]) => [k, v.ladder])));
export const CANDIDATE_IDS = Object.freeze(Object.keys(CANDIDATES));
const POSITIONS = [...BLEND_POSITIONS];

/* ------------------------------------------------------------------ small helpers */

const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/** A seeded uniform generator (mulberry32), so a bootstrap is reproducible from its seed. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distinct season-weeks: the forecast periods T in the Stock-Watson shrinkage. */
export function slates(rows) {
  return new Set(rows.map(r => `${r.season}|${r.week}`)).size;
}

/** Stock & Watson (2004) weight on the estimated vector: max(0, min(1, 1 - kappa K / (T - K - 1))). */
export function stockWatsonLambda(T, { kappa = 1, K = 2 } = {}) {
  const denom = T - K - 1;
  if (!(denom > 0)) return 0;
  return Math.max(0, Math.min(1, 1 - (kappa * K) / denom));
}

/** The fit rows (§3): decision rows with an ESPN value and ours >= 4. Byes have ours 0, so they drop. */
export function fitRowsOf(rows, threshold = THRESHOLD) {
  return rows.filter(r => r.espn != null && Number.isFinite(r.espn) && r.ours >= threshold && BLEND_POSITIONS.has(r.position));
}

/* ------------------------------------------------------------------ fits (C4, C5, C6) */

/** Simplex least squares of the actual on [ours, espn]; the share on ours. */
export function simplexWeight(rows) {
  if (!rows.length) return null;
  const w = constrainedLeastSquares(rows.map(r => [r.ours, r.espn]), rows.map(r => r.actual));
  return w ? w[0] : null;
}

/** C4: w_hat shrunk toward 0.5 by the Stock-Watson lambda, T = slates. */
export function fitShrunkWeight(rows, { target = 0.5 } = {}) {
  const wHat = simplexWeight(rows);
  const T = slates(rows);
  const lambda = stockWatsonLambda(T);
  const w = wHat == null ? target : lambda * wHat + (1 - lambda) * target;
  return { w, w_hat: wHat, lambda, T, n: rows.length };
}

/** C5: per position x phase, the cell's w_hat shrunk toward the pooled C4 weight. */
export function fitPosPhase(rows, pooled) {
  const w = {}, cells = {};
  for (const pos of POSITIONS) {
    w[pos] = {}; cells[pos] = {};
    for (const phase of PHASES) {
      const inCell = rows.filter(r => r.position === pos && phaseFor(r.week) === phase);
      const fit = fitShrunkWeight(inCell, { target: pooled });
      w[pos][phase] = fit.w;
      cells[pos][phase] = { n: fit.n, T: fit.T, w_hat: r4(fit.w_hat), lambda: r4(fit.lambda), w: r4(fit.w) };
    }
  }
  return { w, pooled, cells };
}

/** The encompassing slope b = sum(x y) / sum(x^2), x = ours - espn, y = actual - espn. */
export function disagreementSlope(rows) {
  let sxy = 0, sxx = 0;
  for (const r of rows) { const x = r.ours - r.espn; sxy += x * (r.actual - r.espn); sxx += x * x; }
  return sxx > 0 ? sxy / sxx : null;
}

/** Player-clustered bootstrap of disagreementSlope: players resampled with replacement. */
export function slopeCi(rows, { iterations = ITERATIONS, seed = SEED } = {}) {
  const byPlayer = new Map();
  for (const r of rows) {
    const x = r.ours - r.espn;
    const cur = byPlayer.get(r.player_id) ?? { sxy: 0, sxx: 0 };
    cur.sxy += x * (r.actual - r.espn); cur.sxx += x * x;
    byPlayer.set(r.player_id, cur);
  }
  const players = [...byPlayer.values()];
  const n = players.length;
  if (n < 2) return null;
  const rand = seededRandom(seed);
  const draws = [];
  for (let it = 0; it < iterations; it++) {
    let sxy = 0, sxx = 0;
    for (let k = 0; k < n; k++) { const p = players[Math.floor(rand() * n)]; sxy += p.sxy; sxx += p.sxx; }
    if (sxx > 0) draws.push(sxy / sxx);
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.05 * (draws.length - 1))], draws[Math.ceil(0.95 * (draws.length - 1))]];
}

/** C6: per cell, b = clamp(b_hat, 0, 1) when its 90% CI's lower bound is above 0, else 0. */
export function fitEspnProven(rows, { iterations = ITERATIONS, seed = SEED } = {}) {
  const b = {}, cells = {};
  for (const pos of POSITIONS) {
    b[pos] = {}; cells[pos] = {};
    for (const phase of PHASES) {
      const inCell = rows.filter(r => r.position === pos && phaseFor(r.week) === phase);
      const bHat = disagreementSlope(inCell);
      const ci = bHat == null ? null : slopeCi(inCell, { iterations, seed });
      const proven = Boolean(ci && ci[0] > 0);
      b[pos][phase] = proven ? Math.max(0, Math.min(1, bHat)) : 0;
      cells[pos][phase] = { n: inCell.length, b_hat: r4(bHat), ci90: ci ? ci.map(r4) : null, proven,
        clears_plan_bar_0_3: bHat != null && bHat > 0.3, b: r4(b[pos][phase]) };
    }
  }
  return { b, cells };
}

/** Every fitted candidate's parameters from one set of fit rows. */
export function fitCandidates(rows, opts = {}) {
  const fit = fitRowsOf(rows);
  if (!fit.length) throw new Error('no fit rows (a known-nonzero count is required before fitting)');
  const c4 = fitShrunkWeight(fit);
  return {
    n: fit.length, slates: slates(fit),
    fit_shrunk: { w: c4.w, w_hat: c4.w_hat, lambda: c4.lambda, T: c4.T },
    pos_phase: fitPosPhase(fit, c4.w),
    espn_proven: fitEspnProven(fit, opts)
  };
}

/** A row's number under one candidate, from the served function. */
export function predict(row, candidate, params, { newsLayer = false } = {}) {
  return blendWeekPoints({ ours: row.ours, espn: row.espn, position: row.position, week: row.week,
    reportStatus: row.report_status, bye: row.bye }, { candidate, params: params?.[candidate] ?? null, newsLayer }).ppg;
}

/* ------------------------------------------------------------------ pairs and the bootstrap */

/** startSitPairAccuracy's score for one pair under one model. */
export function pairScore(pi, pj, ai, aj) {
  return (ai === aj || pi === pj) ? 0.5 : ((pi > pj) === (ai > aj) ? 1 : 0);
}

/**
 * Pairs in the same season, week and position where `inUniverse(row)` holds for both rows.
 * Returns index pairs into `rows` plus a player index per row for the bootstrap.
 */
export function enumeratePairs(rows, inUniverse) {
  const groups = new Map();
  rows.forEach((r, idx) => {
    if (!inUniverse(r)) return;
    const k = `${r.season}|${r.week}|${r.position}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(idx);
  });
  const a = [], b = [];
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { a.push(list[i]); b.push(list[j]); }
  }
  const playerIndex = new Map();
  const playerOf = new Int32Array(rows.length);
  rows.forEach((r, idx) => {
    if (!playerIndex.has(r.player_id)) playerIndex.set(r.player_id, playerIndex.size);
    playerOf[idx] = playerIndex.get(r.player_id);
  });
  return { a: Int32Array.from(a), b: Int32Array.from(b), playerOf, players: playerIndex.size };
}

/**
 * Pigeonhole (vertex) bootstrap draws (Owen 2007): each draw resamples the players with
 * replacement; a pair then counts m_i x m_j times.
 */
export function playerDraws(players, { iterations = ITERATIONS, seed = SEED } = {}) {
  const rand = seededRandom(seed);
  const draws = [];
  for (let it = 0; it < iterations; it++) {
    const m = new Uint16Array(players);
    for (let k = 0; k < players; k++) m[Math.floor(rand() * players)]++;
    draws.push(m);
  }
  return draws;
}

/** Weighted-mean bootstrap of a per-pair value over the selected pair indices. */
export function bootstrapPairMean(values, sel, pairs, draws) {
  const out = [];
  for (const m of draws) {
    let num = 0, den = 0;
    for (let s = 0; s < sel.length; s++) {
      const p = sel[s];
      const w = m[pairs.playerOf[pairs.a[p]]] * m[pairs.playerOf[pairs.b[p]]];
      if (w) { num += w * values[s]; den += w; }
    }
    if (den > 0) out.push(num / den);
  }
  out.sort((x, y) => x - y);
  if (!out.length) return null;
  return [out[Math.floor(0.05 * (out.length - 1))], out[Math.ceil(0.95 * (out.length - 1))]];
}

const withMde = ci => (ci ? { ci90: ci.map(r4), mde80: r4(mde80(ci)) } : { ci90: null, mde80: null });

/**
 * Candidate X against reference Y on one pair set: pair accuracy of both, the paired
 * difference with its CI and MDE80, and the decision grade on the pairs where they disagree.
 */
export function comparePreds(rows, pairs, predX, predY, draws) {
  const n = pairs.a.length;
  const diff = new Float64Array(n);
  let sx = 0, sy = 0;
  const dec = [], decWin = [], decSel = [];
  for (let p = 0; p < n; p++) {
    const i = pairs.a[p], j = pairs.b[p];
    const ai = rows[i].actual, aj = rows[j].actual;
    const x = pairScore(predX[i], predX[j], ai, aj);
    const y = pairScore(predY[i], predY[j], ai, aj);
    sx += x; sy += y; diff[p] = x - y;
    const dX = Math.sign(predX[i] - predX[j]), dY = Math.sign(predY[i] - predY[j]);
    if (dX === 0 || dY === 0 || dX === dY) continue;
    const pick = dX > 0 ? i : j, other = dX > 0 ? j : i;
    const pts = rows[pick].actual - rows[other].actual;
    dec.push(pts); decWin.push(pts > 0 ? 1 : pts < 0 ? 0 : 0.5); decSel.push(p);
  }
  const all = Int32Array.from({ length: n }, (_, p) => p);
  const sel = Int32Array.from(decSel);
  const paCi = n ? bootstrapPairMean(diff, all, pairs, draws) : null;
  const ptsCi = dec.length ? bootstrapPairMean(dec, sel, pairs, draws) : null;
  const winCi = dec.length ? bootstrapPairMean(decWin, sel, pairs, draws) : null;
  return {
    pairs: n,
    pa_x: n ? r4(sx / n) : null, pa_y: n ? r4(sy / n) : null, pa_diff: n ? r4((sx - sy) / n) : null,
    pa: withMde(paCi),
    decisions: { n: dec.length, win_rate: r4(mean(decWin)), points_per_decision: r4(mean(dec)),
      points: withMde(ptsCi), win_rate_ci90: winCi ? winCi.map(r4) : null }
  };
}

/* ------------------------------------------------------------------ the rules */

/** §6.1: good = pair-accuracy difference against ours above 0 with the CI's lower bound above 0. */
export const isGood = cmp => Boolean(cmp && cmp.pa_diff > 0 && cmp.pa.ci90 && cmp.pa.ci90[0] > 0);

/**
 * §6.2-6.4. `vsOurs[c]` is comparePreds(c, ours); `between(x, y)` returns comparePreds(x, y).
 * Returns the winner and every step taken, so the evidence can print the climb.
 */
export function selectWinner(vsOurs, between, ladder = LADDER) {
  const good = Object.keys(vsOurs).filter(c => c !== 'ours' && isGood(vsOurs[c]));
  const steps = [];
  if (!good.length) return { winner: 'ours', good, steps: [{ step: 'none good', winner: 'ours' }] };
  good.sort((x, y) => (ladder[x] - ladder[y]) || (vsOurs[y].pa_x - vsOurs[x].pa_x));
  let champion = good[0];
  steps.push({ step: 'first good on the ladder', champion });
  for (const x of good.slice(1)) {
    if (ladder[x] === ladder[champion]) { steps.push({ step: 'same rung, lower pair accuracy', candidate: x, kept: champion }); continue; }
    const cmp = between(x, champion);
    const beats = cmp.pa_diff != null && cmp.pa.mde80 != null && cmp.pa_diff > cmp.pa.mde80;
    steps.push({ step: 'climb', candidate: x, over: champion, pa_diff: cmp.pa_diff, mde80: cmp.pa.mde80, replaces: beats });
    if (beats) champion = x;
  }
  return { winner: champion, good, steps };
}

/** §6.5: the late-news layer on a blend winner, adopted only past its MDE. */
export const BLEND_WINNERS = Object.freeze(['half', 'fit_shrunk', 'pos_phase', 'espn_proven']);
export function layerDecision(winner, vsOurs, layered) {
  if (!BLEND_WINNERS.includes(winner)) return { tested: false, reason: `winner ${winner} is not a blend` };
  if (!isGood(vsOurs.news)) return { tested: false, reason: 'the late-news switch (C7) is not good against ours' };
  if (!layered) throw new Error('layerDecision: the layer applies, so the layered comparison is required');
  const adopt = layered.pa_diff != null && layered.pa.mde80 != null && layered.pa_diff > layered.pa.mde80;
  return { tested: true, pa_diff: layered.pa_diff, mde80: layered.pa.mde80, adopt };
}

/**
 * §7. `history` = comparePreds(winner, ours) on 2023+2024; `forward` = the same on 2026
 * week 2 (primary rows). Returns on/off and the verdict word the surface prints.
 */
export function shipDecision(winner, history, forward) {
  if (winner === 'ours') return { on: false, verdict: 'declined', reason: 'no candidate was good against ours on 2023-2024' };
  if (!isGood(history)) return { on: false, verdict: 'declined', reason: `${winner} is not good against ours on 2023-2024` };
  if (!(history.decisions.points_per_decision > 0)) {
    return { on: false, verdict: 'declined', reason: `${winner}'s points per decision against ours on 2023-2024 are not above 0` };
  }
  const holds = forward && forward.pa_diff > 0 && forward.decisions.points_per_decision > 0;
  if (!holds) {
    return { on: false, verdict: 'unconfirmed forward',
      reason: `${winner} did not hold on 2026 week 2 (pair accuracy difference ${forward?.pa_diff}, points per decision ${forward?.decisions?.points_per_decision})` };
  }
  return { on: true, verdict: 'shipped', reason: `${winner} is good on 2023-2024 and holds on 2026 week 2` };
}

/* ------------------------------------------------------------------ parity with the house metrics */

/** startSitPairAccuracy on the same universe must equal comparePreds' pair accuracy. */
export function pairAccuracyParity(rows, preds, inUniverse, models) {
  const keyed = rows.map((r, idx) => ({ week: `${r.season}:${r.week}`, position: r.position, actual: r.actual,
    preds: Object.fromEntries(models.map(m => [m, preds[m][idx]])) })).filter((_, idx) => inUniverse(rows[idx]));
  return startSitPairAccuracy(keyed, models, { threshold: -Infinity });
}

/** S-02's decisionWinRate on the same universe (point estimate only). */
export function winRateParity(rows, preds, inUniverse, x, y) {
  const keyed = rows.map((r, idx) => ({ week: `${r.season}:${r.week}`, position: r.position, actual: r.actual,
    preds: { [x]: preds[x][idx], [y]: preds[y][idx] } })).filter((_, idx) => inUniverse(rows[idx]));
  return decisionWinRate(keyed, x, y, { threshold: -Infinity, models: [], iterations: 10 }).win_rate;
}

/* ------------------------------------------------------------------ the grade */

const readRows = (dir, season) => fs.readFileSync(path.join(dir, `rows-${season}.ndjson`), 'utf8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

function maeOf(rows, preds, pick = () => true) {
  const idx = rows.map((r, i) => i).filter(i => pick(rows[i]));
  return idx.length ? r4(mean(idx.map(i => Math.abs(preds[i] - rows[i].actual)))) : null;
}
function biasOf(rows, preds) {
  return rows.length ? r4(mean(rows.map((r, i) => preds[i] - r.actual))) : null;
}

/** Every candidate's numbers on `rows` (params per graded season via paramsFor(row)). */
export function candidatePreds(rows, paramsFor, { newsLayerOn = null } = {}) {
  const preds = Object.fromEntries(CANDIDATE_IDS.map(c => [c, rows.map(r => predict(r, c, paramsFor(r)))]));
  if (newsLayerOn) preds[`${newsLayerOn}+news`] = rows.map(r => predict(r, newsLayerOn, paramsFor(r), { newsLayer: true }));
  return preds;
}

function gradeWindow(rows, preds, { draws, universe, label, winner = null }) {
  const pairs = enumeratePairs(rows, universe);
  const idsWithLayer = Object.keys(preds);
  const vsOurs = {}, vsEspn = {};
  for (const c of idsWithLayer) {
    if (c !== 'ours') vsOurs[c] = comparePreds(rows, pairs, preds[c], preds.ours, draws);
    if (c !== 'espn') vsEspn[c] = comparePreds(rows, pairs, preds[c], preds.espn, draws);
  }
  return { label, rows: rows.length, players: pairs.players, pairs: pairs.a.length, pairsObj: pairs, vsOurs, vsEspn, winner };
}

export async function grade({ root, rowsDir, out, prereg, git, log }) {
  // ---- Stop: the pre-registration must be committed and unchanged.
  if (!git('ls-files', prereg)) throw new Error(`${prereg} is not committed; pre-register before any number is run`);
  if (git('status', '--porcelain', '--', prereg)) throw new Error(`${prereg} has uncommitted changes`);
  const dir = path.resolve(root, rowsDir);
  const report = {
    unit: 'BLEND-01', label: 'local copy, not production',
    tree: { head: git('rev-parse', 'HEAD'), write_tree: git('write-tree') },
    prereg: { path: prereg, commit: git('log', '-1', '--format=%H', '--', prereg), blob: git('rev-parse', `HEAD:${prereg}`) },
    configuration: {
      ours: 'S-03 served base (structural + coordinator correction, walk-forward fits; else the ensemble) x 1 x active_probability, 0 on a bye',
      espn: 'history: ESPN archive (leaguedefaults/3, last pre-lock value); 2026 primary: league_roster_snapshots final rows',
      universe: 'pairs in the same season, week and position where ours projects both >= 4',
      bootstrap: `pigeonhole player bootstrap, ${ITERATIONS} draws, seed ${SEED}, 90% percentile intervals`,
      sign: 'candidate − reference; positive favours the candidate (MAE: negative favours the candidate)'
    },
    started_at: new Date().toISOString()
  };
  const assembleReport = JSON.parse(fs.readFileSync(path.join(dir, 'assemble-report.json'), 'utf8'));
  report.assembled = { head: assembleReport.tree?.head ?? null, k_control: assembleReport.k_control,
    weight_sets: assembleReport.weight_sets, coordinator: assembleReport.coordinator,
    seasons: Object.fromEntries(Object.entries(assembleReport.seasons ?? {}).map(([s, v]) => [s, { rows: v.rows, with_espn: v.with_espn }])),
    forward: assembleReport.forward };

  const bySeason = Object.fromEntries([2022, 2023, 2024].map(s => [s, readRows(dir, s)]));
  for (const [s, list] of Object.entries(bySeason)) if (!list.length) throw new Error(`no rows for ${s}`);

  // ---- Walk-forward fits.
  const fits = {};
  for (const season of GRADED_SEASONS) {
    const fitRows = FIT_SEASONS_FOR[season].flatMap(s => bySeason[s]);
    if (fitRows.some(r => r.season >= season)) throw new Error(`fit for ${season} reaches ${season}`);
    fits[season] = fitCandidates(fitRows);
  }
  const shipFit = fitCandidates(SHIP_FIT_SEASONS.flatMap(s => bySeason[s]));
  const summarizeFit = f => ({ n: f.n, slates: f.slates, fit_shrunk: { w: r4(f.fit_shrunk.w), w_hat: r4(f.fit_shrunk.w_hat),
    lambda: r4(f.fit_shrunk.lambda), T: f.fit_shrunk.T }, pos_phase: f.pos_phase.cells, espn_proven: f.espn_proven.cells });
  report.fits = { ...Object.fromEntries(Object.entries(fits).map(([s, f]) => [s, { fit_seasons: FIT_SEASONS_FOR[s], ...summarizeFit(f) }])),
    ship: { fit_seasons: SHIP_FIT_SEASONS, ...summarizeFit(shipFit) } };
  log('fits', JSON.stringify(report.fits.ship.fit_shrunk));

  // ---- History grade: pooled 2023 + 2024, primary population (an ESPN value).
  const graded = GRADED_SEASONS.flatMap(s => bySeason[s]);
  const primaryRows = graded.filter(r => r.espn != null);
  report.population = { graded_rows: graded.length, with_espn: primaryRows.length,
    positions: Object.fromEntries(POSITIONS.map(p => [p, primaryRows.filter(r => r.position === p).length])) };
  const paramsFor = r => fits[r.season];
  const oursUniverse = r => r.ours >= THRESHOLD;
  const histPreds = candidatePreds(primaryRows, paramsFor);
  const probe = enumeratePairs(primaryRows, oursUniverse);
  const draws = playerDraws(probe.players);
  const hist = gradeWindow(primaryRows, histPreds, { draws, universe: oursUniverse, label: 'history 2023+2024 (primary)' });
  // ---- Parity with the house metrics.
  const parity = pairAccuracyParity(primaryRows, histPreds, oursUniverse, CANDIDATE_IDS);
  for (const c of CANDIDATE_IDS) {
    const mine = c === 'ours' ? hist.vsEspn.ours.pa_x : hist.vsOurs[c].pa_x;
    if (Math.abs(parity.accuracy[c] - mine) > 1e-4) throw new Error(`parity: ${c} pair accuracy ${mine} vs startSitPairAccuracy ${parity.accuracy[c]}`);
  }
  if (parity.pairs !== hist.pairs) throw new Error(`parity: ${hist.pairs} pairs vs startSitPairAccuracy ${parity.pairs}`);
  const wr = winRateParity(primaryRows, histPreds, oursUniverse, 'espn', 'ours');
  if (Math.abs(wr - hist.vsOurs.espn.decisions.win_rate) > 1e-4) throw new Error(`parity: ESPN win rate ${hist.vsOurs.espn.decisions.win_rate} vs decisionWinRate ${wr}`);
  report.parity = { pair_accuracy: { pairs: parity.pairs, accuracy: Object.fromEntries(Object.entries(parity.accuracy).map(([k, v]) => [k, r4(v)])) },
    espn_vs_ours_win_rate: r4(wr) };

  // ---- Selection.
  const between = (x, y) => comparePreds(primaryRows, hist.pairsObj, histPreds[x], histPreds[y], draws);
  const selection = selectWinner(hist.vsOurs, between);
  const winner = selection.winner;
  let newsLayer = false;
  let layer;
  if (BLEND_WINNERS.includes(winner) && isGood(hist.vsOurs.news)) {
    const layeredPreds = primaryRows.map(r => predict(r, winner, paramsFor(r), { newsLayer: true }));
    const layered = comparePreds(primaryRows, hist.pairsObj, layeredPreds, histPreds[winner], draws);
    layer = layerDecision(winner, hist.vsOurs, layered);
    newsLayer = layer.adopt === true;
    if (newsLayer) {
      histPreds[`${winner}+news`] = layeredPreds;
      hist.vsOurs[`${winner}+news`] = comparePreds(primaryRows, hist.pairsObj, layeredPreds, histPreds.ours, draws);
      hist.vsEspn[`${winner}+news`] = comparePreds(primaryRows, hist.pairsObj, layeredPreds, histPreds.espn, draws);
    }
  } else {
    layer = layerDecision(winner, hist.vsOurs, null);
  }
  const servedKey = newsLayer ? `${winner}+news` : winner;
  report.selection = { ...selection, layer, served: servedKey };
  log('selection', JSON.stringify(report.selection));

  // ---- Secondary history views (no rule attached).
  const houseUniverse = idx => r => CANDIDATE_IDS.every(c => histPreds[c][idx.get(r)] >= THRESHOLD);
  const index = new Map(primaryRows.map((r, i) => [r, i]));
  const house = gradeWindow(primaryRows, histPreds, { draws, universe: houseUniverse(index), label: 'history, house universe (every candidate >= 4)' });
  const playedIdx = primaryRows.map((r, i) => i).filter(i => primaryRows[i].played);
  const playedRows = playedIdx.map(i => primaryRows[i]);
  const playedPreds = Object.fromEntries(Object.entries(histPreds).map(([k, v]) => [k, playedIdx.map(i => v[i])]));
  const playedDraws = playerDraws(enumeratePairs(playedRows, oursUniverse).players);
  const played = gradeWindow(playedRows, playedPreds, { draws: playedDraws, universe: oursUniverse, label: 'history, played only' });
  const bySeasonGrades = {};
  for (const season of GRADED_SEASONS) {
    const idx = primaryRows.map((r, i) => i).filter(i => primaryRows[i].season === season);
    const sr = idx.map(i => primaryRows[i]);
    const sp = Object.fromEntries(Object.entries(histPreds).map(([k, v]) => [k, idx.map(i => v[i])]));
    const sd = playerDraws(enumeratePairs(sr, oursUniverse).players);
    const g = gradeWindow(sr, sp, { draws: sd, universe: oursUniverse, label: `history ${season}` });
    bySeasonGrades[season] = { pairs: g.pairs, vsOurs: g.vsOurs, vsEspn: g.vsEspn };
  }
  const levels = {};
  for (const c of Object.keys(histPreds)) {
    levels[c] = { mae_decision: maeOf(primaryRows, histPreds[c]), mae_played: maeOf(primaryRows, histPreds[c], r => r.played),
      mean_signed_error: biasOf(primaryRows, histPreds[c]) };
  }
  report.history = {
    primary: { rows: hist.rows, players: hist.players, pairs: hist.pairs, vs_ours: hist.vsOurs, vs_espn: hist.vsEspn },
    house: { pairs: house.pairs, vs_ours: house.vsOurs, vs_espn: house.vsEspn },
    played_only: { rows: played.rows, pairs: played.pairs, vs_ours: played.vsOurs, vs_espn: played.vsEspn },
    by_season: bySeasonGrades,
    levels,
    level_gap_espn_minus_ours: r4(mean(primaryRows.map(r => r.espn - r.ours))),
    level_gap_ours_ge_4: r4(mean(primaryRows.filter(oursUniverse).map(r => r.espn - r.ours)))
  };

  // ---- Forward: 2026 week 2 with the shipping parameters (fit on 2022-2024).
  const fwdAll = readRows(dir, 2026);
  const fwdParams = () => shipFit;
  const forwardView = (label, rowsIn) => {
    if (!rowsIn.length) return { label, rows: 0 };
    const preds = candidatePreds(rowsIn, fwdParams);
    if (newsLayer) preds[servedKey] = rowsIn.map(r => predict(r, winner, shipFit, { newsLayer: true }));
    const fd = playerDraws(enumeratePairs(rowsIn, oursUniverse).players);
    const g = gradeWindow(rowsIn, preds, { draws: fd, universe: oursUniverse, label });
    return { label, rows: g.rows, players: g.players, pairs: g.pairs, vs_ours: g.vsOurs, vs_espn: g.vsEspn,
      mae_decision: Object.fromEntries(Object.keys(preds).map(c => [c, maeOf(rowsIn, preds[c])])),
      level_gap_espn_minus_ours: r4(mean(rowsIn.map(r => r.espn - r.ours))) };
  };
  const withOurs = fwdAll.filter(r => r.ours != null);
  report.forward = {
    season: 2026, weeks: [...new Set(fwdAll.map(r => r.week))], shipping_parameters: 'fit on 2022-2024',
    label: 'forward, one week: an anecdote for size, a direction check for the ship rule',
    primary: forwardView('2026 W2: replayed served number vs ESPN settled (rostered)', withOurs.filter(r => r.espn != null)),
    archive: forwardView('2026 W2: replayed served number vs ESPN archive (all players)',
      withOurs.filter(r => r.espn_archive != null).map(r => ({ ...r, espn: r.bye ? 0 : r.espn_archive }))),
    thursday: forwardView('2026 W2: replayed served number vs ESPN Thursday capture',
      withOurs.filter(r => r.espn_thursday != null).map(r => ({ ...r, espn: r.bye ? 0 : r.espn_thursday }))),
    snapshot: forwardView('2026 W2: the Thursday snapshot (frozen-2023 ensemble) x p vs ESPN settled',
      fwdAll.filter(r => r.ours_snapshot != null && r.espn != null).map(r => ({ ...r, ours: r.ours_snapshot })))
  };

  // ---- Ship rule.
  const histWinner = servedKey === 'ours' ? null : hist.vsOurs[servedKey];
  const fwdWinner = servedKey === 'ours' ? null : report.forward.primary.vs_ours?.[servedKey];
  const decision = shipDecision(winner, histWinner, fwdWinner);
  const beatsEspn = servedKey === 'espn' ? { history: 'the winner is ESPN alone', forward: 'the winner is ESPN alone' }
    : servedKey === 'ours' ? { history: hist.vsEspn.ours, forward: report.forward.primary.vs_espn?.ours }
      : { history: hist.vsEspn[servedKey], forward: report.forward.primary.vs_espn?.[servedKey] };
  report.decision = {
    winner, news_layer: newsLayer, served: servedKey, ...decision,
    served_params: winner === 'ours' || !CANDIDATES[winner]?.fitted ? null
      : winner === 'fit_shrunk' ? { w: r4(shipFit.fit_shrunk.w) }
        : winner === 'pos_phase' ? { pooled: r4(shipFit.pos_phase.pooled), w: roundTable(shipFit.pos_phase.w) }
          : { b: roundTable(shipFit.espn_proven.b) },
    beats_espn_alone: beatsEspn
  };
  report.finished_at = new Date().toISOString();
  fs.writeFileSync(path.resolve(root, out), `${JSON.stringify(report, null, 2)}\n`);
  log('decision', JSON.stringify({ winner, news_layer: newsLayer, on: decision.on, verdict: decision.verdict, reason: decision.reason }));
  return report;
}

function roundTable(t) {
  return Object.fromEntries(Object.entries(t).map(([pos, cells]) => [pos, Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, r4(v)]))]));
}
