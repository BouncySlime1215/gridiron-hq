/**
 * How many independent signals does the 31-component NFL ensemble actually
 * have?
 *
 * Two independent audits reached the same suspicion: `nfl-ensemble.js` carries
 * roughly thirty-one components, but only a handful carry genuinely
 * independent information — the rest are correlated restatements of the same
 * few underlying facts, and the blend is largely a shrinkage toward the
 * market's own price. The section-8.6 family ablation found only two of the
 * thirty-one conclusively contributing.
 *
 * That is a claim about the rank of a matrix, and it is measurable. This
 * module measures it. It changes no forecast, no weight and no blend: it
 * replays the ensemble's own walk-forward component predictions through
 * `componentPredictionStream` — the exact same loop `fitEnsemble` grades on,
 * so a difference between what is measured here and what the ensemble sees is
 * impossible — and reports the correlation structure, the spectrum, and the
 * per-component redundancy.
 *
 * Two spaces are analysed, and the distinction matters more than any single
 * number:
 *
 *   raw_margin       Each component's projected home margin. These are almost
 *                    guaranteed to be highly correlated: every one of them is
 *                    mostly answering "is the home team better than the away
 *                    team," and they agree about that because it is usually
 *                    obvious. A low effective rank here is expected and is not
 *                    by itself evidence of anything wrong.
 *
 *   market_residual  Each component's forecast MINUS the market's margin. This
 *                    is the space that decides bets: the market already prices
 *                    the obvious, so only the deviations can carry an edge. The
 *                    effective rank here is the number that answers the audits'
 *                    question, and it is the headline of this report.
 *
 * Nothing here proves a component is worthless. Redundancy is not the same as
 * uselessness — two components can be near-perfectly correlated and both be
 * correct, and dropping one changes nothing while dropping both changes a lot.
 * What this measures is how many DIRECTIONS of disagreement exist, which is the
 * ceiling on how much the ensemble's size can be buying.
 */
import { rows, run } from '../db/index.js';
import {
  componentPredictionStream, ensembleReplayInputs, componentIds, fitEnsemble
} from './nfl-ensemble.js';

export const ENSEMBLE_RANK_VERSION = 'nfl-ensemble-rank-v1';

/** Below this many usable forecasts a component is not measurable, not redundant. */
const MIN_COMPONENT_ROWS = 200;
/** Below this many complete rows the spectrum is noise, and is reported as unavailable. */
const MIN_COMPLETE_ROWS = 200;
/** Ridge added to the correlation matrix diagonal before inversion, for the VIF identity. */
const VIF_RIDGE = 1e-8;

/* ------------------------------------------------------------ linear algebra */

export const meanOf = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

/** Population standard deviation. */
export function sdOf(a) {
  if (a.length < 2) return 0;
  const m = meanOf(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}

/** Pearson correlation. Returns null when either side does not vary. */
export function pearson(x, y) {
  if (x.length !== y.length || x.length < 3) return null;
  const mx = meanOf(x), my = meanOf(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) {
    const a = x[i] - mx, b = y[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx <= 0 || dy <= 0) return null;
  return num / Math.sqrt(dx * dy);
}

/**
 * Eigen-decomposition of a real symmetric matrix by the cyclic Jacobi method.
 *
 * Jacobi rather than a faster QR iteration on purpose: the matrix here is at
 * most 31x31, it is a correlation matrix (symmetric, positive semi-definite,
 * frequently near-singular — which is exactly the finding), and Jacobi is
 * numerically dependable on near-singular symmetric input without pivoting
 * heuristics. Speed is irrelevant at this size; being right about a matrix
 * whose smallest eigenvalues are the interesting part is not.
 *
 * @returns {{values:number[], vectors:number[][]}} eigenvalues descending, with
 *   `vectors[i]` the unit eigenvector for `values[i]`.
 */
export function symmetricEigen(matrix, { sweeps = 100, tolerance = 1e-12 } = {}) {
  const n = matrix.length;
  const a = matrix.map(row => [...row]);
  // V accumulates the rotations; its COLUMNS are the eigenvectors.
  const v = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] ** 2;
    if (off <= tolerance) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) <= tolerance) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j][j] - a[i][i]);
  return {
    values: order.map(i => a[i][i]),
    vectors: order.map(i => v.map(row => row[i]))
  };
}

/** Gauss-Jordan inverse with a small ridge, or null when hopelessly singular. */
export function inverse(matrix, ridge = VIF_RIDGE) {
  const n = matrix.length;
  const m = matrix.map((row, i) => [
    ...row.map((x, j) => (i === j ? x + ridge : x)),
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  ]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-14) return null;
    [m[c], m[p]] = [m[p], m[c]];
    const pivot = m[c][c];
    for (let k = c; k < 2 * n; k++) m[c][k] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c];
      if (f === 0) continue;
      for (let k = c; k < 2 * n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map(row => row.slice(n));
}

/** Ordinary least squares slope and intercept of y on x. */
export function regress(x, y) {
  if (x.length !== y.length || x.length < 3) return null;
  const mx = meanOf(x), my = meanOf(y);
  let num = 0, den = 0;
  for (let i = 0; i < x.length; i++) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2; }
  if (den <= 0) return null;
  const b1 = num / den;
  const b0 = my - b1 * mx;
  const r = pearson(x, y);
  return { b0, b1, r2: r == null ? null : r * r, n: x.length };
}

/* --------------------------------------------------------- rank of a matrix */

/**
 * How many independent directions a correlation matrix really contains.
 *
 * Three numbers rather than one, because "effective rank" has no single
 * definition and quoting whichever is most flattering is how this kind of
 * analysis goes wrong:
 *
 *   participation_ratio  (Σλ)² / Σλ² — the inverse of the normalised spectral
 *     concentration. Heavily dominated by the largest eigenvalues, so it reads
 *     LOW when one direction explains most of the variance. This is the
 *     strictest of the three and the one most comparable to "how many signals
 *     are really driving this."
 *
 *   entropy_rank  exp(H) where H is the Shannon entropy of the normalised
 *     eigenvalues (Roy & Vetterli). Counts a direction that carries any
 *     appreciable variance, so it reads HIGHER than the participation ratio
 *     whenever there is a long tail of small-but-nonzero directions.
 *
 *   components_for_90/95/99  The blunt, assumption-free answer: how many
 *     principal components you must keep to retain that share of variance.
 *
 * When these disagree, the disagreement is the finding: a low participation
 * ratio with a high 95% count means one dominant signal plus a crowd of small
 * ones, which is a different problem from three equal signals.
 */
export function spectrumMetrics(eigenvalues) {
  const positive = eigenvalues.map(v => Math.max(0, v));
  const total = positive.reduce((s, v) => s + v, 0);
  if (total <= 0) return null;
  const share = positive.map(v => v / total);
  const sumSquares = positive.reduce((s, v) => s + v * v, 0);
  const entropy = -share.filter(p => p > 0).reduce((s, p) => s + p * Math.log(p), 0);
  const countFor = threshold => {
    let acc = 0;
    for (let i = 0; i < share.length; i++) {
      acc += share[i];
      if (acc >= threshold) return i + 1;
    }
    return share.length;
  };
  return {
    dimensions: eigenvalues.length,
    participation_ratio: +((total * total) / sumSquares).toFixed(3),
    entropy_rank: +Math.exp(entropy).toFixed(3),
    components_for_90pct: countFor(0.90),
    components_for_95pct: countFor(0.95),
    components_for_99pct: countFor(0.99),
    top_eigenvalue_share: +share[0].toFixed(4),
    top3_eigenvalue_share: +share.slice(0, 3).reduce((s, v) => s + v, 0).toFixed(4),
    // A correlation matrix has trace = p, so an eigenvalue above 1 means that
    // direction explains more than one variable's worth of variance. The
    // Kaiser count is crude and is reported for comparability, not authority.
    kaiser_count: positive.filter(v => v > 1).length,
    eigenvalues: positive.map(v => +v.toFixed(5)),
    explained_variance: share.map(v => +v.toFixed(5))
  };
}

/* ------------------------------------------------------------ matrix builder */

/**
 * Turn the per-game component forecasts into a rectangular matrix.
 *
 * Columns are components that produced at least `minRows` forecasts. Rows are
 * games where EVERY selected column produced one — listwise deletion, because
 * a correlation matrix assembled from pairwise-complete subsets is not
 * guaranteed positive semi-definite and its eigenvalues can come out negative,
 * which would make every rank number below meaningless. The cost is reported
 * (`rows_complete` against `rows_total`) rather than hidden: a component that
 * abstains often shrinks the sample for everyone, and that is worth seeing.
 */
export function buildMatrix(records, { space = 'market_residual', minRows = MIN_COMPONENT_ROWS, catalogIds = [] } = {}) {
  // The catalog is unioned in so a component that abstained on EVERY game is
  // reported as a zero-coverage drop rather than vanishing from the report
  // entirely. "Never produced a forecast" and "was not measured" look identical
  // in a table that only lists the columns it found.
  const ids = [...new Set([...catalogIds, ...records.flatMap(r => Object.keys(r.values))])];
  const coverage = new Map(ids.map(id => [id, records.filter(r => r.values[id] != null).length]));
  const kept = ids.filter(id => coverage.get(id) >= minRows);
  const dropped = ids.filter(id => coverage.get(id) < minRows).map(id => ({
    id, forecasts: coverage.get(id),
    reason: coverage.get(id) === 0
      ? 'abstained on every game in this window — no margin forecast to correlate'
      : `fewer than ${minRows} usable forecasts`
  }));

  const complete = records.filter(r => kept.every(id => r.values[id] != null));
  const columns = kept.map(id => complete.map(r => r.values[id]));
  // A column with no variance cannot be correlated with anything; including it
  // would put a NaN row and column into the matrix and silently poison every
  // eigenvalue. It is dropped and named.
  const varying = kept.filter((id, j) => sdOf(columns[j]) > 1e-9);
  for (const id of kept) {
    if (!varying.includes(id)) {
      dropped.push({ id, forecasts: coverage.get(id), reason: 'constant across every complete row' });
    }
  }
  return {
    space,
    ids: varying,
    columns: varying.map(id => complete.map(r => r.values[id])),
    week_keys: complete.map(r => r.week_key),
    rows_total: records.length,
    rows_complete: complete.length,
    coverage: Object.fromEntries(coverage),
    dropped
  };
}

/** Pearson correlation matrix of the columns. */
export function correlationMatrix(columns) {
  const p = columns.length;
  const m = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    m[i][i] = 1;
    for (let j = i + 1; j < p; j++) {
      const r = pearson(columns[i], columns[j]) ?? 0;
      m[i][j] = r; m[j][i] = r;
    }
  }
  return m;
}

/**
 * Per-component redundancy from the variance-inflation identity.
 *
 * For standardised columns, the R² of regressing component j on ALL the others
 * is 1 - 1/(R⁻¹)_jj. That is the honest definition of "does this component say
 * anything the rest of the ensemble does not already say" — far stronger than
 * the pairwise maximum correlation, which misses a component that is a linear
 * combination of three others while correlating only moderately with each.
 */
export function redundancy(ids, correlation) {
  const inv = inverse(correlation);
  if (!inv) return null;
  return ids.map((id, j) => {
    const vif = inv[j][j];
    const r2 = vif > 0 ? Math.min(1, Math.max(0, 1 - 1 / vif)) : 0;
    let best = null;
    for (let k = 0; k < ids.length; k++) {
      if (k === j) continue;
      if (best == null || Math.abs(correlation[j][k]) > Math.abs(correlation[j][best])) best = k;
    }
    return {
      id,
      r2_vs_all_others: +r2.toFixed(5),
      unique_variance: +(1 - r2).toFixed(5),
      variance_inflation_factor: +Math.min(vif, 1e9).toFixed(3),
      closest_component: best == null ? null : ids[best],
      closest_correlation: best == null ? null : +correlation[j][best].toFixed(4)
    };
  });
}

/**
 * A greedy independent basis: repeatedly take the component least explainable
 * by the ones already taken.
 *
 * This is the practical output the next stage needs. The spectrum says how many
 * independent directions exist; this says WHICH components span them, in an
 * order a human can audit. The first entry is the seed (the component with the
 * most variance to explain), and each subsequent entry reports the R² of
 * regressing it on everything chosen so far — once that number is high for
 * every remaining candidate, the ensemble has run out of new information.
 */
export function greedyBasis(ids, columns, { limit = 10 } = {}) {
  const remaining = ids.map((id, j) => j);
  const chosen = [];
  const out = [];
  // Seed with the component whose forecast set is most "central" — the one with
  // the highest total absolute correlation to the rest, i.e. the best single
  // summary of what the ensemble collectively believes.
  const corr = correlationMatrix(columns);
  let seed = 0, bestMass = -1;
  for (let j = 0; j < ids.length; j++) {
    const mass = corr[j].reduce((s, v, k) => s + (k === j ? 0 : Math.abs(v)), 0);
    if (mass > bestMass) { bestMass = mass; seed = j; }
  }
  const take = (j, r2) => {
    chosen.push(j);
    remaining.splice(remaining.indexOf(j), 1);
    out.push({ id: ids[j], step: out.length + 1, r2_explained_by_prior: r2 });
  };
  take(seed, null);

  while (remaining.length && out.length < limit) {
    let pick = null, pickR2 = Infinity;
    for (const j of remaining) {
      const r2 = multipleR2(corr, j, chosen);
      if (r2 < pickR2) { pickR2 = r2; pick = j; }
    }
    if (pick == null) break;
    take(pick, +pickR2.toFixed(5));
  }
  return out;
}

/**
 * R² of regressing standardised column `target` on standardised columns
 * `predictors`, computed from the correlation submatrix: R² = r' S⁻¹ r.
 */
export function multipleR2(correlation, target, predictors) {
  if (!predictors.length) return 0;
  const s = predictors.map(i => predictors.map(j => correlation[i][j]));
  const inv = inverse(s);
  if (!inv) return 1;
  const r = predictors.map(i => correlation[target][i]);
  let acc = 0;
  for (let i = 0; i < r.length; i++) {
    for (let j = 0; j < r.length; j++) acc += r[i] * inv[i][j] * r[j];
  }
  return Math.min(1, Math.max(0, acc));
}

/* ---------------------------------------------------------------- the report */

/** Loadings of each component on the leading principal components. */
function loadingTable(ids, eigen, keep) {
  return ids.map((id, j) => ({
    id,
    loadings: Array.from({ length: keep }, (_, k) =>
      +(eigen.vectors[k][j] * Math.sqrt(Math.max(0, eigen.values[k]))).toFixed(4)),
    // Which single principal component this component speaks for most loudly.
    primary_pc: (() => {
      let best = 0;
      for (let k = 1; k < keep; k++) {
        if (Math.abs(eigen.vectors[k][j]) > Math.abs(eigen.vectors[best][j])) best = k;
      }
      return best + 1;
    })()
  }));
}

/** One space's full analysis. */
function analyseSpace(records, space, { minRows, topPCs, catalogIds }) {
  const matrix = buildMatrix(records, { space, minRows, catalogIds });
  if (matrix.rows_complete < MIN_COMPLETE_ROWS || matrix.ids.length < 2) {
    return {
      space,
      available: false,
      reason: `only ${matrix.rows_complete} rows where all ${matrix.ids.length} measurable components ` +
        `produced a forecast (need ${MIN_COMPLETE_ROWS}); the spectrum of a matrix this thin is noise, ` +
        'and reporting an effective rank from it would be a fabricated measurement',
      rows_total: matrix.rows_total,
      rows_complete: matrix.rows_complete,
      components_measured: matrix.ids.length,
      dropped: matrix.dropped
    };
  }
  const correlation = correlationMatrix(matrix.columns);
  const eigen = symmetricEigen(correlation);
  const keep = Math.min(topPCs, matrix.ids.length);
  return {
    space,
    available: true,
    components_measured: matrix.ids.length,
    rows_total: matrix.rows_total,
    rows_complete: matrix.rows_complete,
    dropped: matrix.dropped,
    spectrum: spectrumMetrics(eigen.values),
    loadings: loadingTable(matrix.ids, eigen, keep),
    redundancy: redundancy(matrix.ids, correlation),
    greedy_independent_basis: greedyBasis(matrix.ids, matrix.columns),
    correlation: {
      ids: matrix.ids,
      matrix: correlation.map(row => row.map(v => +v.toFixed(4))),
      mean_abs_offdiagonal: +(() => {
        let s = 0, n = 0;
        for (let i = 0; i < correlation.length; i++) {
          for (let j = i + 1; j < correlation.length; j++) { s += Math.abs(correlation[i][j]); n++; }
        }
        return n ? s / n : 0;
      })().toFixed(4)
    }
  };
}

/**
 * Measure how much the blend is a restatement of the market.
 *
 * The audits' shrinkage claim ("forecast ≈ 0.68 + 0.632·market") is a
 * regression coefficient, so it is checked by running that regression on the
 * blend this code actually produces. Both blend modes are reported because
 * they answer different questions: `raw` is the performance-weighted mean of
 * the components, `market_residual` is the production research forecast, which
 * starts AT the market by construction and can only be moved by components
 * that cleared the residual gate — so a slope near 1 there is the design, not
 * a defect, and the informative number is how far the forecast travels from
 * the market at all.
 */
function marketShrinkage(records) {
  const out = {};
  for (const mode of ['raw', 'market_residual']) {
    const pairs = records.filter(r => r.blend[mode] != null && r.market_margin != null);
    if (pairs.length < 100) { out[mode] = { available: false, n: pairs.length }; continue; }
    const market = pairs.map(r => r.market_margin);
    const blend = pairs.map(r => r.blend[mode]);
    const fit = regress(market, blend);
    const deviation = pairs.map(r => Math.abs(r.blend[mode] - r.market_margin));
    out[mode] = {
      available: true, n: pairs.length,
      intercept: +fit.b0.toFixed(4),
      slope_on_market: +fit.b1.toFixed(4),
      r2: +fit.r2.toFixed(4),
      mean_abs_departure_from_market: +meanOf(deviation).toFixed(3),
      sd_of_departure: +sdOf(pairs.map(r => r.blend[mode] - r.market_margin)).toFixed(3)
    };
  }
  return out;
}

/**
 * The full component-rank report.
 *
 * Measurement only. Nothing in this function writes a weight, changes a blend,
 * or promotes or demotes a component.
 */
export function componentRankReport({
  beforeSeason = null, beforeWeek = null, minSeason = null,
  minRows = MIN_COMPONENT_ROWS, topPCs = 6, includeChallengers = true
} = {}) {
  const catalog = componentIds();
  const inputs = minSeason == null
    ? ensembleReplayInputs({ beforeSeason })
    : ensembleReplayInputs({ beforeSeason, minSeason });
  if (inputs.all.length < 200) {
    return { error: `only ${inputs.all.length} games available — sync game lines first` };
  }
  const fit = fitEnsemble({ beforeSeason, beforeWeek, includeChallengers });
  const weightById = new Map((fit.models ?? []).map(m => [m.id, m]));

  const raw = [], residual = [], blendRows = [];
  // Counted so a component that is TOTAL-ONLY by design (it forecasts a game
  // total and never a margin) is not reported as having "abstained" from a
  // margin-space analysis it was never eligible for.
  const totalCoverage = new Map(catalog.map(c => [c.id, 0]));
  for (const row of componentPredictionStream({ ...inputs, beforeSeason, beforeWeek })) {
    const rawValues = {}, residualValues = {};
    for (const c of catalog) {
      if (!includeChallengers && c.challenger_only) continue;
      if (row.totals[c.id] != null) totalCoverage.set(c.id, totalCoverage.get(c.id) + 1);
      const m = row.margins[c.id];
      if (m == null) continue;
      rawValues[c.id] = m;
      if (row.market_margin != null) residualValues[c.id] = m - row.market_margin;
    }
    raw.push({ week_key: row.week_key, values: rawValues });
    if (row.market_margin != null) residual.push({ week_key: row.week_key, values: residualValues });

    // The two blends, reconstructed from the same weights ensembleLine uses.
    let wsum = 0, acc = 0;
    let rsum = 0, racc = 0;
    for (const c of catalog) {
      const m = row.margins[c.id];
      if (m == null) continue;
      const scored = weightById.get(c.id);
      if (!scored) continue;
      if (!includeChallengers && scored.challenger_only) continue;
      if (scored.margin_weight > 0) { wsum += scored.margin_weight; acc += scored.margin_weight * m; }
      if (scored.residual_weight > 0 && scored.residual_slope != null && row.market_margin != null) {
        rsum += scored.residual_weight;
        racc += scored.residual_weight * scored.residual_slope * (m - row.market_margin);
      }
    }
    blendRows.push({
      market_margin: row.market_margin,
      actual_margin: row.actual_margin,
      blend: {
        raw: wsum > 0 ? acc / wsum : null,
        market_residual: row.market_margin == null ? null
          : (rsum > 0 ? row.market_margin + racc / rsum : row.market_margin)
      }
    });
  }

  const measurable = catalog
    .filter(c => includeChallengers || !c.challenger_only)
    .map(c => c.id);
  const spaces = {
    raw_margin: analyseSpace(raw, 'raw_margin', { minRows, topPCs, catalogIds: measurable }),
    market_residual: analyseSpace(residual, 'market_residual', { minRows, topPCs, catalogIds: measurable })
  };
  for (const space of Object.values(spaces)) {
    for (const d of space.dropped ?? []) {
      const totals = totalCoverage.get(d.id) ?? 0;
      if (d.forecasts === 0 && totals > 0) {
        d.reason = `forecasts game totals only (${totals} total forecasts, no margin) — out of scope ` +
          'for a margin-space rank analysis, not a component that failed to produce one';
        d.total_forecasts = totals;
      }
    }
  }

  return {
    version: ENSEMBLE_RANK_VERSION,
    generated_at: new Date().toISOString(),
    cutoff: beforeSeason == null ? null : { season: beforeSeason, week: beforeWeek ?? 1 },
    include_challengers: includeChallengers,
    catalog_size: catalog.length,
    games_available: inputs.all.length,
    spaces,
    // How many components are actually permitted to move the production
    // research forecast off the market. When this is zero, `market_residual`
    // below will report slope 1 and zero departure -- not because the blend is
    // shrinking heavily, but because it IS the market, by design. Reporting the
    // gate alongside the regression stops that being read as a shrinkage
    // finding when it is a gate finding.
    residual_gate: {
      passed: (fit.models ?? []).filter(m => m.residual_weight > 0).map(m => ({
        id: m.id, residual_weight: m.residual_weight, residual_slope: m.residual_slope,
        residual_rmse_gain: m.residual_rmse_gain, residual_paired_t: m.residual_paired_t,
        residual_n: m.residual_n
      })),
      diagnostic_passed_but_not_weighted: (fit.models ?? [])
        .filter(m => m.residual_diagnostic_passed && !(m.residual_weight > 0)).map(m => m.id),
      total_catalog: catalog.length
    },
    market_shrinkage: marketShrinkage(blendRows),
    headline: headline(spaces),
    interpretation_notes: [
      'The effective rank of the market_residual space is the number that answers "how many ' +
        'independent signals does this ensemble have". The raw_margin space is expected to be ' +
        'near rank one and that is not a finding.',
      'Redundancy is not uselessness. A component with r2_vs_all_others near 1 adds nothing the ' +
        'rest do not already say, but removing it and its correlates together removes real signal.',
      'Effective rank is measured on component OUTPUTS, not on their skill. A perfectly independent ' +
        'component that is also perfectly wrong raises the rank without helping anything. Pair this ' +
        'report with the residual-skill statistics in fitEnsemble before acting on it.'
    ]
  };
}

function headline(spaces) {
  const s = spaces.market_residual;
  if (!s?.available) return { measured: false, reason: s?.reason ?? 'no measurable space' };
  return {
    measured: true,
    components_in_catalog: s.components_measured,
    participation_ratio: s.spectrum.participation_ratio,
    entropy_rank: s.spectrum.entropy_rank,
    components_for_95pct_variance: s.spectrum.components_for_95pct,
    top_eigenvalue_share: s.spectrum.top_eigenvalue_share,
    components_with_unique_variance_over_10pct:
      s.redundancy.filter(r => r.unique_variance > 0.10).map(r => r.id)
  };
}

/* ------------------------------------------------------------- persistence */

/**
 * Store a report so the next stage can act on it and a human can audit the
 * reasoning that produced it. `nfl_ensemble_rank_reports` is created lazily
 * here rather than in a migration because this is a diagnostic ledger, not
 * model state — nothing reads it to make a forecast.
 */
export function saveRankReport(report, { label = 'default' } = {}) {
  run(`CREATE TABLE IF NOT EXISTS nfl_ensemble_rank_reports (
         label TEXT NOT NULL,
         version TEXT NOT NULL,
         cutoff TEXT,
         created_at TEXT NOT NULL,
         report_json TEXT NOT NULL,
         PRIMARY KEY (label, version, cutoff)
       )`);
  const cutoff = report.cutoff ? `${report.cutoff.season}|${report.cutoff.week}` : 'live';
  run(`INSERT INTO nfl_ensemble_rank_reports (label,version,cutoff,created_at,report_json)
       VALUES (?,?,?,datetime('now'),?)
       ON CONFLICT(label,version,cutoff) DO UPDATE SET
         created_at=excluded.created_at, report_json=excluded.report_json`,
  label, report.version, cutoff, JSON.stringify(report));
  return { label, version: report.version, cutoff };
}

const tableExists = name => rows(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, name).length > 0;

/**
 * The stored reports, newest first.
 *
 * nfl_ensemble_rank_reports is created only by saveRankReport, on its first
 * call — genuinely absent until then, which is the one case `[]` correctly
 * means "nothing here yet". A bare catch around the whole read could not
 * tell that apart from a real fault (a corrupt report_json row, a locked
 * database), and reported both the same silent way. Checked explicitly now;
 * once the table exists, a read error is a real fault and throws.
 */
export function rankReports({ label = null } = {}) {
  if (!tableExists('nfl_ensemble_rank_reports')) return [];
  const where = label ? 'WHERE label = ?' : '';
  const args = label ? [label] : [];
  return rows(`SELECT label,version,cutoff,created_at,report_json FROM nfl_ensemble_rank_reports
               ${where} ORDER BY created_at DESC`, ...args)
    .map(r => ({ ...r, report: JSON.parse(r.report_json) }));
}
