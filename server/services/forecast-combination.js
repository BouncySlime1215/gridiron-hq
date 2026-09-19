/**
 * Real forecast combination for the NFL ensemble.
 *
 * Stage 1 (`nfl-ensemble-rank.js`) measured how much of the ensemble's 31-column
 * forecast set is independent information. This stage acts on that measurement:
 * it reduces the components to a small basis and then combines them with methods
 * that the forecast-combination literature actually sanctions, instead of the
 * single shrink-toward-market rule the ensemble uses today.
 *
 * Three commitments shape everything below.
 *
 * 1. REDUCE FIRST. Feeding 31 near-collinear columns into an estimated-weight
 *    combiner is how combination weights become noise: the normal-equations
 *    matrix is nearly singular, so the fitted weights are large, opposite-signed
 *    and unstable, and they do not survive contact with a new season. The
 *    reduction runs on the TRAINING block only and is refit at every
 *    walk-forward step, because a basis chosen with knowledge of the test
 *    season is not a basis, it is a leak.
 *
 * 2. THE SIMPLE BASELINES ARE NOT STRAW MEN. The "forecast combination puzzle"
 *    (Clemen 1989; Stock & Watson 2004; Smith & Wallis 2009) is the repeated
 *    finding that equal weights beat estimated optimal weights out of sample,
 *    because estimation error in the weights costs more than the mis-weighting
 *    it corrects. Equal weights and inverse-MSE weights are therefore first-
 *    class candidates here, not controls. If they win, that is the answer.
 *
 * 3. NOTHING IS CALLED BETTER WITHOUT A TEST THAT ALLOWS FOR DEPENDENCE.
 *    Every pairwise comparison is gated on Diebold-Mariano with the
 *    Harvey-Leybourne-Newbold correction, clustered so one weekly slate counts
 *    as one forecast period. A plain paired t over per-game squared errors
 *    treats sixteen games that share one week of market state as sixteen
 *    independent observations and will hand out significance that is not there.
 *
 * This module fits nothing into production. It writes no weight, changes no
 * blend, and is not wired into `ensembleLine`. It is the evidence that would
 * have to exist before anyone changed the blend.
 */
import { createHash } from 'node:crypto';
import { dieboldMariano, naivePairedT } from './forecast-comparison.js';
import { completeWeekSplit } from './nfl-ensemble.js';
import { greedyBasis } from './nfl-ensemble-rank.js';

export const FORECAST_COMBINATION_VERSION = 'nfl-forecast-combination-v1';

/**
 * The incumbent's promotion gate, copied from `fitEnsemble` so it can be
 * replayed.
 *
 * CORRECTED 2026-09-15: this used to read `maxPairedT: -1.645`, a fixed
 * one-sided normal critical value applied to a naive paired t over per-game
 * squared errors. That was a faithful copy of `fitEnsemble`'s gate as it
 * existed before 2026-09-12 -- but `fitEnsemble` (nfl-ensemble.js) was
 * corrected that day (Giant Plan 7.2, FIX #2) to gate on Diebold-Mariano with
 * the Harvey-Leybourne-Newbold small-sample correction, clustered by week,
 * against a one-sided 5% p-value instead: the games on one slate are not
 * independent observations, and a fixed -1.645 silently re-imports the
 * large-sample assumption HLN exists to remove (see the FIX #2 comment on
 * `fitEnsemble`, and `server/services/forecast-comparison.js`). This copy had
 * fallen out of sync with the thing it claims to replay. `dmAlpha` below is
 * the current production threshold, not a new one invented here.
 */
const INCUMBENT_GATE = Object.freeze({ minScoreRows: 250, minGain: 0.03, dmAlpha: 0.05 });

/** Rounding the incumbent applies to the slope and RMSE its blend then reads. */
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const finite = v => v != null && Number.isFinite(v);

/* ------------------------------------------------------------------ linear algebra */

/**
 * Solve `A x = b` by Gaussian elimination with partial pivoting.
 *
 * `ridge` is added to the diagonal before solving. It is not decoration: the
 * whole premise of this module is that the columns are nearly collinear, and a
 * singular normal-equations matrix must produce a usable answer or an explicit
 * failure, never a vector of 1e9s that silently becomes a forecast.
 */
export function solveLinear(A, b, ridge = 0) {
  const n = b.length;
  if (!n || A.length !== n) return null;
  const M = A.map((row, i) => [...row.map((v, j) => (i === j ? v + ridge : v)), b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = M.map((row, i) => row[n] / row[i]);
  return x.every(Number.isFinite) ? x : null;
}

/** Ordinary least squares of `y` on `X`, optionally with an intercept column. */
export function ols(X, y, { intercept = true, ridge = 1e-8 } = {}) {
  if (!X.length || X.length !== y.length) return null;
  const k = X[0].length;
  const cols = intercept ? k + 1 : k;
  const design = X.map(row => (intercept ? [1, ...row] : row));
  const XtX = Array.from({ length: cols }, () => new Array(cols).fill(0));
  const Xty = new Array(cols).fill(0);
  for (let i = 0; i < design.length; i++) {
    const row = design[i];
    for (let a = 0; a < cols; a++) {
      Xty[a] += row[a] * y[i];
      for (let b = a; b < cols; b++) XtX[a][b] += row[a] * row[b];
    }
  }
  for (let a = 0; a < cols; a++) for (let b = 0; b < a; b++) XtX[a][b] = XtX[b][a];
  const beta = solveLinear(XtX, Xty, ridge);
  if (!beta) return null;
  return intercept
    ? { intercept: beta[0], weights: beta.slice(1) }
    : { intercept: 0, weights: beta };
}

/**
 * Euclidean projection of a vector onto the probability simplex
 * (Duchi, Shalev-Shwartz, Singer & Chandra 2008). Exact, O(k log k), no
 * iteration count to tune.
 */
export function projectToSimplex(v) {
  const k = v.length;
  if (!k) return [];
  const u = [...v].sort((a, b) => b - a);
  let cssv = 0, rho = -1, theta = 0;
  for (let i = 0; i < k; i++) {
    cssv += u[i];
    if (u[i] - (cssv - 1) / (i + 1) > 0) { rho = i; theta = (cssv - 1) / (i + 1); }
  }
  if (rho < 0) return new Array(k).fill(1 / k);
  return v.map(x => Math.max(0, x - theta));
}

/**
 * Projection onto `{b >= 0, sum(b) <= 1}` — the natural constraint set for
 * combining DEPARTURES from a market anchor. Non-negativity says a component
 * may not be used backwards; the budget says the blend may not move further
 * than its components collectively suggest. Unlike the simplex, this set
 * contains the origin, so "stay on the market" remains reachable.
 */
export function projectToSubSimplex(v) {
  const clipped = v.map(x => Math.max(0, x));
  const sum = clipped.reduce((s, x) => s + x, 0);
  return sum <= 1 ? clipped : projectToSimplex(v);
}

/**
 * Least squares subject to weights >= 0 and summing to 1 — the classic
 * "optimal combination" constraint set (Bates & Granger 1969; Granger &
 * Ramanathan 1984, their restricted case). Projected gradient descent with an
 * exact simplex projection and a step size from the Lipschitz constant, so the
 * result is deterministic and does not depend on a random start.
 */
export function constrainedLeastSquares(X, y, { iterations = 4000, project = projectToSimplex } = {}) {
  const n = X.length;
  if (!n) return null;
  const k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  // Step size 1/L with L an upper bound on the largest eigenvalue of (2/n)X'X
  // via the infinity-norm (Gershgorin). Cheap, and always a valid bound.
  let L = 0;
  for (let a = 0; a < k; a++) {
    let rowSum = 0;
    for (let b = 0; b < k; b++) rowSum += Math.abs((2 / n) * XtX[a][b]);
    L = Math.max(L, rowSum);
  }
  if (!(L > 0)) return project(new Array(k).fill(1 / k));
  const step = 1 / L;
  let w = project(new Array(k).fill(1 / k));
  for (let t = 0; t < iterations; t++) {
    const grad = new Array(k).fill(0);
    for (let a = 0; a < k; a++) {
      let acc = -Xty[a];
      for (let b = 0; b < k; b++) acc += XtX[a][b] * w[b];
      grad[a] = (2 / n) * acc;
    }
    const next = project(w.map((x, a) => x - step * grad[a]));
    let delta = 0;
    for (let a = 0; a < k; a++) delta += Math.abs(next[a] - w[a]);
    w = next;
    if (delta < 1e-12) break;
  }
  return w;
}

/* ------------------------------------------------------------------ the record block */

/**
 * Component coverage: the fraction of rows on which a component produced a
 * usable margin alongside a market quote.
 *
 * This exists because listwise deletion over a set of columns costs whatever
 * the WORST column costs. Admitting a component that abstains on a third of
 * games would silently delete a third of the evaluation sample for every other
 * component too, and the resulting RMSE would be computed on a different, easier
 * subset of games than the baseline's.
 */
export function componentCoverage(records, ids) {
  const usable = records.filter(r => finite(r.market_margin) && finite(r.actual_margin));
  const out = new Map();
  for (const id of ids) {
    const n = usable.filter(r => finite(r.margins?.[id])).length;
    out.set(id, usable.length ? n / usable.length : 0);
  }
  return { coverage: out, rows: usable.length };
}

/**
 * Matrix over the chosen components.
 *
 * `allowMissing` is not a convenience, it is what keeps the comparison honest.
 * A combination that needs all K columns at once must listwise-delete, and the
 * dropped rows are reported. But the incumbent and the all-component average
 * both tolerate a missing component per row — production does exactly that —
 * and forcing them through listwise deletion over 31 columns would score them
 * on a smaller, different set of games than the reduced methods, which turns
 * the RMSE table into a comparison of samples rather than of methods. So those
 * methods keep every row, hold nulls, and the pooled table below is computed on
 * the intersection all methods scored.
 */
export function buildBlock(records, ids, { allowMissing = false } = {}) {
  const rows = [];
  let dropped = 0;
  for (const r of records) {
    if (!finite(r.market_margin) || !finite(r.actual_margin)) { dropped++; continue; }
    const x = ids.map(id => (finite(r.margins?.[id]) ? r.margins[id] : null));
    if (!allowMissing && !x.every(finite)) { dropped++; continue; }
    if (allowMissing && !x.some(finite)) { dropped++; continue; }
    rows.push({
      season: r.season, week: r.week, week_key: r.week_key,
      home: r.home, away: r.away,
      market: r.market_margin, actual: r.actual_margin,
      forecasts: x,
      // Departures from the market: the space in which an edge can exist at all.
      departures: x.map(v => (v == null ? null : v - r.market_margin)),
      marketResidual: r.actual_margin - r.market_margin
    });
  }
  return { ids, rows, dropped };
}

/* ------------------------------------------------------------------ reduction */

/**
 * Choose a small, genuinely independent set of components from the training
 * block, using stage 1's greedy basis in market-residual space.
 *
 * The basis orders components by how little the already-chosen ones explain
 * them. The cut is taken at the first step whose `r2_explained_by_prior`
 * exceeds `maxExplained`: past that point a new column is mostly a restatement
 * of columns already in the set, and admitting it buys collinearity rather than
 * information.
 *
 * Everything here reads ONLY the records it is given. Callers must give it the
 * training block.
 */
export function reduceComponents(trainRecords, {
  candidateIds,
  maxComponents = 6,
  maxExplained = 0.90,
  minCoverage = 0.95,
  // Stage 1's caveat 1, made operational: effective rank is measured on
  // component OUTPUTS, not on their skill, so a component that is perfectly
  // independent and perfectly wrong raises the rank without helping anything.
  // With the screen on, components are first ranked by their own out-of-fold
  // residual skill on the training block and only the survivors compete for a
  // place in the basis. 'none' reproduces the pure-independence basis, which is
  // worth running side by side because the gap between them is the cost of
  // ignoring that caveat.
  skillScreen = 'none',   // 'none' | 'positive_gain' | 'top_n'
  skillTopN = 12
} = {}) {
  const { coverage, rows } = componentCoverage(trainRecords, candidateIds);
  let eligible = candidateIds.filter(id => (coverage.get(id) ?? 0) >= minCoverage);
  const excluded = candidateIds
    .filter(id => (coverage.get(id) ?? 0) < minCoverage)
    .map(id => ({ id, coverage: +(coverage.get(id) ?? 0).toFixed(4) }));
  if (eligible.length < 2) {
    return { selected: eligible, steps: [], excluded_for_coverage: excluded, rows_considered: rows,
      reason: 'fewer than two components cleared the coverage floor' };
  }

  let skillRanking = null;
  if (skillScreen !== 'none') {
    // Reuse the incumbent's own per-component grading so the screen and the
    // incumbent agree about what "skill" means. Its slope is fit on an earlier
    // chronological sub-block of the training data and graded on a later one,
    // so this is not a component choosing itself on its own rows.
    const graded = fitIncumbentMarketResidual(trainRecords, eligible);
    skillRanking = graded.models
      .map(m => ({ id: m.id, residual_rmse_gain: m.residual_rmse_gain, residual_n: m.residual_n }))
      .sort((a, b) => (b.residual_rmse_gain ?? -Infinity) - (a.residual_rmse_gain ?? -Infinity));
    const survivors = skillScreen === 'positive_gain'
      ? skillRanking.filter(m => (m.residual_rmse_gain ?? -Infinity) > 0)
      : skillRanking.slice(0, skillTopN);
    // A screen that empties the pool is a screen that failed, not a reduction
    // to nothing: fall back to the top few by gain and say so.
    const kept = survivors.length >= 2 ? survivors : skillRanking.slice(0, Math.min(4, skillRanking.length));
    eligible = kept.map(m => m.id);
    skillRanking = { rule: skillScreen, kept: eligible, top: skillRanking.slice(0, 10),
      fell_back: survivors.length < 2 };
  }
  if (eligible.length < 2) {
    return { selected: eligible, steps: [], excluded_for_coverage: excluded, rows_considered: rows,
      skill_screen: skillRanking, reason: 'fewer than two components survived the skill screen' };
  }
  const block = buildBlock(trainRecords, eligible);
  if (block.rows.length < 50) {
    return { selected: eligible.slice(0, maxComponents), steps: [], excluded_for_coverage: excluded,
      skill_screen: skillRanking,
      rows_considered: block.rows.length, reason: 'too few complete rows to measure a basis' };
  }
  // Market-residual space: each column is the component's departure from the
  // market, which is what stage 1 identified as the space that decides bets.
  const columns = eligible.map((_, j) => block.rows.map(r => r.departures[j]));
  const basis = greedyBasis(eligible, columns, { limit: Math.min(maxComponents + 4, eligible.length) });

  const selected = [];
  const steps = [];
  for (const step of basis) {
    const explained = step.r2_explained_by_prior;
    const stop = selected.length >= maxComponents
      || (explained != null && explained > maxExplained);
    steps.push({ ...step, admitted: !stop });
    if (stop) break;
    selected.push(step.id);
  }
  return {
    selected, steps, excluded_for_coverage: excluded,
    skill_screen: skillRanking,
    rows_considered: block.rows.length,
    space: 'market_residual',
    cut_rule: `stop at the first step explained by more than ${maxExplained} by prior picks, or at ${maxComponents} components`
  };
}

/* ------------------------------------------------------------------ the incumbent */

/**
 * Replay the production `market_residual` blend exactly.
 *
 * This is a re-implementation rather than a call into `fitEnsemble`, because
 * the comparison has to be fit on precisely the same training block as every
 * other candidate, from precisely the same replayed component forecasts. The
 * arithmetic is copied line for line from `fitEnsemble`: the per-component
 * no-intercept slope fit on an earlier chronological sub-block, the gate on
 * (out-of-fold rows >= 250, RMSE gain >= 0.03, Diebold-Mariano with the
 * Harvey-Leybourne-Newbold correction clustered by week, one-sided p <= 0.05),
 * the exp(-0.7 * residual RMSE) weighting, and the same 3-decimal rounding the
 * production blend actually reads. The naive paired t is still computed
 * alongside and reported as `residual_paired_t`, exactly as `fitEnsemble`
 * does -- for audit continuity, never read by the gate.
 *
 * `test/forecast-combination.test.js` asserts this reproduces `fitEnsemble`'s
 * own slopes, weights and gate decisions on a fixture. If that assertion ever
 * fails, this function is wrong and the incumbent's number in any report
 * produced here is not the incumbent's number.
 */
export function fitIncumbentMarketResidual(trainRecords, componentIdList) {
  const models = [];
  for (const id of componentIdList) {
    const signal = [], actual = [], weekKeys = [];
    for (const r of trainRecords) {
      const m = r.margins?.[id];
      if (!finite(m) || !finite(r.market_margin) || !finite(r.actual_margin)) continue;
      signal.push(m - r.market_margin);
      actual.push(r.actual_margin - r.market_margin);
      weekKeys.push(r.week_key);
    }
    const splitIdx = completeWeekSplit(weekKeys);
    const fitSignal = signal.slice(0, splitIdx), fitActual = actual.slice(0, splitIdx);
    const scoreSignal = signal.slice(splitIdx), scoreActual = actual.slice(splitIdx);
    const scoreWeekKeys = weekKeys.slice(splitIdx);
    const denominator = fitSignal.reduce((s, x) => s + x * x, 0);
    const slope = denominator > 0
      ? fitSignal.reduce((s, x, i) => s + x * fitActual[i], 0) / denominator : 0;
    const baselineMse = scoreActual.length ? mean(scoreActual.map(x => x ** 2)) : null;
    const residualMse = scoreActual.length
      ? mean(scoreActual.map((x, i) => (x - slope * scoreSignal[i]) ** 2)) : null;
    // Same significance leg `fitEnsemble` reads post-FIX #2: DM/HLN, clustered
    // by week (a slate is one forecast period, not one-per-game), one-sided
    // "model beats market". The naive paired t is still computed alongside,
    // exactly as `fitEnsemble` does, and reported but never gates anything.
    const modelLoss = scoreActual.map((x, i) => (x - slope * scoreSignal[i]) ** 2);
    const marketLoss = scoreActual.map(x => x ** 2);
    const dm = dieboldMariano(modelLoss, marketLoss, { horizon: 1, clusters: scoreWeekKeys });
    const naive = naivePairedT(modelLoss, marketLoss);
    const pairedT = naive.ok ? naive.statistic : null;
    const marketRmse = baselineMse == null ? null : Math.sqrt(baselineMse);
    const modelRmse = residualMse == null ? null : Math.sqrt(residualMse);
    const gain = marketRmse == null || modelRmse == null ? null : marketRmse - modelRmse;

    const residualSlope = fitActual.length >= 100 ? r3(slope) : null;
    const residualRmse = residualMse == null ? null : r3(Math.sqrt(residualMse));
    const passed = scoreActual.length >= INCUMBENT_GATE.minScoreRows
      && r3(gain) >= INCUMBENT_GATE.minGain
      && dm.ok === true && dm.pLess <= INCUMBENT_GATE.dmAlpha;
    models.push({
      id, residual_slope: residualSlope, residual_rmse: residualRmse,
      residual_rmse_gain: r3(gain),
      residual_dm_t: dm.ok ? r3(dm.statistic) : null,
      residual_dm_p: dm.ok ? +dm.pLess.toFixed(4) : null,
      residual_dm_weeks: dm.ok ? dm.periods : null,
      residual_dm_ok: dm.ok,
      residual_dm_reason: dm.ok ? null : dm.reason,
      // Superseded; retained for audit continuity, never read by the gate.
      residual_paired_t: r3(pairedT),
      residual_n: scoreActual.length, residual_fit_n: fitActual.length,
      gate_passed: passed,
      raw_weight: passed ? Math.exp(-0.7 * residualRmse) : 0
    });
  }
  const sum = models.reduce((s, m) => s + m.raw_weight, 0);
  for (const m of models) m.residual_weight = sum ? +(m.raw_weight / sum).toFixed(4) : 0;
  return {
    method: 'incumbent_market_residual',
    models,
    gated: models.filter(m => m.gate_passed).map(m => m.id),
    gate: INCUMBENT_GATE,
    // When nothing clears the gate, the production forecast IS the market. That
    // is a design decision, not a failure, and it must be visible in the report
    // so an RMSE equal to the market's is not misread as a coincidence.
    collapses_to_market: models.every(m => !m.gate_passed)
  };
}

/** The incumbent's forecast for one row. */
function incumbentPredict(fit, row, ids) {
  // Production blends over whichever gated components produced a number for
  // THIS game and renormalises over those, so a component abstaining on one
  // game must not silently pull the blend toward the market.
  const contributing = fit.models.filter(m => {
    if (!(m.residual_weight > 0) || m.residual_slope == null) return false;
    const j = ids.indexOf(m.id);
    return j >= 0 && finite(row.forecasts[j]);
  });
  const weight = contributing.reduce((s, m) => s + m.residual_weight, 0);
  if (!(weight > 0)) return row.market;
  let acc = 0;
  for (const m of contributing) {
    const j = ids.indexOf(m.id);
    acc += m.residual_weight * m.residual_slope * (row.forecasts[j] - row.market);
  }
  return row.market + acc / weight;
}

/* ------------------------------------------------------------------ the candidates */

/**
 * Every candidate combination method.
 *
 * `fit` sees the training block only. `predict` sees one held-out row. No
 * method is permitted to see the test block during fitting, which is the entire
 * point of the exercise.
 */
export const COMBINATION_METHODS = {
  /**
   * The market, unmodified. Not a serious candidate — it is the yardstick.
   * A combination that cannot beat this has no business moving a line.
   */
  market_only: {
    label: 'Market (closing line)',
    usesReduction: false,
    fit: () => ({}),
    predict: (_m, row) => row.market
  },

  /** The production blend, replayed. */
  incumbent_market_residual: {
    label: 'Incumbent: gated market-residual blend',
    usesReduction: false,
    fit: (block, { allIds }) => fitIncumbentMarketResidual(block.records, allIds),
    predict: (m, row, ids) => incumbentPredict(m, row, ids)
  },

  /**
   * Equal weights over the reduced set. The forecast-combination literature's
   * most persistent embarrassment for everything more sophisticated.
   */
  equal_weight: {
    label: 'Equal weights (reduced set)',
    usesReduction: true,
    fit: (block) => ({ weights: new Array(block.ids.length).fill(1 / block.ids.length) }),
    predict: (m, row) => row.forecasts.reduce((s, f, j) => s + m.weights[j] * f, 0)
  },

  /**
   * Equal weights over EVERY component, with no reduction at all. Included to
   * answer a question the reduced candidates cannot: does reducing help, or is
   * the averaging doing all the work?
   */
  equal_weight_all: {
    label: 'Equal weights (all components, no reduction)',
    usesReduction: false,
    fit: (block) => ({ n: block.ids.length }),
    predict: (_m, row) => {
      const present = row.forecasts.filter(finite);
      return present.length ? mean(present) : null;
    }
  },

  /**
   * Inverse-MSE weights: w_j proportional to 1/MSE_j, normalised. The other
   * baseline the literature says usually wins — it uses the data, but only
   * through K variances, never through the K x K covariance matrix whose
   * estimation is what makes optimal weights fragile.
   */
  inverse_mse: {
    label: 'Inverse-MSE weights (reduced set)',
    usesReduction: true,
    fit: (block) => {
      const k = block.ids.length;
      const mse = Array.from({ length: k }, (_, j) =>
        mean(block.rows.map(r => (r.forecasts[j] - r.actual) ** 2)));
      const raw = mse.map(v => (v > 0 ? 1 / v : 0));
      const sum = raw.reduce((s, v) => s + v, 0);
      return { weights: sum > 0 ? raw.map(v => v / sum) : new Array(k).fill(1 / k), mse };
    },
    predict: (m, row) => row.forecasts.reduce((s, f, j) => s + m.weights[j] * f, 0)
  },

  /**
   * Granger-Ramanathan (1984) unconstrained regression combination: regress the
   * outcome on the component forecasts with an intercept, no sign or sum
   * restriction. This is the "estimated optimal weights" the puzzle is about.
   */
  ols_granger_ramanathan: {
    label: 'Granger-Ramanathan OLS (reduced set)',
    usesReduction: true,
    fit: (block) => {
      const X = block.rows.map(r => r.forecasts);
      const y = block.rows.map(r => r.actual);
      const f = ols(X, y, { intercept: true });
      return f ?? { intercept: 0, weights: new Array(block.ids.length).fill(1 / block.ids.length),
        degenerate: true };
    },
    predict: (m, row) => m.intercept + row.forecasts.reduce((s, f, j) => s + m.weights[j] * f, 0)
  },

  /**
   * Bates-Granger constrained combination: weights non-negative and summing to
   * one. Keeps the combination inside the convex hull of its inputs, which is
   * the property that makes it degrade gracefully when the weights are wrong.
   */
  constrained_ls: {
    label: 'Constrained LS, weights >= 0 summing to 1 (reduced set)',
    usesReduction: true,
    fit: (block) => {
      const X = block.rows.map(r => r.forecasts);
      const y = block.rows.map(r => r.actual);
      const w = constrainedLeastSquares(X, y);
      return { weights: w ?? new Array(block.ids.length).fill(1 / block.ids.length) };
    },
    predict: (m, row) => row.forecasts.reduce((s, f, j) => s + m.weights[j] * f, 0)
  },

  /**
   * Stock & Watson (2004) shrinkage of estimated weights toward equal weights:
   *   w = lambda * (1/K) + (1 - lambda) * w_hat,
   *   lambda = max(0, 1 - kappa * K / (T - K - 1)).
   * The explicit compromise between the two horns of the puzzle: keep the
   * estimated weights where the sample is large relative to K, fall back to
   * equal weights where it is not. kappa = 1 is the paper's own default.
   */
  shrunk_to_equal: {
    label: 'Stock-Watson shrinkage toward equal weights (reduced set)',
    usesReduction: true,
    fit: (block, { kappa = 1 } = {}) => {
      const k = block.ids.length, T = block.rows.length;
      const X = block.rows.map(r => r.forecasts);
      const y = block.rows.map(r => r.actual);
      const f = ols(X, y, { intercept: false });
      const equal = new Array(k).fill(1 / k);
      if (!f) return { weights: equal, lambda: 1, degenerate: true };
      const denom = T - k - 1;
      const lambda = denom > 0 ? Math.max(0, Math.min(1, 1 - (kappa * k) / denom)) : 1;
      // lambda here is the weight on the ESTIMATED vector, matching the paper's
      // parameterisation: lambda=1 keeps OLS, lambda=0 falls back to equal.
      return {
        weights: f.weights.map((w, j) => lambda * w + (1 - lambda) * equal[j]),
        lambda, ols_weights: f.weights
      };
    },
    predict: (m, row) => row.forecasts.reduce((s, f, j) => s + m.weights[j] * f, 0)
  },

  /**
   * The market-anchored variant of a real combination, and the most direct
   * successor to the incumbent: take the equal-weight combination of the
   * reduced set, measure how much of its departure from the market survived
   * historically, and move that far.
   *
   *   forecast = market + beta * (equal_combination - market)
   *
   * One coefficient, fit without an intercept so that "no departure" is exactly
   * the market. The incumbent fits one such coefficient PER COMPONENT and then
   * averages them, which estimates 31 numbers to answer a one-number question.
   */
  market_anchored_combination: {
    label: 'Market anchor + shrunk combined departure (reduced set)',
    usesReduction: true,
    fit: (block) => {
      const k = block.ids.length;
      const signal = block.rows.map(r => mean(r.departures));
      const target = block.rows.map(r => r.marketResidual);
      const denom = signal.reduce((s, x) => s + x * x, 0);
      const beta = denom > 0 ? signal.reduce((s, x, i) => s + x * target[i], 0) / denom : 0;
      return { beta, k };
    },
    predict: (m, row) => row.market + m.beta * mean(row.departures)
  },

  /**
   * Residual-space regression: forecast = market + sum(b_j * departure_j), with
   * b fit by no-intercept OLS of the market residual on the departures.
   *
   * This is the honest generalisation of the incumbent. The incumbent estimates
   * one slope per component IN ISOLATION and then averages those slopes with
   * exponential weights — which is only the right answer if the departures are
   * uncorrelated, and stage 1 measured that they are the opposite of
   * uncorrelated. Fitting the K coefficients jointly is what accounts for the
   * fact that six components saying the same thing is one piece of evidence,
   * not six.
   *
   * No intercept, by the same reasoning the incumbent uses: zero signal must
   * land exactly on the market, not on a fitted offset.
   */
  residual_ols: {
    label: 'Market + jointly-fit departure weights (reduced set)',
    usesReduction: true,
    fit: (block) => {
      const X = block.rows.map(r => r.departures);
      const y = block.rows.map(r => r.marketResidual);
      const f = ols(X, y, { intercept: false });
      return f ?? { weights: new Array(block.ids.length).fill(0), degenerate: true };
    },
    predict: (m, row) => row.market + row.departures.reduce((s, d, j) => s + m.weights[j] * d, 0)
  },

  /**
   * The same, with the departures constrained to `b >= 0, sum(b) <= 1`.
   *
   * Non-negativity forbids using a component backwards, which unconstrained
   * least squares will happily do when two collinear columns let it cancel
   * noise. The budget of one forbids the blend moving further from the market
   * than its own components collectively claim. Together they are the
   * regularisation that makes a jointly-fit combination survive a new season,
   * and the set still contains zero, so "the market is right" remains available.
   */
  residual_constrained: {
    label: 'Market + constrained departure weights, b>=0 sum<=1 (reduced set)',
    usesReduction: true,
    fit: (block) => {
      const X = block.rows.map(r => r.departures);
      const y = block.rows.map(r => r.marketResidual);
      const w = constrainedLeastSquares(X, y, { project: projectToSubSimplex });
      return { weights: w ?? new Array(block.ids.length).fill(0) };
    },
    predict: (m, row) => row.market + row.departures.reduce((s, d, j) => s + m.weights[j] * d, 0)
  }
};

/* ------------------------------------------------------------------ scoring */

/**
 * Cover probability from the empirical distribution of a method's own training
 * errors.
 *
 * Every method is scored through identical machinery — only the point forecast
 * differs — so a cover-Brier difference is attributable to the combination and
 * not to someone's better-tuned variance model. Using each method's OWN error
 * distribution is the fair version: a method with genuinely wider errors is
 * allowed to say so and is not punished twice.
 *
 * KNOWN BIAS, stated rather than hidden: the error distribution comes from the
 * method's fitted residuals on the TRAINING block, which are in-sample. A method
 * with many free parameters therefore reports a narrower error spread than it
 * really has, and its cover probabilities come out overconfident, which costs it
 * cover-Brier. That penalty falls on the flexible estimated-weight methods and
 * not on the market or the incumbent — so it is conservative with respect to a
 * finding that a flexible method WINS, and must be discounted before treating a
 * flexible method's cover-Brier loss as evidence against it. Fixing it properly
 * needs an inner cross-validation fold inside each training block.
 */
export function coverProbability(sortedErrors, forecast, market) {
  const n = sortedErrors.length;
  if (!n) return null;
  // P(actual > market) = P(forecast + e > market) = P(e > market - forecast).
  const threshold = market - forecast;
  let greater = 0, ties = 0;
  for (const e of sortedErrors) {
    if (e > threshold) greater++;
    else if (e === threshold) ties++;
  }
  return (greater + 0.5 * ties) / n;
}

/** RMSE, MAE and cover-Brier for one method's held-out forecasts. */
export function scoreForecasts(predictions) {
  const errs = predictions.map(p => p.forecast - p.actual);
  if (!errs.length) return { n: 0, rmse: null, mae: null, cover_brier: null, cover_n: null };
  const graded = predictions.filter(p => p.cover_outcome != null && p.cover_probability != null);
  return {
    n: errs.length,
    rmse: +Math.sqrt(mean(errs.map(e => e ** 2))).toFixed(4),
    mae: +mean(errs.map(e => Math.abs(e))).toFixed(4),
    bias: +mean(errs).toFixed(4),
    cover_n: graded.length,
    cover_brier: graded.length
      ? +mean(graded.map(p => (p.cover_probability - p.cover_outcome) ** 2)).toFixed(5)
      : null
  };
}

/* ------------------------------------------------------- split lineage (WP12) */

/**
 * A row's own identity inside a walk-forward split: the thing that goes into a
 * split manifest so the split is reproducible and auditable later.
 *
 * Matches the pairing key `compareMethods` and the pooling step already use,
 * so "the rows this fit trained on" and "the rows this comparison paired" are
 * the same vocabulary rather than two near-identical strings.
 */
export const splitRowId = r => `${r.season}|${r.week}|${r.home}|${r.away}`;

/**
 * A row's GAME identity, when — and only when — the row actually states one.
 *
 * The leak WP12 asks to refuse is "same-game leakage through player/book/
 * horizon rows": several rows describing one game (a per-player prop row, a
 * per-book quote row, a row dated to the horizon it was quoted at rather than
 * to kickoff), where one of them carries a week that disagrees with its game's
 * and so lands on the far side of a (season, week) cutoff from its siblings.
 *
 * Detecting that needs a game identity independent of the row's own dating,
 * and `game_id` is the only trustworthy source of one. Deriving it from
 * season+matchup was tried and is WRONG: it silently assumes an ordered
 * (home, away) pair meets at most once per season. That happens to hold for
 * real NFL schedules and does NOT hold for every record stream this function
 * accepts — the module's own synthetic fixtures recycle sixteen matchups
 * through a season, and a derived key would report each recycled matchup as a
 * straddling game that had leaked, which is a false alarm, not a finding.
 *
 * So identity is read, never inferred. When rows do not carry it, the check
 * is reported as not-verifiable rather than as a pass (R28: an uncomputable
 * check is not a clean one).
 */
export const splitGameId = r => r.game_id ?? null;

const sha256Short = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

/**
 * One cutoff's immutable split manifest.
 *
 * The hash is over the SORTED row-id list, so it is a content address for the
 * split itself: the same rows in a different order hash identically, and a
 * single row moving across the boundary does not. That is what makes a stored
 * manifest checkable against a later re-run rather than merely descriptive.
 *
 * Full id lists are attached only when the caller asks (`includeSplitRowIds`).
 * A weekly walk-forward over five seasons is ~90 cutoffs, and every one of them
 * carrying a few thousand ids would bury the report this module deliberately
 * keeps readable — but the hash is always present, so the cheap check ("is this
 * the same split I recorded last time") never requires the expensive payload.
 */
function buildSplitManifest(train, test, { includeRowIds = false } = {}) {
  const trainIds = train.map(splitRowId).sort();
  const testIds = test.map(splitRowId).sort();
  const stated = [...train, ...test].filter(r => splitGameId(r) != null).length;
  const manifest = {
    train_rows: train.length,
    test_rows: test.length,
    train_hash: sha256Short(trainIds.join('\n')),
    test_hash: sha256Short(testIds.join('\n')),
    // Whether the same-game straddle check could actually run, stated rather
    // than implied by its silence. `partial` means some rows named their game
    // and some did not: the named ones were checked, the rest could not be.
    game_grouping: stated === 0 ? 'not_verifiable_no_game_id'
      : stated === train.length + test.length ? 'verified_by_game_id' : 'partial_game_id_coverage'
  };
  if (stated) {
    manifest.train_games = new Set(train.map(splitGameId).filter(Boolean)).size;
    manifest.test_games = new Set(test.map(splitGameId).filter(Boolean)).size;
  }
  if (includeRowIds) { manifest.train_row_ids = trainIds; manifest.test_row_ids = testIds; }
  return manifest;
}

/**
 * Refuses a cutoff whose training block and test block share a game.
 *
 * Throws rather than filtering, deliberately. A straddling game means some
 * row's own dating disagrees with its game's, and every number computed past
 * that point — the reduction basis, the fitted weights, the held-out score —
 * is contaminated in a way that silently dropping the row would hide. The
 * whole comparison is invalid, so the run stops and says which game did it.
 */
function assertNoSameGameStraddle(train, test, { season, week }) {
  const trainGames = new Set(train.map(splitGameId).filter(id => id != null));
  if (!trainGames.size) return; // nothing states a game identity: not checkable, see the manifest
  const straddling = [...new Set(test.map(splitGameId).filter(id => id != null))]
    .filter(id => trainGames.has(id));
  if (!straddling.length) return;
  throw new Error(
    `forecast combination: same-game leakage at cutoff ${season}` +
    `${week == null ? '' : ` week ${week}`} — ${straddling.length} game(s) have rows in BOTH the ` +
    `training and held-out blocks (e.g. ${straddling[0]}). A row whose own season/week disagrees ` +
    'with its game\'s will split a single game across the cutoff; the fit and every score past it ' +
    'are contaminated, so this refuses rather than dropping the row and continuing.');
}

/* ------------------------------------------------------------------ walk-forward */

/**
 * Walk forward across held-out seasons.
 *
 * The cutoff is refit at whatever cadence `refit` says, and the default is
 * WEEKLY because that is what production does: `ensembleLine` calls
 * `fitEnsemble({ beforeSeason, beforeWeek })` for the specific week it is
 * forecasting, so the incumbent's weights are re-derived every week from every
 * game final before it. A season-cadence harness would hand the incumbent
 * staler weights than it really runs on and quietly handicap the thing this
 * bake-off is supposed to be measuring fairly.
 *
 * At each cutoff the reduction AND every candidate's weights are fit on rows
 * strictly before it, then applied to that week's games and never revisited.
 * Results are pooled for the headline and also reported per season, so a result
 * that lives in one season is visible as such.
 *
 * The component forecasts themselves arrive already walk-forward from
 * `componentPredictionStream`, so the only thing this adds — and the only thing
 * that could have leaked — is the combination weights.
 */
export function walkForwardCombination({
  records,
  componentIdList,
  testSeasons,
  methods = Object.keys(COMBINATION_METHODS),
  reduction = {},
  refit = 'week',
  minTrainRows = 200,
  // WP12: attach every cutoff's full train/test row-id list to its manifest.
  // Off by default for report size; the content hash is always present either
  // way, so verifying a split against a recorded one never needs this on.
  includeSplitRowIds = false
} = {}) {
  if (!records?.length) return { error: 'no component prediction records supplied' };
  if (!testSeasons?.length) return { error: 'no test seasons supplied' };

  const perMethod = new Map(methods.map(m => [m, []]));
  const seasonReports = [];
  const seasonSet = new Set(testSeasons);

  // Every cutoff this walk-forward will visit, in chronological order. At
  // season cadence there is one cutoff per season (week 1); at week cadence
  // there is one per week that actually has games.
  const cutoffs = [];
  for (const season of [...testSeasons].sort((a, b) => a - b)) {
    if (refit === 'season') { cutoffs.push({ season, week: null }); continue; }
    const weeks = [...new Set(records.filter(r => r.season === season).map(r => r.week))]
      .sort((a, b) => a - b);
    for (const week of weeks) cutoffs.push({ season, week });
  }

  const before = (r, season, week) =>
    (week == null ? r.season < season : r.season < season || (r.season === season && r.week < week));

  const seasonAccumulator = new Map();
  for (const season of seasonSet) {
    seasonAccumulator.set(season, { season, cutoffs: [], predictions: new Map(methods.map(m => [m, []])) });
  }

  for (const { season, week } of cutoffs) {
    const train = records.filter(r => before(r, season, week));
    const test = records.filter(r => r.season === season && (week == null || r.week === week));
    const acc = seasonAccumulator.get(season);
    if (!test.length) { acc.cutoffs.push({ week, skipped: 'no rows' }); continue; }
    if (train.length < minTrainRows) {
      acc.cutoffs.push({ week, skipped: `only ${train.length} training rows` });
      continue;
    }

    // (0) WP12 lineage: refuse a split that puts one game on both sides, then
    //     record the split's own content-addressed identity. Checked only on
    //     cutoffs that actually fit — a skipped cutoff contaminates nothing.
    assertNoSameGameStraddle(train, test, { season, week });
    const splitManifest = buildSplitManifest(train, test, { includeRowIds: includeSplitRowIds });

    // (1) Reduce, on the training block only.
    const reduced = reduceComponents(train, { candidateIds: componentIdList, ...reduction });
    const reducedIds = reduced.selected;
    if (reducedIds.length < 2) {
      acc.cutoffs.push({ week, skipped: `reduction returned ${reducedIds.length} components` });
      continue;
    }

    // (2) Two blocks: the reduced one for combination methods, and a full one
    //     for methods that deliberately do not reduce. They are built
    //     separately because listwise deletion over 31 columns would throw away
    //     rows the reduced methods can legitimately score.
    const trainReduced = buildBlock(train, reducedIds);
    const testReduced = buildBlock(test, reducedIds);
    const allIdsWithCoverage = componentIdList.filter(id => {
      const { coverage } = componentCoverage(train, [id]);
      return (coverage.get(id) ?? 0) > 0;
    });
    const trainAll = buildBlock(train, allIdsWithCoverage, { allowMissing: true });
    const testAll = buildBlock(test, allIdsWithCoverage, { allowMissing: true });

    const cutoffEntry = {
      week,
      train_rows: train.length, test_rows: test.length,
      split_manifest: splitManifest,
      reduction: reduced,
      reduced_ids: reducedIds,
      reduced_complete_rows: { train: trainReduced.rows.length, test: testReduced.rows.length },
      full_complete_rows: { train: trainAll.rows.length, test: testAll.rows.length },
      fits: {}
    };

    for (const name of methods) {
      const spec = COMBINATION_METHODS[name];
      if (!spec) continue;
      const block = spec.usesReduction ? trainReduced : trainAll;
      const testBlock = spec.usesReduction ? testReduced : testAll;
      const ids = spec.usesReduction ? reducedIds : allIdsWithCoverage;
      // The incumbent grades itself on per-component coverage, exactly as
      // production does, so it is handed the raw records rather than a
      // listwise-deleted block.
      const fitted = spec.fit({ ...block, records: train }, { allIds: componentIdList });

      // The method's own training-error distribution, for cover probabilities.
      const trainErrors = block.rows
        .map(r => r.actual - spec.predict(fitted, r, ids))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);

      const preds = testBlock.rows.map(r => {
        const forecast = spec.predict(fitted, r, ids);
        const coverOutcome = r.actual > r.market ? 1 : r.actual < r.market ? 0 : null;
        return {
          season: r.season, week: r.week, week_key: r.week_key,
          home: r.home, away: r.away,
          market: r.market, actual: r.actual, forecast,
          cover_outcome: coverOutcome,
          cover_probability: coverProbability(trainErrors, forecast, r.market)
        };
      }).filter(p => Number.isFinite(p.forecast));

      perMethod.get(name).push(...preds);
      acc.predictions.get(name).push(...preds);
      cutoffEntry.fits[name] = summariseFit(name, fitted, ids);
    }
    acc.cutoffs.push(cutoffEntry);
  }

  // Collapse the per-cutoff detail into one row per season. Keeping every
  // weekly fit would make the report unreadable, so the season keeps its own
  // scores, the bases it used (with how often each was chosen) and the first
  // and last cutoff's fits, which is what a reader actually checks.
  for (const season of [...seasonSet].sort((a, b) => a - b)) {
    const acc = seasonAccumulator.get(season);
    const fitted = acc.cutoffs.filter(c => !c.skipped);
    if (!fitted.length) {
      seasonReports.push({ season, skipped: acc.cutoffs[0]?.skipped ?? 'no usable cutoffs' });
      continue;
    }
    const basisCounts = new Map();
    for (const c of fitted) {
      for (const id of c.reduced_ids) basisCounts.set(id, (basisCounts.get(id) ?? 0) + 1);
    }
    const methodScores = {};
    for (const name of methods) {
      methodScores[name] = {
        ...scoreForecasts(acc.predictions.get(name)),
        fit_summary: fitted.at(-1).fits[name]
      };
    }
    seasonReports.push({
      season,
      cutoffs: fitted.length,
      refit,
      train_rows: { first: fitted[0].train_rows, last: fitted.at(-1).train_rows },
      test_rows: fitted.reduce((s, c) => s + c.test_rows, 0),
      // Every component that entered a basis this season, and in how many of
      // the season's cutoffs. A basis that churns every week is itself a
      // finding about how stable the reduction is.
      basis_usage: [...basisCounts.entries()].sort((a, b) => b[1] - a[1])
        .map(([id, n]) => ({ id, cutoffs: n, share: +(n / fitted.length).toFixed(3) })),
      reduced_ids: fitted.at(-1).reduced_ids,
      basis_churn: +(new Set(fitted.flatMap(c => c.reduced_ids)).size / (fitted.at(-1).reduced_ids.length || 1)).toFixed(2),
      methods: methodScores,
      // WP12 lineage: one manifest per fitted cutoff, in order. Unlike the fit
      // summaries above (collapsed to first/last for readability) these are
      // kept in full — a split record that only covers some of the season's
      // cutoffs cannot answer "was this fit trained on what it claims", which
      // is the only question a manifest exists to answer.
      split_manifests: fitted.map(c => ({ week: c.week, ...c.split_manifest })),
      skipped_cutoffs: acc.cutoffs.filter(c => c.skipped).map(c => ({ week: c.week, reason: c.skipped }))
    });
  }

  // Pool on the games EVERY method scored. Methods that tolerate a missing
  // component keep more rows than methods that must listwise-delete, and
  // comparing an RMSE computed on 900 games against one computed on 820 is a
  // comparison of samples, not of methods. Each method's own-sample numbers are
  // kept alongside so the size of that effect stays visible.
  const keyOf = p => `${p.season}|${p.week}|${p.home}|${p.away}`;
  const keySets = [...perMethod.values()].map(preds => new Set(preds.map(keyOf)));
  const common = keySets.length
    ? [...keySets[0]].filter(k => keySets.every(s => s.has(k)))
    : [];
  const commonSet = new Set(common);

  const pooled = {};
  for (const [name, preds] of perMethod) {
    const onCommon = preds.filter(p => commonSet.has(keyOf(p)));
    pooled[name] = {
      ...scoreForecasts(onCommon),
      label: COMBINATION_METHODS[name].label,
      own_sample: scoreForecasts(preds)
    };
  }
  return {
    seasons: seasonReports, pooled, predictions: perMethod, methods, refit,
    common_sample: { games: common.length,
      per_method_rows: Object.fromEntries([...perMethod].map(([n, p]) => [n, p.length])) }
  };
}

/** A compact, readable description of what a method actually fitted. */
function summariseFit(name, fitted, ids) {
  if (name === 'incumbent_market_residual') {
    return { gated_components: fitted.gated, collapses_to_market: fitted.collapses_to_market,
      weights: fitted.models.filter(m => m.residual_weight > 0)
        .map(m => ({ id: m.id, weight: m.residual_weight, slope: m.residual_slope })) };
  }
  if (name === 'market_anchored_combination') return { beta: +fitted.beta.toFixed(4), components: ids };
  if (fitted.weights) {
    return {
      lambda: fitted.lambda == null ? undefined : +fitted.lambda.toFixed(4),
      intercept: fitted.intercept == null ? undefined : +fitted.intercept.toFixed(4),
      weights: ids.map((id, j) => ({ id, weight: +fitted.weights[j].toFixed(4) })),
      weight_sum: +fitted.weights.reduce((s, w) => s + w, 0).toFixed(4),
      // Large opposite-signed weights are the signature of an ill-conditioned
      // combination, and are worth seeing next to the out-of-sample number.
      max_abs_weight: +Math.max(...fitted.weights.map(Math.abs)).toFixed(4)
    };
  }
  return {};
}

/* ------------------------------------------------------------------ significance */

/**
 * Pairwise Diebold-Mariano over pooled held-out squared errors, clustered by
 * week.
 *
 * Only rows both methods scored are compared, and the pairing is by game rather
 * than by position, because two methods can survive listwise deletion on
 * different subsets and a positional pairing would then silently compare
 * different games.
 */
export function compareMethods(predictions, methodA, methodB, { horizon = 1, cluster = true } = {}) {
  const keyOf = p => `${p.season}|${p.week}|${p.home}|${p.away}`;
  const a = new Map((predictions.get(methodA) ?? []).map(p => [keyOf(p), p]));
  const b = new Map((predictions.get(methodB) ?? []).map(p => [keyOf(p), p]));
  const keys = [...a.keys()].filter(k => b.has(k));
  if (keys.length < 2) return { ok: false, reason: 'fewer than 2 shared games' };
  // Chronological order matters to the autocovariance, so sort explicitly
  // rather than trusting Map insertion order across two filtered sets.
  keys.sort((x, y) => {
    const [sx, wx] = x.split('|'), [sy, wy] = y.split('|');
    return Number(sx) - Number(sy) || Number(wx) - Number(wy) || (x < y ? -1 : 1);
  });
  const lossA = keys.map(k => (a.get(k).forecast - a.get(k).actual) ** 2);
  const lossB = keys.map(k => (b.get(k).forecast - b.get(k).actual) ** 2);
  const clusters = cluster ? keys.map(k => k.split('|').slice(0, 2).join('|')) : null;
  const dm = dieboldMariano(lossA, lossB, { horizon, clusters });
  const naive = naivePairedT(lossA, lossB);
  return {
    ok: dm.ok, a: methodA, b: methodB, shared_games: keys.length,
    dm,
    // Reported beside DM, never instead of it: the ratio between the two is how
    // much dependence the sample carried.
    naive_paired_t: naive.ok ? +naive.statistic.toFixed(4) : null,
    inflation: dm.ok && naive.ok && dm.statistic !== 0
      ? +(Math.abs(naive.statistic / dm.statistic)).toFixed(3) : null
  };
}

/**
 * The full comparison table: every candidate against the incumbent, and every
 * candidate against the best pooled RMSE, with the DM verdict attached.
 */
export function significanceTable(result, { baseline = 'incumbent_market_residual', alpha = 0.05 } = {}) {
  const ranked = Object.entries(result.pooled)
    .filter(([, v]) => v.rmse != null)
    .sort((x, y) => x[1].rmse - y[1].rmse);
  if (!ranked.length) return { error: 'no method produced a scoreable forecast' };
  const [bestName] = ranked[0];

  const vsBaseline = result.methods
    .filter(m => m !== baseline)
    .map(m => {
      const c = compareMethods(result.predictions, m, baseline);
      return {
        method: m, baseline,
        rmse: result.pooled[m]?.rmse ?? null,
        baseline_rmse: result.pooled[baseline]?.rmse ?? null,
        dm_statistic: c.ok ? +c.dm.statistic.toFixed(4) : null,
        dm_p_one_sided_better: c.ok ? +c.dm.pLess.toFixed(4) : null,
        dm_periods: c.ok ? c.dm.periods : null,
        dm_observations: c.ok ? c.dm.observations : null,
        naive_paired_t: c.naive_paired_t,
        significantly_better: c.ok ? c.dm.pLess < alpha : false,
        significantly_worse: c.ok ? c.dm.pGreater < alpha : false,
        reason: c.ok ? null : (c.reason ?? c.dm?.reason ?? null)
      };
    });

  const vsBest = result.methods
    .filter(m => m !== bestName)
    .map(m => {
      const c = compareMethods(result.predictions, bestName, m);
      return {
        best: bestName, other: m,
        dm_statistic: c.ok ? +c.dm.statistic.toFixed(4) : null,
        // "best beats other" is the one-sided direction here.
        dm_p_best_better: c.ok ? +c.dm.pLess.toFixed(4) : null,
        distinguishable: c.ok ? c.dm.pLess < alpha : false
      };
    });

  return {
    ranking: ranked.map(([name, v]) => ({ method: name, label: v.label, rmse: v.rmse,
      cover_brier: v.cover_brier, n: v.n })),
    best_by_rmse: bestName,
    alpha,
    vs_baseline: vsBaseline,
    vs_best: vsBest,
    // The honest headline. If the best method cannot be distinguished from the
    // simplest one at this alpha, the simplest one is the recommendation.
    best_distinguishable_from_equal_weight: (() => {
      if (bestName === 'equal_weight') return null;
      const c = compareMethods(result.predictions, bestName, 'equal_weight');
      return c.ok ? { dm_statistic: +c.dm.statistic.toFixed(4), p: +c.dm.pLess.toFixed(4),
        distinguishable: c.dm.pLess < alpha } : { error: c.reason ?? c.dm?.reason };
    })()
  };
}
