/**
 * Small statistical helpers shared by the matchup, projection and simulation layers.
 */

/**
 * Empirical-Bayes shrinkage toward a prior.
 *
 * The single most useful line of statistics in this codebase. A split measured over
 * three games is mostly noise; one measured over thirty is mostly signal. This blends
 * observation and prior in proportion to how much evidence there actually is.
 *
 * @param observed  what the sample says
 * @param prior     what to fall back on with no evidence (league or player baseline)
 * @param n         effective sample size
 * @param k         evidence at which observation and prior carry equal weight
 */
export const shrink = (observed, prior, n, k) =>
  n > 0 ? (n * observed + k * prior) / (n + k) : prior;

/**
 * Anscombe/arcsine variance-stabilizing transform for a proportion, and its
 * inverse. A raw proportion's sampling variance is p(1-p)/n — smallest near 0
 * or 1, largest near 0.5 — so blending two proportions with a single fixed k
 * (as `shrink` does) over-corrects near the middle of the range and
 * under-corrects near the edges. Transforming first makes the variance
 * ~1/(4n) regardless of p, so one k applies uniformly. Maps [0,1] -> [0, pi].
 */
export const arcsine = p => 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, p))));
export const arcsineInverse = y => Math.sin(Math.max(0, Math.min(Math.PI, y)) / 2) ** 2;

/**
 * Empirical-Bayes shrinkage for a RATE (a win/score/occurrence frequency),
 * done in the arcsine-stabilized domain rather than directly on the raw
 * proportion — the rate-stat sibling of `shrink`. Use this instead of `shrink`
 * whenever `observed` and `prior` are both proportions in [0,1] (a team's
 * first-inning score rate, a venue's YRFI rate, a hit rate, ...); keep using
 * plain `shrink` for stats that are not bounded proportions (counts, per-game
 * rates like attempts/game, ratios centered elsewhere than [0,1]).
 *
 * `k === Infinity` means "no detectable between-group variance" (see
 * shrinkage-fit.js's fitK) — trust the prior completely rather than let the
 * formula divide Infinity by Infinity into NaN.
 */
export const shrinkRate = (observed, prior, n, k) => {
  if (!(n > 0)) return prior;
  if (k === Infinity) return prior;
  return arcsineInverse(shrink(arcsine(observed), arcsine(prior), n, k));
};

export const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export function weightedMean(values, weights) {
  const w = weights.reduce((s, x) => s + x, 0);
  return w ? values.reduce((s, v, i) => s + v * weights[i], 0) / w : 0;
}

export function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/** Quantile of an unsorted array, linearly interpolated. */
export function quantile(a, q) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const percentiles = (a, qs = [0.05, 0.25, 0.5, 0.75, 0.95]) =>
  Object.fromEntries(qs.map(q => [`p${Math.round(q * 100)}`, +(quantile(a, q) ?? 0).toFixed(1)]));

/* --------------------------------------------------------------- samplers */

let rng = Math.random;

/** Deterministic PRNG for reproducible replays and regression tests. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export const random = () => rng();

/** Runs one synchronous simulation with a seed, then restores normal randomness. */
export function withRandomSeed(seed, fn) {
  if (seed == null || seed === '') return fn();
  const prior = rng;
  rng = mulberry32(Number(seed) || 1);
  try { return fn(); } finally { rng = prior; }
}

const _r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/**
 * Giant Plan 8.9 (audit-consolidation stage 5): the ONE weekly-cluster
 * bootstrap, replacing five near-identical hand-rolled copies scattered
 * across nfl-replay.js (`uncertainty`), nfl-prop-clv.js, beat-the-close.js,
 * nfl-family-contribution.js and line-move-study.js.
 *
 * Resamples whole WEEKS with replacement rather than individual bets, since
 * bets placed in the same week share correlated inputs (market conditions,
 * model state that week) — the same reasoning as `pairedBootstrapDiff`'s
 * `groups` option in backtest-significance.js, applied to weeks instead of
 * games.
 *
 * `opts.weeks` (a declared week-key set/array, `${season}-${week}` or
 * whatever key `keyOf` below produces) is the actual fix this consolidation
 * exists for: every one of the five prior implementations built its
 * resampling universe purely from the weeks that happened to appear in
 * `rows` — a week where the policy correctly bet nothing was never a key at
 * all, so it could never be drawn and never contribute its real, honest
 * zero. That silently drops information (a policy that abstains sensibly in
 * bad weeks looks, to the bootstrap, exactly like a policy that was never
 * asked to consider those weeks) and inflates both the apparent edge and its
 * precision. Passing the run's full declared week set fixes this: a declared
 * week absent from `rows` still gets drawn like any other week, and
 * contributes one row of zero units and no graded result when it is.
 *
 * Without `opts.weeks` this behaves exactly like the five originals (the
 * resampling universe falls back to "weeks present in rows"), so migrating a
 * caller that has no independent notion of the declared schedule to this
 * shared function changes nothing about its numbers.
 *
 * @param {Array<{season?, week?, units, result}>} rows - individual bet rows.
 *   `result` is compared against the exact strings 'Won'/'Lost' for win-rate
 *   purposes, matching replaySeason()'s own vocabulary.
 * @param {object} [opts]
 * @param {Iterable<string>} [opts.weeks] - declared week keys forming the
 *   full resampling universe; falls back to the keys present in `rows`.
 * @param {(row) => string} [opts.keyOf] - week key for one row; defaults to
 *   `${row.season}-${row.week}`.
 * @param {number} [opts.iterations]
 * @param {number} [opts.seed]
 * @returns {{method,clusters,trials,win_rate_95,roi_95,probability_roi_above_zero,sample_warning}}
 */
export function weeklyClusterBootstrap(rows, { weeks: declaredWeeks, keyOf, iterations = 4000, seed = 20260804 } = {}) {
  const keyFor = keyOf ?? (r => `${r.season}-${r.week}`);
  const byWeek = new Map();
  for (const r of rows) {
    const key = keyFor(r);
    const group = byWeek.get(key) ?? [];
    group.push(r);
    byWeek.set(key, group);
  }
  const weekKeys = declaredWeeks ? [...new Set(declaredWeeks)] : [...byWeek.keys()];
  const settled = rows.filter(r => r.result === 'Won' || r.result === 'Lost');
  const draws = [];
  if (weekKeys.length) withRandomSeed(seed, () => {
    for (let trial = 0; trial < iterations; trial++) {
      const sample = [];
      for (let i = 0; i < weekKeys.length; i++) {
        const key = weekKeys[Math.floor(random() * weekKeys.length)];
        const weekRows = byWeek.get(key);
        // A declared week absent from `rows` is a real, observed zero — the
        // policy considered it and bet nothing — not a gap in the data, so it
        // contributes one zero-unit, ungraded row rather than nothing at all.
        if (weekRows && weekRows.length) sample.push(...weekRows);
        else sample.push({ units: 0, result: null });
      }
      const graded = sample.filter(b => b.result === 'Won' || b.result === 'Lost');
      const wins = graded.filter(b => b.result === 'Won').length;
      draws.push({ roi: sample.length ? mean(sample.map(b => b.units)) : 0, winRate: graded.length ? wins / graded.length : 0 });
    }
  });
  const rois = draws.map(x => x.roi), winRates = draws.map(x => x.winRate);
  return {
    method: 'deterministic weekly-cluster bootstrap',
    clusters: weekKeys.length,
    trials: draws.length,
    win_rate_95: draws.length ? [_r2(quantile(winRates, 0.025)), _r2(quantile(winRates, 0.975))] : [null, null],
    roi_95: draws.length ? [_r2(quantile(rois, 0.025)), _r2(quantile(rois, 0.975))] : [null, null],
    probability_roi_above_zero: draws.length ? _r2(rois.filter(x => x > 0).length / draws.length) : null,
    sample_warning: settled.length < 100
      ? 'Very small sample: results are dominated by variance.'
      : settled.length < 500 ? 'Moderate sample: treat profitability as provisional until the interval clears zero.' : null
  };
}

/** Box-Muller standard normal. */
export function randn() {
  let u = 0;
  while (u === 0) u = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** Marsaglia-Tsang gamma sampler; the workhorse behind both Gamma and NegBinomial. */
export function randGamma(shape, scale = 1) {
  if (shape <= 0) return 0;
  if (shape < 1) {
    // Boost a sub-1 shape into the valid range and correct for it.
    return randGamma(shape + 1, scale) * Math.pow(random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = randn(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

/** Knuth for small means, normal approximation above the point it stops being cheap. */
export function randPoisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * randn()));
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= random(); } while (p > L);
  return k - 1;
}

/**
 * Negative binomial as a gamma-Poisson mixture.
 *
 * The right shape for counts that are over-dispersed relative to Poisson — which
 * touches always are, because a player's role varies week to week on top of the
 * play-by-play randomness. `dispersion` > 0; smaller means more variable.
 */
export function randNegBinomial(mean_, dispersion) {
  if (mean_ <= 0) return 0;
  if (!dispersion || dispersion <= 0) return randPoisson(mean_);
  return randPoisson(randGamma(dispersion, mean_ / dispersion));
}

/**
 * Beta variate via two gammas. Used to give a player's availability a *distribution*
 * rather than a fixed rate: real seasons are bimodal — mostly healthy or mostly hurt —
 * and a plain binomial around a point estimate cannot express that.
 */
export function randBeta(a, b) {
  const x = randGamma(a, 1), y = randGamma(b, 1);
  return x + y > 0 ? x / (x + y) : 0.5;
}

export function randBinomial(n, p) {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  if (n > 30) return Math.max(0, Math.min(n, Math.round(n * p + Math.sqrt(n * p * (1 - p)) * randn())));
  let k = 0;
  for (let i = 0; i < n; i++) if (random() < p) k++;
  return k;
}

/* ------------------------------------------------- correlated normal draws */

/**
 * Cholesky decomposition, with a jitter retry.
 *
 * Correlation matrices estimated from ragged real data are often not quite positive
 * definite, which makes the plain factorisation fail on a negative square root. Nudging
 * the diagonal is the standard repair and leaves the correlations essentially unchanged.
 */
export function cholesky(matrix) {
  const n = matrix.length;
  for (let attempt = 0; attempt < 6; attempt++) {
    const jitter = attempt === 0 ? 0 : 10 ** (-8 + attempt);
    const L = Array.from({ length: n }, () => new Float64Array(n));
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = matrix[i][j] + (i === j ? jitter : 0);
        for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
        if (i === j) {
          if (sum <= 0) { ok = false; break; }
          L[i][i] = Math.sqrt(sum);
        } else L[i][j] = sum / L[j][j];
      }
    }
    if (ok) return L;
  }
  // Give up on correlation rather than on the simulation — but SAY so. This used to
  // return a bare identity, which silently turns every correlated simulation into an
  // independent one: lineup spreads and title odds narrow and change meaning, and
  // nothing throws or logs. The returned array is marked, so a caller can record
  // that its draws were uncorrelated, and the first occurrence is logged. Indexing
  // the result is unchanged, so no existing caller breaks.
  if (!choleskyFallbackWarned) {
    choleskyFallbackWarned = true;
    console.warn(`[stats-util] cholesky: ${n}x${n} matrix not positive definite after 6 jitter attempts; ` +
      'falling back to IDENTITY (draws will be uncorrelated). Further occurrences are flagged on the result, not logged.');
  }
  const identity = Array.from({ length: n }, (_, i) => {
    const r = new Float64Array(n); r[i] = 1; return r;
  });
  identity.fallbackIdentity = true;
  return identity;
}
let choleskyFallbackWarned = false;

/** One vector of correlated standard normals from a Cholesky factor. */
export function correlatedNormals(L) {
  const n = L.length;
  const z = Array.from({ length: n }, randn);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j <= i; j++) s += L[i][j] * z[j];
    out[i] = s;
  }
  return out;
}

/**
 * Inverse standard normal CDF (Acklam's algorithm) — turns a target marginal
 * probability into the latent-normal threshold a copula needs to hit that
 * probability. Shared by every copula user in this codebase (SGP pricing in
 * nfl-prop-correlation.js, the slate risk check in staking.js) so there is
 * exactly one implementation of it.
 */
export function probit(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Standard normal CDF — turns correlated normals into correlated uniforms for a copula. */
export function normalCdf(x) {
  // Abramowitz & Stegun 7.1.26 on the error function.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * Holm-Bonferroni step-down correction. Controls the family-wise error rate
 * across `pvals.length` simultaneous hypotheses without the full conservatism
 * of a flat Bonferroni cutoff. Returns adjusted p-values in the same order as
 * the input; compare each to your original alpha (e.g. 0.05).
 */
export function holm(pvals) {
  const order = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const m = pvals.length, adjusted = new Array(m).fill(1);
  let running = 0;
  order.forEach(([p, i], rank) => { running = Math.max(running, Math.min(1, (m - rank) * p)); adjusted[i] = running; });
  return adjusted;
}
