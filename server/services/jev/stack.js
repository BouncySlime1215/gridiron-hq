/**
 * The blend of a calibrated Jev claim with the incumbent, and how it is scored.
 *
 * One weight per question, on the logit scale:
 *   logit(p) = logit(incumbent) + w * (logit(calibrated jev) - logit(incumbent)),  w in [0, 1]
 * so w = 0 is the incumbent and w = 1 is Jev. Log loss is convex in w (the
 * logit is linear in it), so a ternary search finds the minimum.
 */
import { clampP, logit, sigmoid } from './calibrate.js';

export function blend(inc, jev, w) {
  if (w === 0) return inc; // exactly the incumbent, not a round trip through the logit
  return clampP(sigmoid(logit(inc) + w * (logit(jev) - logit(inc))));
}

const pointLoss = (p, y) => { const q = clampP(p); return -(y ? Math.log(q) : Math.log(1 - q)); };

/** Mean log loss of [{ p, y }]. */
export function logLoss(points) {
  return points.reduce((s, { p, y }) => s + pointLoss(p, y), 0) / points.length;
}

export function brier(points) {
  return points.reduce((s, { p, y }) => s + (p - y) ** 2, 0) / points.length;
}

/** units: [{ inc, jev, y }] -> the weight in [0, 1] with the lowest log loss. */
export function fitWeight(units) {
  const loss = w => units.reduce((s, u) => s + pointLoss(blend(u.inc, u.jev, w), u.y), 0);
  let lo = 0, hi = 1;
  for (let i = 0; i < 100; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (loss(m1) <= loss(m2)) hi = m2; else lo = m1;
  }
  const w = (lo + hi) / 2;
  // The search never lands on an end exactly; an end that is at least as good is the answer.
  if (loss(0) <= loss(w)) return 0;
  if (loss(1) <= loss(w)) return 1;
  return w;
}

/**
 * 90% interval of the mean per-unit loss difference, resampling whole clusters
 * (managers), because one chatty manager's units are not independent.
 * diffs: [{ cluster, d }]. Deterministic: a fixed-seed generator.
 */
export function clusterBootstrapCI(diffs, { resamples = 500, seed = 20260924 } = {}) {
  const byCluster = new Map();
  for (const { cluster, d } of diffs) (byCluster.get(cluster) ?? byCluster.set(cluster, []).get(cluster)).push(d);
  const clusters = [...byCluster.values()];
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const means = [];
  for (let b = 0; b < resamples; b++) {
    let sum = 0, n = 0;
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[Math.floor(rand() * clusters.length)];
      for (const d of c) { sum += d; n++; }
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.05 * (resamples - 1))], means[Math.ceil(0.95 * (resamples - 1))]];
}
