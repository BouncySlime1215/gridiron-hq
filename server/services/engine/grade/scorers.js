/**
 * The grader's proper scores (ENGINE-ARCHITECTURE.md §7.2). Pure functions: no database.
 *
 *   dist   quantileScore: the pinball loss summed over the quantile levels the row carries.
 *          `crps_approx` = 2 x its mean over the levels: an APPROXIMATION of CRPS from a
 *          handful of quantiles, named as such (ML M6), never reported as CRPS itself.
 *          pitFromQuantiles: the realised value's position in the forecast, linear between
 *          quantiles; below the lowest or above the highest level it is the middle of that
 *          tail bin (tail bins are explicit, not extrapolated).
 *   prob   logLoss (clipped at 1e-12 so a confident miss is large, never Infinity), brier,
 *          calibration slope/intercept (logistic regression of y on logit(p)).
 *   decisions  gradeDecisions from gates/baseline-gate.js, reused unchanged (DECISION_SCORER).
 *
 * clusterFloor: a promotion or fallback needs >= 4 distinct weeks and >= 20 distinct entities;
 * thirty player-weeks from one Sunday are one week cluster.
 */
import { gradeDecisions } from '../../gates/baseline-gate.js';

export const DECISION_SCORER = gradeDecisions;
export const scoreDecisions = (decisions, opts) => DECISION_SCORER(decisions, opts);

export const FLOOR = Object.freeze({ minWeeks: 4, minEntities: 20 });
const EPS = 1e-12;

function checkQuantiles(levels, values) {
  if (!Array.isArray(levels) || !Array.isArray(values) || levels.length !== values.length || !levels.length) {
    throw new Error('a quantile forecast needs equal-length, non-empty levels and values');
  }
  for (let i = 0; i < levels.length; i += 1) {
    if (!(levels[i] > 0 && levels[i] < 1)) throw new Error(`quantile level ${levels[i]} is not in (0, 1)`);
    if (!Number.isFinite(values[i])) throw new Error(`quantile value at level ${levels[i]} is not a number`);
    if (i && !(levels[i] > levels[i - 1] && values[i] >= values[i - 1])) throw new Error('quantiles must increase with their levels');
  }
}

/** rho_tau(y - q): (y - q) * (tau - 1{y < q}). */
export function pinball(tau, q, y) {
  return (y - q) * (tau - (y < q ? 1 : 0));
}

export function quantileScore(levels, values, y) {
  checkQuantiles(levels, values);
  if (!Number.isFinite(y)) throw new Error('the realised value is not a number');
  let score = 0;
  for (let i = 0; i < levels.length; i += 1) score += pinball(levels[i], values[i], y);
  return { score, crps_approx: (2 * score) / levels.length, levels: levels.length };
}

export function pitFromQuantiles(levels, values, y) {
  checkQuantiles(levels, values);
  const last = levels.length - 1;
  if (y < values[0]) return levels[0] / 2;
  if (y > values[last]) return (1 + levels[last]) / 2;
  for (let i = 0; i < last; i += 1) {
    if (y <= values[i + 1]) {
      const span = values[i + 1] - values[i];
      return span > 0 ? levels[i] + ((y - values[i]) / span) * (levels[i + 1] - levels[i]) : (levels[i] + levels[i + 1]) / 2;
    }
  }
  return levels[last];
}

/** Share of realised values inside [lo, hi] quantiles, when the row carries both levels. */
export function inInterval(levels, values, y, lo = 0.1, hi = 0.9) {
  const a = levels.findIndex(l => Math.abs(l - lo) < 1e-9);
  const b = levels.findIndex(l => Math.abs(l - hi) < 1e-9);
  if (a < 0 || b < 0) return null;
  return y >= values[a] && y <= values[b] ? 1 : 0;
}

const clip = p => Math.min(1 - EPS, Math.max(EPS, p));
export function logLoss(p, y) {
  if (!(p >= 0 && p <= 1)) throw new Error(`probability ${p} is not in [0, 1]`);
  return y ? -Math.log(clip(p)) : -Math.log(clip(1 - p));
}
export function brier(p, y) {
  if (!(p >= 0 && p <= 1)) throw new Error(`probability ${p} is not in [0, 1]`);
  return (p - (y ? 1 : 0)) ** 2;
}

/** Logistic regression of y on logit(p), Newton steps. Perfect calibration: slope 1, intercept 0. */
export function calibration(ps, ys, { iterations = 25 } = {}) {
  const n = ps.length;
  const ys1 = ys.map(y => (y ? 1 : 0));
  const pos = ys1.reduce((s, y) => s + y, 0);
  if (n < 2 || pos === 0 || pos === n) return { slope: null, intercept: null, n, reason: 'needs both outcomes' };
  const x = ps.map(p => Math.log(clip(p) / (1 - clip(p))));
  let a = 0; let b = 1;
  for (let it = 0; it < iterations; it += 1) {
    let g0 = 0; let g1 = 0; let h00 = 0; let h01 = 0; let h11 = 0;
    for (let i = 0; i < n; i += 1) {
      const m = 1 / (1 + Math.exp(-(a + b * x[i])));
      const w = m * (1 - m);
      g0 += ys1[i] - m; g1 += (ys1[i] - m) * x[i];
      h00 += w; h01 += w * x[i]; h11 += w * x[i] * x[i];
    }
    const det = h00 * h11 - h01 * h01;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-10) break;
  }
  return { slope: b, intercept: a, n };
}

/** One-sample Kolmogorov-Smirnov test against Uniform(0,1); asymptotic p with Stephens' correction. */
export function ksUniform(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return { d: null, p: null, n: 0 };
  let d = 0;
  for (let i = 0; i < n; i += 1) d = Math.max(d, (i + 1) / n - s[i], s[i] - i / n);
  const lambda = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * d;
  let p = 0;
  for (let k = 1; k <= 100; k += 1) {
    const term = 2 * (-1) ** (k - 1) * Math.exp(-2 * k * k * lambda * lambda);
    p += term;
    if (Math.abs(term) < 1e-12) break;
  }
  return { d, p: Math.min(1, Math.max(0, p)), n };
}

/** items: [{week, entity}]. Counts distinct week clusters and distinct entities. */
export function clusterFloor(items, { minWeeks = FLOOR.minWeeks, minEntities = FLOOR.minEntities } = {}) {
  const weeks = new Set(items.map(i => i.week)).size;
  const entities = new Set(items.map(i => i.entity)).size;
  return { weeks, entities, min_weeks: minWeeks, min_entities: minEntities, met: weeks >= minWeeks && entities >= minEntities };
}

export const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
