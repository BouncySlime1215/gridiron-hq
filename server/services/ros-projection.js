/**
 * Rest-of-season (ROS) projection: a player's points per game PLAYED over the rest
 * of the season, from information strictly before the week being projected.
 *
 * WHY THIS EXISTS. trade-engine.js used the weekly blend as `ros_ppg`. The blend is
 * fit to predict NEXT week and puts 80% of its weight on the player's own in-season
 * scores (season_to_date, last3, last1, median), which at week 2 are all his single
 * week-1 score. So rest-of-season value, trade value (adj_ppg) and waiver stash value
 * were 80% the week-1 score: free agent Jalen Coker showed ros_ppg 29.9 (33.8 PPR in
 * week 1) and a +23.9 claim, Jaylen Waddle 2.72 (1.2 in week 1) and was the suggested drop.
 *
 * THE MODEL, candidate (d) of the pre-registered gate:
 *
 *   ros = alpha * structural + (1 - alpha) * [ n/(n+k) * season_to_date + k/(n+k) * prior ]
 *
 *   structural      the weekly engine's structural head (volume x efficiency), cutoff-safe
 *   season_to_date  mean points per game over this season's games so far (n of them)
 *   prior           preseason expectation with NO in-season data: 'c_mkt' is the shipped
 *                   draft-board market curve (preseason-model.js#preseasonProjections),
 *                   falling back to 'c_struct', the structural projection built through
 *                   last season (projections.js#buildProjections({through: s-1}))
 *   k               games of evidence at which the in-season rate and the prior weigh
 *                   the same; one number or one per position
 *
 * Every piece is on the same basis as the old ros_ppg: per game played, no
 * availability term. alpha, k and the prior are fitted by scripts/fit-ros-projection.mjs
 * on seasons strictly before the one graded; see ROS_PARAMS for the shipped fit and
 * its gate. Players outside the graded population (no game played yet this season,
 * or a position the fit does not cover) get no entry here, and the caller keeps its
 * existing number for them.
 */
import { rows } from '../db/index.js';
import { PPR, scoreLine } from './scoring.js';
import { buildProjections } from './projections.js';
import { preseasonProjections } from './preseason-model.js';
import { pairedBootstrapDiff } from './backtest-significance.js';

export const ROS_POSITIONS = Object.freeze(['QB', 'RB', 'WR', 'TE']);
export const ROS_ALPHA_GRID = Object.freeze(Array.from({ length: 11 }, (_, i) => i / 10));
export const ROS_K_GRID = Object.freeze([0.25, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 60, 100]);
export const ROS_PRIORS = Object.freeze(['c_mkt', 'c_struct']);

/**
 * The shipped fit (a null here would make buildRosProjections() return nothing, and
 * trade-engine.js would keep the weekly number — an unfitted model never reaches a trade).
 *
 * Source: `node scripts/fit-ros-projection.mjs`, 2026-09-18, on a copy of the live DB.
 * Structure chosen by player-grouped 2-fold CV on 2023-2025 (held-out MAE: market
 * prior + one k 2.518, market + per-position k 2.518, structural prior + one k 2.565,
 * + per-position k 2.562), then refit on all 9,009 player-forecast rows of 2023-2025
 * (w = 1,2,3,4,6,8,10; in-sample MAE 2.516).
 *
 * Gate (pre-registered, in the script's header): the SAME procedure, fit only on
 * seasons before the graded one, against the old ros_ppg (the weekly blend), mean
 * points per game played over the rest of the season:
 *
 *   season  fit on     MAE w1-4 old -> new      pooled diff, 90% CI        w6-10 diff, 90% CI
 *   2024    2023       3.83/3.13/2.90/2.91 ->    -0.72 [-0.86, -0.58]       -0.08 [-0.18, +0.03]
 *                      2.47/2.36/2.42/2.51
 *   2025    2023+2024  3.58/3.12/2.85/2.79 ->    -0.67 [-0.80, -0.54]       -0.16 [-0.25, -0.06]
 *                      2.37/2.32/2.42/2.44
 *
 * PASS on all 12 checks. It also beats the structural head alone early (2024 -0.15,
 * 2025 -0.10, both significant) and ties it late. Not gated, reported: with
 * did-not-play weeks counted as zeros, it is worse than the old number from week 6 on
 * (2025 w10 3.35 vs 3.07) — ros_ppg is per game PLAYED and carries no availability
 * term, so a consumer that wants expected points per calendar week must apply one.
 */
export const ROS_PARAMS = Object.freeze({ prior: 'c_mkt', alpha: 0.5, k: 4 });

const finite = v => typeof v === 'number' && Number.isFinite(v);

/** Share of the in-season rate after n games: n / (n + k). */
export function evidenceWeight(n, k) {
  const games = finite(n) && n > 0 ? n : 0;
  return games > 0 ? games / (games + k) : 0;
}

/** The fitted k for a position: a global number, or a per-position table (null if absent). */
export function kFor(params, position) {
  const k = params?.k;
  if (finite(k)) return k;
  if (k && typeof k === 'object') return finite(k[position]) ? k[position] : null;
  return null;
}

/**
 * The ROS point estimate for one player. Missing pieces fall back rather than
 * poison the number: no prior -> the structural head stands in for it; no structural
 * head -> the prior stands in; neither -> his own season-to-date rate (or null).
 */
export function rosUpdate({ structural, seasonToDate, games, prior, position }, params) {
  if (!params || !finite(params.alpha)) return null;
  const k = kFor(params, position);
  if (k == null) return null;
  const n = finite(games) && games > 0 ? games : 0;
  const std = n > 0 && finite(seasonToDate) ? seasonToDate : null;
  let b = finite(structural) ? structural : null;
  let p = finite(prior) ? prior : null;
  if (p == null) p = b;
  if (b == null) b = p;
  if (b == null) return std;
  const w = std == null ? 0 : evidenceWeight(n, k);
  const inSeason = w > 0 ? w * std + (1 - w) * p : p;
  return params.alpha * b + (1 - params.alpha) * inSeason;
}

/** The prior a named variant uses for one row: c_mkt falls back to c_struct. */
export function priorFor(row, name) {
  if (name === 'c_mkt') {
    if (finite(row?.c_mkt)) return row.c_mkt;
    return finite(row?.c_struct) ? row.c_struct : null;
  }
  return finite(row?.c_struct) ? row.c_struct : null;
}

/** rosUpdate() over a dataset row ({structural, std, n, c_mkt, c_struct, position}). */
export function predictRow(row, params) {
  return rosUpdate({
    structural: row.structural, seasonToDate: row.std, games: row.n,
    prior: priorFor(row, params.prior), position: row.position
  }, params);
}

/* -------------------------------------------------------------- fitting */

/**
 * Grid-search alpha and k for one structure by pooled MAE against `actual`.
 * `perPosition` fits one k per position under a single shared alpha. Ties keep the
 * first grid point, so the result is deterministic.
 */
export function fitRosParams(dataRows, { prior = 'c_mkt', perPosition = false } = {}) {
  const A = ROS_ALPHA_GRID, K = ROS_K_GRID;
  const positions = [...ROS_POSITIONS];
  const err = Object.fromEntries(positions.map(pos => [pos, A.map(() => new Float64Array(K.length))]));
  const count = Object.fromEntries(positions.map(pos => [pos, 0]));
  let total = 0;
  for (const r of dataRows) {
    if (!err[r.position] || !finite(r.actual)) continue;
    const p0 = priorFor(r, prior);
    const b = finite(r.structural) ? r.structural : p0;
    const p = p0 ?? b;
    if (b == null) continue;
    const n = finite(r.n) && r.n > 0 ? r.n : 0;
    const std = n > 0 && finite(r.std) ? r.std : null;
    const inSeason = K.map(k => {
      const w = std == null ? 0 : n / (n + k);
      return w > 0 ? w * std + (1 - w) * p : p;
    });
    const table = err[r.position];
    for (let ai = 0; ai < A.length; ai++) {
      const a = A[ai], row = table[ai];
      for (let ki = 0; ki < K.length; ki++) row[ki] += Math.abs(a * b + (1 - a) * inSeason[ki] - r.actual);
    }
    count[r.position]++;
    total++;
  }
  if (!total) return { prior, perPosition, alpha: null, k: null, mae: null, n: 0 };

  const sumAt = (ai, ki) => positions.reduce((s, pos) => s + err[pos][ai][ki], 0);
  let best = { ai: 0, ki: 0, sum: Infinity };
  for (let ai = 0; ai < A.length; ai++) {
    for (let ki = 0; ki < K.length; ki++) {
      const s = sumAt(ai, ki);
      if (s < best.sum) best = { ai, ki, sum: s };
    }
  }
  if (!perPosition) {
    return { prior, perPosition: false, alpha: A[best.ai], k: K[best.ki], mae: best.sum / total, n: total };
  }
  let bestPer = { ai: 0, sum: Infinity, ks: null };
  for (let ai = 0; ai < A.length; ai++) {
    // A position with no rows keeps the global k at this alpha.
    let globalKi = 0;
    for (let ki = 1; ki < K.length; ki++) if (sumAt(ai, ki) < sumAt(ai, globalKi)) globalKi = ki;
    let sum = 0;
    const ks = {};
    for (const pos of positions) {
      let kiBest = globalKi;
      if (count[pos] > 0) {
        kiBest = 0;
        for (let ki = 1; ki < K.length; ki++) if (err[pos][ai][ki] < err[pos][ai][kiBest]) kiBest = ki;
      }
      ks[pos] = K[kiBest];
      sum += err[pos][ai][kiBest];
    }
    if (sum < bestPer.sum) bestPer = { ai, sum, ks };
  }
  return { prior, perPosition: true, alpha: A[bestPer.ai], k: bestPer.ks, mae: bestPer.sum / total, n: total };
}

/** Deterministic two-way split of players (murmur3 finalizer over an FNV-1a hash). */
export function foldOf(playerId) {
  let h = 0x811c9dc5;
  for (const ch of String(playerId)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) & 1;
}

/**
 * Choose the structure (which prior; one k or one per position) by player-grouped
 * 2-fold cross-validation inside the training rows, then refit that structure on all
 * of them. Pre-registered in the gate: this is how (d) is selected without touching
 * the season it will be graded on.
 */
export function selectRosStructure(dataRows, { priors = ROS_PRIORS } = {}) {
  const structures = priors.flatMap(prior => [false, true].map(perPosition => ({ prior, perPosition })));
  const cv = structures.map(s => {
    let abs = 0, n = 0;
    for (const fold of [0, 1]) {
      const train = dataRows.filter(r => foldOf(r.player_id) !== fold);
      const held = dataRows.filter(r => foldOf(r.player_id) === fold);
      const fit = fitRosParams(train, s);
      if (fit.alpha == null) continue;
      for (const r of held) {
        const d = predictRow(r, fit);
        if (finite(d) && finite(r.actual)) { abs += Math.abs(d - r.actual); n++; }
      }
    }
    return { ...s, cv_mae: n ? abs / n : Infinity, n };
  });
  let best = cv[0];
  for (const c of cv) if (c.cv_mae < best.cv_mae) best = c;
  const structure = { prior: best.prior, perPosition: best.perPosition };
  return { structure, cv, params: fitRosParams(dataRows, structure) };
}

/* ----------------------------------------------------------------- gate */

const meanOf = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

/**
 * The pre-registered PASS rule (scratchpad GATE.md, copied into
 * scripts/fit-ros-projection.mjs). `rows` are per (season, w, player) absolute
 * errors of the current blend (err_a) and the candidate (err_d) on the PRIMARY target.
 *   1 early_win        each season, pooled w 1-4: mean(err_d - err_a) < 0 and the
 *                      player-clustered bootstrap's 90% interval excludes 0
 *   2 early_direction  each season, each w 1-4: MAE(d) <= MAE(a)
 *   3 late_not_worse   each season, pooled w 6/8/10: not (worse and significant)
 */
export function evaluateRosGate(gateRows, {
  seasons = [2024, 2025], early = [1, 2, 3, 4], late = [6, 8, 10], seed = 20260918, iterations = 2000
} = {}) {
  const checks = [];
  const boot = list => {
    if (list.length < 10) return null;
    const res = pairedBootstrapDiff(list.map(r => r.err_a), list.map(r => r.err_d),
      { seed, iterations, groups: list.map(r => r.player_id) });
    return res.error ? null : res;
  };
  for (const season of seasons) {
    const sRows = gateRows.filter(r => r.season === season);
    const e = boot(sRows.filter(r => early.includes(r.w)));
    checks.push({ rule: 'early_win', season, ok: Boolean(e && e.mean_diff < 0 && e.significant),
      mean_diff: e?.mean_diff ?? null, ci90: e?.ci90 ?? null, n: e?.n ?? 0 });
    for (const w of early) {
      const wRows = sRows.filter(r => r.w === w);
      const maeA = meanOf(wRows.map(r => r.err_a)), maeD = meanOf(wRows.map(r => r.err_d));
      checks.push({ rule: 'early_direction', season, w, ok: wRows.length > 0 && maeD <= maeA,
        mae_a: maeA, mae_d: maeD, n: wRows.length });
    }
    const l = boot(sRows.filter(r => late.includes(r.w)));
    checks.push({ rule: 'late_not_worse', season, ok: Boolean(l && !(l.mean_diff > 0 && l.significant)),
      mean_diff: l?.mean_diff ?? null, ci90: l?.ci90 ?? null, n: l?.n ?? 0 });
  }
  return { pass: checks.length > 0 && checks.every(c => c.ok), checks };
}

/* ----------------------------------------------------------- live inputs */

/** The market prior is a PPR curve; only a league scored exactly like PPR may use it. */
export function isStandardPpr(scoring) {
  if (!scoring) return false;
  const keys = new Set([...Object.keys(PPR), ...Object.keys(scoring)]);
  for (const key of keys) if ((scoring[key] ?? 0) !== (PPR[key] ?? 0)) return false;
  return true;
}

/** This season's games before `week`: player_id -> { games, season_to_date }. */
export function inSeasonHistory(season, week, { scoring = PPR } = {}) {
  const acc = new Map();
  let list = [];
  try {
    list = rows('SELECT * FROM player_week_usage WHERE season = ? AND week < ?', season, week);
  } catch { return acc; }
  for (const r of list) {
    const a = acc.get(r.player_id) ?? { games: 0, sum: 0 };
    a.games++;
    a.sum += Number(scoreLine(r, scoring));
    acc.set(r.player_id, a);
  }
  const out = new Map();
  for (const [id, a] of acc) out.set(id, { games: a.games, season_to_date: a.sum / a.games });
  return out;
}

const priorCache = new Map();

/**
 * Preseason priors for `season`, keyed by players.id: { c_mkt, c_struct }. Built from
 * data before the season only, so it never changes in-season; memoised per process.
 * Each source is optional — a database without the market tables still gets c_struct.
 */
export function rosPriorMap(season, { scoring = PPR } = {}) {
  const key = `${season}:${JSON.stringify(scoring)}`;
  if (priorCache.has(key)) return priorCache.get(key);
  const out = new Map();
  const entry = id => { if (!out.has(id)) out.set(id, { c_mkt: null, c_struct: null }); return out.get(id); };
  try {
    for (const [id, p] of buildProjections({ through: season - 1, scoring })) {
      if (finite(p.ppg)) entry(id).c_struct = p.ppg;
    }
  } catch { /* no history on file: no structural prior */ }
  if (isStandardPpr(scoring)) {
    try {
      const market = preseasonProjections(season);
      if (market.size) {
        for (const p of rows('SELECT id, gsis_id FROM players WHERE gsis_id IS NOT NULL')) {
          const m = market.get(p.gsis_id);
          if (m && finite(m.ppg)) entry(p.id).c_mkt = m.ppg;
        }
      }
    } catch { /* no board on file: c_mkt falls back to c_struct */ }
  }
  priorCache.set(key, out);
  return out;
}

export function clearRosPriorCache() { priorCache.clear(); }

/**
 * ROS projections for one league-week.
 *
 * @param weekly  the player-week engine map (player_id -> projection with position and
 *                structural_ppg), exactly what trade-engine.js already built
 * @param params  the fit; defaults to ROS_PARAMS (null = nothing ships)
 * @param priors  optional injected rosPriorMap() result (tests)
 * @param history optional injected inSeasonHistory() result (tests)
 * @returns Map<player_id, {ros_ppg, games, season_to_date, prior, prior_source,
 *          structural, weight_in_season, alpha, k}> — only players who have played
 *          this season at a fitted position (the population the gate graded).
 */
export function buildRosProjections({ season, week, scoring = PPR, weekly, params = ROS_PARAMS,
  priors = null, history = null } = {}) {
  const out = new Map();
  if (!params || !weekly) return out;
  const hist = history ?? inSeasonHistory(season, week, { scoring });
  const pri = priors ?? rosPriorMap(season, { scoring });
  for (const [id, proj] of weekly) {
    if (!ROS_POSITIONS.includes(proj?.position)) continue;
    const h = hist.get(id);
    if (!h || !(h.games > 0)) continue;
    const pr = pri.get(id) ?? {};
    const prior = priorFor(pr, params.prior);
    const structural = finite(proj.structural_ppg) ? proj.structural_ppg : null;
    const k = kFor(params, proj.position);
    const ros = rosUpdate({ structural, seasonToDate: h.season_to_date, games: h.games, prior, position: proj.position }, params);
    if (!finite(ros)) continue;
    const priorSource = !finite(prior) ? 'structural'
      : params.prior === 'c_mkt' && finite(pr.c_mkt) ? 'c_mkt' : 'c_struct';
    out.set(id, {
      ros_ppg: ros, games: h.games, season_to_date: h.season_to_date,
      prior: finite(prior) ? prior : structural, prior_source: priorSource, structural,
      weight_in_season: k == null ? null : evidenceWeight(h.games, k), alpha: params.alpha, k
    });
  }
  return out;
}
