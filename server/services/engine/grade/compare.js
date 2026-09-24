/**
 * Shadow vs active, paired (ENGINE-ARCHITECTURE.md §6.3 (1), §6.7, §7.2 `vs_incumbent`).
 * Pure functions: no database.
 *
 * pairedVsIncumbent(shadowItems, activeItems): pairs the two versions' graded items on the
 * same outcome entity, takes the difference of their primary scores (shadow minus active;
 * every primary score here is lower-is-better, so NEGATIVE favours the shadow), averages it
 * per week (the cluster: thirty player-weeks from one Sunday are one observation), and puts
 * a confidence sequence around the mean of the weekly means.
 *
 * confidenceSequence: the two-sided normal-mixture boundary (Robbins; Howard, Ramdas,
 * McAuliffe & Sekhon 2021): |S_t - t mu| <= sqrt((t s^2 + rho) ln((t s^2 + rho) / (rho alpha^2))),
 * with rho = s^2 x 4 (tuned for the 4-week cluster floor). s is the PLUG-IN standard deviation
 * of the weekly means, so the sequence is anytime-valid only as far as that estimate holds.
 * The monitor's mixture-martingale e-process (§7.4, ENGINE-SPECS EA-05) is the spec's object for
 * this; until it lands, this is the interval check-promotion reads, labelled with its method.
 */
import { mean } from './scorers.js';

export const CS_METHOD = 'normal-mixture confidence sequence over week-cluster means (plug-in sd, rho = 4 s^2)';
const RHO_WEEKS = 4;

/** Two-sided (1 - alpha) confidence sequence for the mean of xs. Null with a reason below 2 points. */
export function confidenceSequence(xs, { alpha = 0.05 } = {}) {
  const t = xs.length;
  if (t < 2) return { lo: null, hi: null, alpha, method: CS_METHOD, reason: 'fewer than 2 clusters' };
  const m = mean(xs);
  const s2 = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (t - 1);
  if (s2 === 0) return { lo: m, hi: m, alpha, method: CS_METHOD, reason: 'zero spread across clusters' };
  const rho = s2 * RHO_WEEKS;
  const v = t * s2 + rho;
  const radius = Math.sqrt(v * Math.log(v / (rho * alpha * alpha))) / t;
  return { lo: m - radius, hi: m + radius, alpha, method: CS_METHOD };
}

/**
 * shadowItems / activeItems: graded items {entity_id, week, primary}. Returns null when no
 * pair exists (nothing to compare), else {n_pairs, weeks, delta_mean, interval, sign}.
 */
export function pairedVsIncumbent(shadowItems, activeItems, { alpha = 0.05 } = {}) {
  const theirs = new Map(activeItems.map(i => [i.entity_id, i]));
  const byWeek = new Map();
  let n = 0;
  for (const i of shadowItems) {
    const other = theirs.get(i.entity_id);
    if (!other || other.outcome_event_id !== i.outcome_event_id) continue;
    n += 1;
    if (!byWeek.has(i.week)) byWeek.set(i.week, []);
    byWeek.get(i.week).push(i.primary - other.primary);
  }
  if (!n) return null;
  const weekly = [...byWeek.keys()].sort().map(w => mean(byWeek.get(w)));
  return { n_pairs: n, weeks: weekly.length, delta_mean: mean(weekly), interval: confidenceSequence(weekly, { alpha }),
    sign: 'shadow minus active, primary score (lower is better): negative favours the shadow' };
}
