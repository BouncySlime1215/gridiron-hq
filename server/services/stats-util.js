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
  // Give up on correlation rather than on the simulation.
  return Array.from({ length: n }, (_, i) => {
    const r = new Float64Array(n); r[i] = 1; return r;
  });
}

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
