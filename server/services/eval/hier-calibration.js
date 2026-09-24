/**
 * Pooled hierarchical calibration: one population curve, partial pooling per
 * manager.
 *
 *   y_i ~ Bernoulli( sigmoid( a + u[m(i)] + b * logit(p_i) ) )
 *   u_m ~ Normal(0, tau^2)          per-manager offset, shrunk toward 0
 *   a ~ Normal(0, 2^2),  b ~ Normal(1, 2^2)   weak priors
 *
 * `b` is the population reliability slope (1 = probabilities mean what they
 * say, < 1 = over-confident). `a` is calibration-in-the-large. `u_m` says
 * whether the model runs hot or cold on ONE manager, and a manager with three
 * offers is pulled almost all the way back to the population: three offers
 * are not evidence that the model misreads him, and a per-manager fit with no
 * pooling would say they were.
 *
 * tau is chosen by empirical Bayes: the value on a fixed grid with the largest
 * Laplace-approximate marginal likelihood. Fit by Newton-Raphson on the MAP.
 * Pure, deterministic.
 *
 * `fixSlope: true` pins b = 1 (for a check whose predictions barely vary, where
 * a slope is not identified and only the offsets are asked about).
 */
import { logit } from './stats.js';

const TAU_GRID = [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5];
const PRIOR_A_SD = 2;
const PRIOR_B_MEAN = 1;
const PRIOR_B_SD = 2;

/** Solve H x = g in place (Gaussian elimination, partial pivoting); also log|det H|. */
function solve(H, g) {
  const n = g.length;
  const A = H.map((r, i) => [...r, g[i]]);
  let logDet = 0;
  for (let c = 0; c < n; c += 1) {
    let piv = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (!(Math.abs(A[piv][c]) > 1e-14)) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    logDet += Math.log(Math.abs(A[c][c]));
    for (let r = c + 1; r < n; r += 1) {
      const f = A[r][c] / A[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k += 1) A[r][k] -= f * A[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = A[r][n];
    for (let k = r + 1; k < n; k += 1) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return { x, logDet };
}

/** MAP fit at one tau. theta = [a, b, u_1..u_M] (b omitted when fixSlope). */
function fitAt(z, y, g, M, tau, fixSlope) {
  const off = fixSlope ? 1 : 2;
  const K = off + M;
  const th = new Array(K).fill(0);
  if (!fixSlope) th[1] = 1;
  let H = null;
  for (let it = 0; it < 100; it += 1) {
    const grad = new Array(K).fill(0);
    H = Array.from({ length: K }, () => new Array(K).fill(0));
    let ll = 0;
    for (let i = 0; i < z.length; i += 1) {
      const b = fixSlope ? 1 : th[1];
      const eta = th[0] + b * z[i] + th[off + g[i]];
      const q = 1 / (1 + Math.exp(-eta));
      ll += y[i] ? Math.log(Math.max(q, 1e-300)) : Math.log(Math.max(1 - q, 1e-300));
      const r = y[i] - q;
      const w = q * (1 - q);
      const idx = fixSlope ? [0, off + g[i]] : [0, 1, off + g[i]];
      const dx = fixSlope ? [1, 1] : [1, z[i], 1];
      for (let s = 0; s < idx.length; s += 1) {
        grad[idx[s]] += r * dx[s];
        for (let t = 0; t < idx.length; t += 1) H[idx[s]][idx[t]] += w * dx[s] * dx[t];
      }
    }
    // Priors (negative log-prior Hessian is diagonal).
    grad[0] -= th[0] / PRIOR_A_SD ** 2; H[0][0] += 1 / PRIOR_A_SD ** 2;
    if (!fixSlope) { grad[1] -= (th[1] - PRIOR_B_MEAN) / PRIOR_B_SD ** 2; H[1][1] += 1 / PRIOR_B_SD ** 2; }
    for (let m = 0; m < M; m += 1) { grad[off + m] -= th[off + m] / tau ** 2; H[off + m][off + m] += 1 / tau ** 2; }
    const step = solve(H, grad);
    if (!step) return null;
    let maxStep = 0;
    for (let k = 0; k < K; k += 1) { th[k] += step.x[k]; maxStep = Math.max(maxStep, Math.abs(step.x[k])); }
    if (!th.every(Number.isFinite)) return null;
    if (maxStep < 1e-8) {
      let lp = ll - th[0] ** 2 / (2 * PRIOR_A_SD ** 2);
      if (!fixSlope) lp -= (th[1] - PRIOR_B_MEAN) ** 2 / (2 * PRIOR_B_SD ** 2);
      for (let m = 0; m < M; m += 1) lp -= th[off + m] ** 2 / (2 * tau ** 2) + Math.log(tau);
      const e1 = new Array(K).fill(0); e1[fixSlope ? 0 : 1] = 1;
      const inv = solve(H, e1);
      if (!inv) return null;
      return { th, logMarginal: lp - 0.5 * inv.logDet, varSlope: fixSlope ? null : inv.x[1], varA: fixSlope ? inv.x[0] : null };
    }
  }
  return null;
}

/**
 * Fit the hierarchy. `groups` is one manager key per row. Returns null when
 * the outcomes are all one class (nothing to calibrate against) or no tau on
 * the grid converges — an unfitted curve is reported as absent, never as b = 1.
 */
export function hierCalibration(p, y, groups, { fixSlope = false } = {}) {
  const n = p.length;
  if (n < 2) return null;
  const yy = y.map(v => (v ? 1 : 0));
  const pos = yy.reduce((a, b) => a + b, 0);
  if (pos === 0 || pos === n) return null;
  const keys = [...new Set(groups.map(String))];
  const gi = new Map(keys.map((k, i) => [k, i]));
  const g = groups.map(k => gi.get(String(k)));
  const z = p.map(logit);
  let best = null;
  for (const tau of TAU_GRID) {
    const f = fitAt(z, yy, g, keys.length, tau, fixSlope);
    if (f && (!best || f.logMarginal > best.logMarginal)) best = { ...f, tau };
  }
  if (!best) return null;
  const off = fixSlope ? 1 : 2;
  const managers = keys.map((key, m) => {
    const idx = g.map((v, i) => (v === m ? i : -1)).filter(i => i >= 0);
    return {
      key, n: idx.length,
      offset: best.th[off + m],
      observed: idx.reduce((a, i) => a + yy[i], 0) / idx.length,
      predicted: idx.reduce((a, i) => a + p[i], 0) / idx.length,
    };
  }).sort((u, v) => Math.abs(v.offset) - Math.abs(u.offset));
  return {
    intercept: best.th[0],
    slope: fixSlope ? 1 : best.th[1],
    slope_se: fixSlope ? null : Math.sqrt(Math.max(best.varSlope, 0)),
    intercept_se: fixSlope ? Math.sqrt(Math.max(best.varA, 0)) : null,
    tau: best.tau,
    managers,
  };
}
