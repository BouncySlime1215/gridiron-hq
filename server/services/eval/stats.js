/**
 * EVAL-01 shared statistics. Pure functions, no database, no clock.
 *
 * Every confidence interval here is a seeded percentile bootstrap, so the same
 * rows always give the same report (a report card that moves on a re-run with
 * no new data would be grading its own dice). Resampling is by CLUSTER when a
 * key is given (league, team-season, week): rows that share a league or a week
 * share its noise, and a row-level bootstrap would call them independent and
 * print an interval that is too narrow.
 */

export const EPS = 1e-4;
const clip = p => Math.min(1 - EPS, Math.max(EPS, p));
export const logit = p => Math.log(clip(p) / (1 - clip(p)));
export const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Deterministic PRNG (mulberry32). */
export function rng(seed = 303) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mean log loss of predictions p against 0/1 outcomes y. */
export function logLoss(p, y) {
  let s = 0;
  for (let i = 0; i < p.length; i += 1) s -= y[i] ? Math.log(clip(p[i])) : Math.log(1 - clip(p[i]));
  return s / p.length;
}

/** Mean Brier score. */
export function brier(p, y) {
  let s = 0;
  for (let i = 0; i < p.length; i += 1) s += (p[i] - y[i]) ** 2;
  return s / p.length;
}

/**
 * Logistic recalibration slope: fit y ~ a + b * logit(p) by Newton-Raphson and
 * return b. 1 = the probabilities mean what they say; < 1 = over-confident.
 * Null when the outcomes carry no information (all one class) or the fit does
 * not converge — a slope that could not be fitted is not a slope of 1.
 */
export function calibrationSlope(p, y) {
  const n = p.length;
  if (n < 3) return null;
  const pos = y.reduce((a, b) => a + (b ? 1 : 0), 0);
  if (pos === 0 || pos === n) return null;
  const x = p.map(logit);
  let a = 0;
  let b = 1;
  for (let it = 0; it < 50; it += 1) {
    let g0 = 0; let g1 = 0; let h00 = 0; let h01 = 0; let h11 = 0;
    for (let i = 0; i < n; i += 1) {
      const q = 1 / (1 + Math.exp(-(a + b * x[i])));
      const r = (y[i] ? 1 : 0) - q;
      const w = q * (1 - q);
      g0 += r; g1 += r * x[i];
      h00 += w; h01 += w * x[i]; h11 += w * x[i] * x[i];
    }
    const det = h00 * h11 - h01 * h01;
    if (!(Math.abs(det) > 1e-12)) return null;
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    a += da; b += db;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (Math.abs(da) < 1e-9 && Math.abs(db) < 1e-9) return b;
  }
  return Number.isFinite(b) ? b : null;
}

/** Reliability table: fixed-width buckets of predicted probability. */
export function reliabilityBuckets(p, y, edges = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0000001]) {
  const out = [];
  for (let k = 0; k < edges.length - 1; k += 1) {
    const idx = [];
    for (let i = 0; i < p.length; i += 1) if (p[i] >= edges[k] && p[i] < edges[k + 1]) idx.push(i);
    if (!idx.length) continue;
    out.push({
      lo: edges[k], hi: Math.min(1, edges[k + 1]), n: idx.length,
      predicted: round(mean(idx.map(i => p[i])), 4),
      observed: round(mean(idx.map(i => (y[i] ? 1 : 0))), 4),
    });
  }
  return out;
}

/**
 * Percentile bootstrap of `stat(indices)` over rows, resampling whole clusters
 * when `clusters` (one key per row) is given. Returns [lo, hi] or null when
 * fewer than half the replicates produced a finite value.
 */
export function bootstrapCI(n, stat, { clusters = null, reps = 1000, seed = 303, alpha = 0.05 } = {}) {
  if (n < 2) return null;
  const rand = rng(seed);
  let groups;
  if (clusters) {
    const m = new Map();
    for (let i = 0; i < n; i += 1) {
      const k = String(clusters[i]);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(i);
    }
    groups = [...m.values()];
  } else {
    groups = Array.from({ length: n }, (_, i) => [i]);
  }
  if (groups.length < 2) return null;
  const vals = [];
  for (let r = 0; r < reps; r += 1) {
    const idx = [];
    for (let g = 0; g < groups.length; g += 1) idx.push(...groups[Math.floor(rand() * groups.length)]);
    const v = stat(idx);
    if (v != null && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < reps / 2) return null;
  vals.sort((a, b) => a - b);
  const q = f => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(f * (vals.length - 1))))];
  return [q(alpha / 2), q(1 - alpha / 2)];
}

export const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

/**
 * How many MORE units until an interval of width `ciWidth` measured on `n`
 * units narrows to `targetWidth`, assuming width ~ 1/sqrt(n). Always >= 1: a
 * check that is not yet conclusive needs at least one more unit.
 */
export function moreNeeded(n, ciWidth, targetWidth) {
  if (!(n > 0) || !(ciWidth > 0) || !(targetWidth > 0)) return 1;
  const total = Math.ceil(n * (ciWidth / targetWidth) ** 2);
  return Math.max(1, total - n);
}
