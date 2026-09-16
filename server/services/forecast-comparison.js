/**
 * Honest comparison of two forecasts on the same events.
 *
 * WHY THIS EXISTS
 * ---------------
 * The question "is forecast A more accurate than forecast B" is answered all
 * over this repository by a paired t-test on per-game squared errors: take
 * d_i = loss_A(i) - loss_B(i), divide the mean by the naive standard error
 * s/sqrt(n), and compare to 1.645. That statistic is only valid when the d_i
 * are independent and identically distributed. Forecast loss differentials
 * are neither:
 *
 *   1. CONTEMPORANEOUS CORRELATION. Every game on one Sunday slate is forecast
 *      from the same information set, by the same fitted coefficients, under
 *      the same league-wide conditions (the same injury cycle, the same market
 *      state, the same week of opponent data). If the model happens to be
 *      mis-tuned that week it is mis-tuned on all fourteen games at once. The
 *      slate is closer to ONE observation than to fourteen, and treating it as
 *      fourteen inflates the apparent sample size by the within-week design
 *      effect -- which shows up directly as an inflated t-statistic, since the
 *      standard error carries a 1/sqrt(n).
 *
 *   2. SERIAL CORRELATION FROM OVERLAP. When forecasts are made h steps ahead,
 *      or when a fitted coefficient is reused across periods, consecutive loss
 *      differentials share information and d_t is serially correlated up to
 *      lag h-1. The i.i.d. standard error ignores those autocovariances
 *      entirely.
 *
 * Diebold & Mariano (1995) is the standard instrument for exactly this
 * problem: the same mean differential, but divided by a heteroskedasticity-
 * and-autocorrelation-consistent (HAC) standard error built from the
 * autocovariances of d_t. Harvey, Leybourne & Newbold (1997) showed that the
 * DM statistic still over-rejects in small samples and supplied the finite-
 * sample correction and the Student-t reference distribution used below.
 *
 * WHAT IS AND IS NOT A CORRECTION
 * -------------------------------
 * There is an exact identity worth knowing before reading any number this
 * module produces (and it is asserted in test/diebold-mariano.test.js):
 *
 *     with horizon = 1 and no clustering, DM* is EXACTLY the paired t.
 *
 * The HLN factor at h = 1 is sqrt((T-1)/T), which precisely cancels the
 * difference between the HAC variance's 1/T divisor and the sample variance's
 * 1/(T-1), and both are then referred to t_{T-1}. So this module does not
 * "disagree with the paired t" by construction or by fiat. It reduces to it.
 * Every divergence you see is attributable to one of the two real effects
 * above being present in the data -- which is what makes the comparison an
 * honest measurement rather than a different opinion.
 *
 * HOW CLUSTERING IS HANDLED
 * -------------------------
 * DM is a time-series statistic: one forecast per period. A week of NFL games
 * is one period, not fourteen. `clusters` therefore aggregates each cluster's
 * loss differentials to that cluster's MEAN differential and runs DM over the
 * resulting series of period statistics. Any correlation structure inside a
 * week -- however strong, of whatever shape -- is then absorbed into the
 * variance of the weekly means across weeks, which is estimated from the data
 * rather than assumed away. This costs sample size (T becomes the number of
 * weeks), and that cost is the honest price of the dependence being real.
 *
 * Clusters are weighted equally, so a 13-game bye week counts the same as a
 * 16-game slate. That is the right unit when the week is the independent
 * replication; it does mean the reported mean differential is the mean of
 * weekly means rather than the mean over games, and the two differ slightly
 * when slate sizes differ. Both are reported.
 *
 * SIGN CONVENTION
 * ---------------
 * d = lossA - lossB throughout. A NEGATIVE statistic means A had the lower
 * loss, i.e. forecast A is the more accurate one. This matches the existing
 * `residual_paired_t <= -1.645` convention in nfl-ensemble.js, where A is the
 * model and B is the market.
 *
 * HOW LARGE THE CORRECTION ACTUALLY IS, MEASURED
 * ----------------------------------------------
 * Measured 2026-09-12 on 660 real NFL games (2023-2025, 63 weekly slates, the
 * market-lab spread panel), comparing the OPENING line against the CLOSING
 * line as forecasts of the home margin -- a real pair of NFL margin forecasts
 * with the same structure, and nearly the same magnitudes, as the ensemble's
 * own model-vs-market comparison:
 *
 *     open RMSE 12.768   close RMSE 12.350
 *     naive paired t      = 4.066  (df 659)
 *     DM*, week-clustered = 3.146  (df 62)
 *     inflation factor 1.29, i.e. a design effect of 1.67
 *     within-week ICC of the loss differential = 0.067 on ~10.5-game slates
 *
 * So on real NFL data the old statistic was overstated by roughly 30%. That is
 * large enough to matter at the margin and much too large to ignore -- but it
 * is NOT large enough to overturn a strongly significant result. A verdict at
 * |t| = 4.5 would need a 2.2x inflation (an ICC near 0.42, six times what real
 * slates show) before it stopped clearing a 5% threshold. Expect this
 * correction to change decisions in the 1.6 < |t| < 2.6 band, and to leave the
 * emphatic results standing.
 *
 * References:
 *   Diebold, F.X. & Mariano, R.S. (1995), "Comparing Predictive Accuracy",
 *     Journal of Business & Economic Statistics 13(3), 253-263.
 *   Harvey, D., Leybourne, S. & Newbold, P. (1997), "Testing the equality of
 *     prediction mean squared errors", International Journal of Forecasting
 *     13(2), 281-291.
 */

/* ------------------------------------------------------------------ */
/* Student-t distribution                                              */
/* ------------------------------------------------------------------ */

/**
 * Continued-fraction expansion of the incomplete beta function
 * (Lentz's method; Numerical Recipes 6.4). Converges for x < (a+1)/(a+b+2);
 * `regularizedIncompleteBeta` below applies the symmetry transform otherwise.
 */
function betaContinuedFraction(x, a, b) {
  const TINY = 1e-30, EPS = 3e-16, MAX_ITER = 300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    // Even step.
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    // Odd step.
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Lanczos approximation to log-gamma; the normalizing constant for the beta CF. */
function logGamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

/** Regularized incomplete beta I_x(a,b). */
export function regularizedIncompleteBeta(x, a, b) {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b)
    + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? front * betaContinuedFraction(x, a, b) / a
    : 1 - front * betaContinuedFraction(1 - x, b, a) / b;
}

/** CDF of Student's t with `df` degrees of freedom. */
export function studentTCdf(t, df) {
  if (!Number.isFinite(t) || !(df > 0)) return NaN;
  const p = 0.5 * regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t > 0 ? 1 - p : p;
}

/* ------------------------------------------------------------------ */
/* Diebold-Mariano                                                     */
/* ------------------------------------------------------------------ */

const meanOf = a => a.reduce((s, x) => s + x, 0) / a.length;

/**
 * Autocovariance of `d` at lag k, using the 1/T divisor of the DM paper
 * (NOT 1/(T-k)) -- the 1/T form is what the HLN small-sample factor was
 * derived against, and mixing divisors would silently mis-scale the result.
 */
function autocovariance(d, dBar, k) {
  const T = d.length;
  let s = 0;
  for (let t = k; t < T; t++) s += (d[t] - dBar) * (d[t - k] - dBar);
  return s / T;
}

/**
 * Collapse each cluster to its mean differential, preserving the order in
 * which clusters first appear. Order matters: DM's autocovariances are
 * meaningless on a shuffled series, so callers must pass `d` already in
 * chronological order (which is exactly what the ensemble's `residuals[].week`
 * manifest guarantees).
 */
function collapseClusters(d, clusters) {
  const order = [];
  const sums = new Map();
  const counts = new Map();
  for (let i = 0; i < d.length; i++) {
    const key = String(clusters[i]);
    if (!sums.has(key)) { order.push(key); sums.set(key, 0); counts.set(key, 0); }
    sums.set(key, sums.get(key) + d[i]);
    counts.set(key, counts.get(key) + 1);
  }
  return {
    labels: order,
    series: order.map(k => sums.get(k) / counts.get(k)),
    sizes: order.map(k => counts.get(k))
  };
}

/**
 * Diebold-Mariano test of equal predictive accuracy, with the
 * Harvey-Leybourne-Newbold small-sample correction.
 *
 * @param {number[]} lossA  per-observation loss of forecast A (e.g. squared error)
 * @param {number[]} lossB  per-observation loss of forecast B, same events, same order
 * @param {object}  [opts]
 * @param {number}  [opts.horizon=1]   forecast horizon h; d_t is treated as MA(h-1)
 * @param {Array}   [opts.clusters]    per-observation cluster label (e.g. `${season}|${week}`)
 * @param {string}  [opts.kernel='truncated'] 'truncated' (DM/HLN original) or 'bartlett'
 * @returns {object} statistic, p-values, and the full diagnostic trail
 *
 * Returns `{ ok: false, reason }` rather than throwing when the sample cannot
 * support the test -- a gate that silently sees `null` is safer than one that
 * sees a number manufactured from two observations.
 */
export function dieboldMariano(lossA, lossB, {
  horizon = 1,
  clusters = null,
  kernel = 'truncated'
} = {}) {
  if (!Array.isArray(lossA) || !Array.isArray(lossB) || lossA.length !== lossB.length) {
    return { ok: false, reason: 'loss arrays must be arrays of equal length' };
  }
  const h = Math.max(1, Math.round(horizon));

  // Pair up, dropping any observation either forecast could not score. Both
  // arrays are indexed by the same event, so a drop must remove the pair.
  const raw = [];
  const rawClusters = [];
  for (let i = 0; i < lossA.length; i++) {
    if (!Number.isFinite(lossA[i]) || !Number.isFinite(lossB[i])) continue;
    raw.push(lossA[i] - lossB[i]);
    if (clusters) rawClusters.push(clusters[i]);
  }
  if (raw.length < 2) return { ok: false, reason: 'fewer than 2 paired observations' };

  const observations = raw.length;
  const observationMean = meanOf(raw);

  let d = raw, clusterSizes = null, clusterCount = null;
  if (clusters) {
    if (clusters.length !== lossA.length) {
      return { ok: false, reason: 'clusters must be the same length as the loss arrays' };
    }
    const collapsed = collapseClusters(raw, rawClusters);
    d = collapsed.series;
    clusterSizes = collapsed.sizes;
    clusterCount = collapsed.labels.length;
  }

  const T = d.length;
  if (T < 2) return { ok: false, reason: 'fewer than 2 forecast periods after clustering' };

  // Two separate ways a horizon can be too long for the sample, and both must
  // be refused rather than reported.
  //
  // First: estimating h-1 autocovariances needs more than h periods to
  // estimate them from. Past that point `autocovariance` simply sums an empty
  // range and returns 0, so the long-run variance would quietly be built out
  // of lags that were never measured -- a number, but a fictional one. Note
  // that the HLN factor alone does NOT catch this: T + 1 - 2h + h(h-1)/T is a
  // parabola in h and turns positive again for large h (at T=8, h=12 it is
  // +1.5), so relying on it would let the worst cases through.
  //
  // Second: inside the range where the factor is meaningful, it can still go
  // non-positive, and a negative variance under a square root is not a result.
  const hlnNumerator = T + 1 - 2 * h + h * (h - 1) / T;
  if (h >= T) {
    return { ok: false, reason: `horizon ${h} needs more than ${T} forecast periods` };
  }
  if (h > 1 && hlnNumerator <= 0) {
    return { ok: false, reason: `horizon ${h} too large for ${T} forecast periods` };
  }

  const dBar = meanOf(d);
  const gamma = [];
  for (let k = 0; k < h; k++) gamma.push(autocovariance(d, dBar, k));

  const longRun = (kind) => {
    let s = gamma[0];
    for (let k = 1; k < h; k++) {
      const weight = kind === 'bartlett' ? 1 - k / h : 1;
      s += 2 * weight * gamma[k];
    }
    return s;
  };

  // The truncated (rectangular) kernel is the original DM estimator, but it is
  // not guaranteed positive semi-definite: a strongly negative autocovariance
  // can drive the long-run variance below zero, at which point the square root
  // is imaginary and the statistic does not exist. Bartlett weights are
  // guaranteed non-negative, so fall back to them and SAY SO in the result
  // rather than quietly returning a number from a different estimator.
  let kernelUsed = kernel === 'bartlett' ? 'bartlett' : 'truncated';
  let longRunVariance = longRun(kernelUsed);
  if (!(longRunVariance > 0) && kernelUsed === 'truncated') {
    kernelUsed = 'bartlett-fallback';
    longRunVariance = longRun('bartlett');
  }
  if (!(longRunVariance > 0)) {
    kernelUsed = 'lag0-fallback';
    longRunVariance = gamma[0];
  }
  if (!(longRunVariance > 0)) {
    return { ok: false, reason: 'zero variance in the loss differential' };
  }

  const variance = longRunVariance / T;
  const dm = dBar / Math.sqrt(variance);
  const hlnFactor = Math.sqrt(hlnNumerator / T);
  const dmStar = dm * hlnFactor;
  const df = T - 1;

  const cdf = studentTCdf(dmStar, df);
  return {
    ok: true,
    // The corrected statistic, and the reference distribution it belongs to.
    // Read `statistic` in place of the old paired t; it carries the same sign
    // convention (negative = forecast A more accurate).
    statistic: dmStar,
    dmRaw: dm,
    df,
    hlnFactor,
    // One-sided "A is more accurate than B", the direction the ensemble gate
    // asks about; and the two-sided p for general reporting.
    pLess: cdf,
    pGreater: 1 - cdf,
    pTwoSided: 2 * Math.min(cdf, 1 - cdf),
    // Diagnostics. `periods` is the sample size the statistic actually has;
    // `observations` is the one the naive paired t would have claimed, and the
    // ratio between them is the honesty of the whole exercise.
    periods: T,
    observations,
    clustered: Boolean(clusters),
    clusters: clusterCount,
    meanLossDiff: dBar,
    meanLossDiffPerObservation: observationMean,
    horizon: h,
    kernel: kernelUsed,
    longRunVariance,
    autocovariances: gamma,
    minClusterSize: clusterSizes ? Math.min(...clusterSizes) : null,
    maxClusterSize: clusterSizes ? Math.max(...clusterSizes) : null
  };
}

/**
 * The statistic this module replaces, kept as a first-class function so the
 * two can be reported side by side in any audit. Same sign convention.
 *
 * This is NOT deprecated-and-hidden: seeing both numbers is how a reader
 * learns how much dependence was in the sample. It just must never be the
 * thing a gate reads.
 */
export function naivePairedT(lossA, lossB) {
  const d = [];
  for (let i = 0; i < lossA.length; i++) {
    if (!Number.isFinite(lossA[i]) || !Number.isFinite(lossB[i])) continue;
    d.push(lossA[i] - lossB[i]);
  }
  if (d.length < 2) return { ok: false, reason: 'fewer than 2 paired observations' };
  const n = d.length, m = meanOf(d);
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  if (!(sd > 0)) return { ok: false, reason: 'zero variance in the loss differential' };
  const t = m / (sd / Math.sqrt(n));
  const cdf = studentTCdf(t, n - 1);
  return { ok: true, statistic: t, df: n - 1, n, meanLossDiff: m, pLess: cdf, pGreater: 1 - cdf,
    pTwoSided: 2 * Math.min(cdf, 1 - cdf) };
}

export const __testables = { autocovariance, collapseClusters, logGamma };

/* ------------------------------------------------------------------------
 * FINAL ORDER #4 (2026-09-16, RUNBOOK §10.4): Giacomini-White conditional
 * predictive ability.
 *
 * WHY THIS, WHEN DM IS ALREADY HERE. Diebold-Mariano answers "was A more
 * accurate than B ON AVERAGE over this sample". That is an UNCONDITIONAL
 * question, and it is the wrong one for how this repository actually
 * forecasts. Our models are REFIT at every walk-forward cutoff, so the thing
 * being compared is not a fixed pair of forecasts but a pair of METHODS whose
 * parameters move. Giacomini-White (2006) is the test built for exactly that
 * case, and it asks the sharper question: given what was knowable at the time,
 * could you have predicted WHEN one method would beat the other? A method that
 * is better on average but never predictably so is far less useful than the
 * average suggests -- and a method with no average edge can still be
 * conditionally valuable.
 *
 * Diebold's own 2012 retrospective makes the related point this codebase has
 * been ignoring: DM was designed to compare FORECASTS, not to adjudicate
 * between MODELS, which is what the residual gate has been using it for.
 *
 * THE TEST. With loss differential dL_t and a conditioning vector h_{t-1}
 * containing only information available before t, the null of equal
 * conditional predictive ability implies E[h_{t-1} * dL_t] = 0. Form
 * Z_t = h_{t-1} * dL_t, and the Wald statistic
 *
 *     W = n * Zbar' * Omega^-1 * Zbar  ~  chi-squared(q)
 *
 * where q is the width of h and Omega is a HAC estimate of Z's long-run
 * covariance. With h = [1] (the constant alone) this reduces to the squared
 * unconditional t-statistic, i.e. to DM -- which is the property the test
 * below pins.
 *
 * HONEST LIMITS. The chi-squared reference is asymptotic; GW has no
 * Harvey-Leybourne-Newbold-style small-sample correction, so on the ~18-week
 * samples this codebase usually has, treat a marginal p-value as no evidence
 * rather than weak evidence. The default conditioning vector (constant plus
 * one lag of dL) is the standard minimal choice, not a tuned one -- a
 * conditioning set chosen after seeing results is a specification search, and
 * the whole point of this test is to stop doing that.
 * ---------------------------------------------------------------------- */

/** Chi-squared survival function, via the regularized upper incomplete gamma. */
function chiSquaredSf(x, df) {
  if (!(x > 0)) return 1;
  const a = df / 2, xx = x / 2;
  // Series for the lower regularized gamma when x < a+1, continued fraction otherwise.
  const lgamma = z => {
    const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    z -= 1; let x2 = c[0];
    for (let i = 1; i < g + 2; i++) x2 += c[i] / (z + i);
    const t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x2);
  };
  if (xx < a + 1) {
    let sum = 1 / a, term = sum;
    for (let n = 1; n < 500; n++) { term *= xx / (a + n); sum += term; if (Math.abs(term) < Math.abs(sum) * 1e-14) break; }
    const lower = sum * Math.exp(-xx + a * Math.log(xx) - lgamma(a));
    return Math.max(0, Math.min(1, 1 - lower));
  }
  let b = xx + 1 - a, c2 = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c2 = b + an / c2; if (Math.abs(c2) < 1e-300) c2 = 1e-300;
    d = 1 / d; const del = d * c2; h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.max(0, Math.min(1, h * Math.exp(-xx + a * Math.log(xx) - lgamma(a))));
}

/** Invert a small symmetric matrix by Gauss-Jordan; returns null if singular. */
function invertSmall(matrix) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const p = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (!f) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map(row => row.slice(n));
}

/**
 * Giacomini-White test of equal CONDITIONAL predictive ability.
 *
 * @param {number[]} lossA      per-period loss of method A, chronological
 * @param {number[]} lossB      per-period loss of method B, same periods/order
 * @param {object}  [opts]
 * @param {number[][]} [opts.h] conditioning vectors, one row per period, each
 *                              row containing only information available
 *                              BEFORE that period. Default: [1, lagged dL].
 * @param {number}  [opts.lags] HAC lag truncation; default floor(n^(1/3)).
 * @returns {object} `{ ok, statistic, df, p, ... }`, or `{ ok:false, reason }`
 *                   when the sample cannot support the test.
 */
export function giacominiWhite(lossA, lossB, { h = null, lags = null } = {}) {
  if (!Array.isArray(lossA) || !Array.isArray(lossB) || lossA.length !== lossB.length) {
    return { ok: false, reason: 'loss arrays must be arrays of equal length' };
  }
  const dAll = lossA.map((a, i) => a - lossB[i]);
  if (!dAll.every(Number.isFinite)) return { ok: false, reason: 'loss differential contains non-finite values' };

  // Default conditioning set: constant + one lag of the differential, so the
  // first observation is dropped (it has no lag). A caller-supplied `h` is
  // used as given and must already be lagged.
  let rows, d;
  if (h == null) {
    rows = []; d = [];
    for (let t = 1; t < dAll.length; t++) { rows.push([1, dAll[t - 1]]); d.push(dAll[t]); }
  } else {
    if (h.length !== dAll.length) return { ok: false, reason: 'conditioning matrix must have one row per period' };
    rows = h; d = dAll;
  }
  const n = d.length;
  const q = rows[0]?.length ?? 0;
  if (!q) return { ok: false, reason: 'conditioning vector is empty' };
  if (n < 8 * q) return { ok: false, reason: `too few periods (${n}) for ${q} conditioning terms` };

  // Z_t = h_{t-1} * dL_t, and its mean.
  const Z = rows.map((hr, t) => hr.map(v => v * d[t]));
  const zBar = Array.from({ length: q }, (_, j) => Z.reduce((s, zt) => s + zt[j], 0) / n);

  // HAC (Newey-West, Bartlett) long-run covariance of Z.
  const L = lags == null ? Math.max(1, Math.floor(Math.cbrt(n))) : Math.max(0, lags);
  const omega = Array.from({ length: q }, () => new Array(q).fill(0));
  const centered = Z.map(zt => zt.map((v, j) => v - zBar[j]));
  for (let k = 0; k <= L; k++) {
    const w = k === 0 ? 1 : 2 * (1 - k / (L + 1));
    const gamma = Array.from({ length: q }, () => new Array(q).fill(0));
    for (let t = k; t < n; t++) {
      for (let i2 = 0; i2 < q; i2++) {
        for (let j = 0; j < q; j++) gamma[i2][j] += centered[t][i2] * centered[t - k][j];
      }
    }
    for (let i2 = 0; i2 < q; i2++) {
      for (let j = 0; j < q; j++) {
        // symmetrise the k>0 blocks, which is what makes Omega a valid covariance
        omega[i2][j] += w * (k === 0 ? gamma[i2][j] / n : (gamma[i2][j] + gamma[j][i2]) / (2 * n));
      }
    }
  }
  const inv = invertSmall(omega);
  if (!inv) return { ok: false, reason: 'conditioning terms are collinear or have no variance' };

  let statistic = 0;
  for (let i2 = 0; i2 < q; i2++) {
    for (let j = 0; j < q; j++) statistic += zBar[i2] * inv[i2][j] * zBar[j];
  }
  statistic *= n;
  if (!Number.isFinite(statistic) || statistic < 0) {
    return { ok: false, reason: 'Wald statistic is not finite -- covariance is near-singular' };
  }
  const p = chiSquaredSf(statistic, q);
  const meanD = d.reduce((a, b) => a + b, 0) / n;
  return {
    ok: true,
    statistic: +statistic.toFixed(6),
    df: q,
    p: +p.toFixed(6),
    periods: n,
    hac_lags: L,
    mean_loss_differential: +meanD.toFixed(6),
    // Sign convention matches dieboldMariano's: negative favours A.
    favours: meanD < 0 ? 'A' : meanD > 0 ? 'B' : 'neither',
    note: 'Conditional equal predictive ability (Giacomini-White 2006). Asymptotic '
      + 'chi-squared reference and no small-sample correction: on short samples treat a '
      + 'marginal p as no evidence rather than weak evidence.'
  };
}
