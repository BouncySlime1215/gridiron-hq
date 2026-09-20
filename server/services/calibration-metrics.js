/**
 * The two numbers a probability is judged by, in one place so every calibration in
 * this repository reports the same thing by the same rule.
 *
 * Extracted from `scripts/calibrate-playoff-odds.mjs` rather than left inline,
 * because a report that concludes "the week-2 odds are worse than the base rate"
 * rests entirely on these, and a function that only ever runs against 184,959 real
 * rows is one nobody can show failing. `test/calibration-metrics.test.js` exercises
 * them on sets whose answers are known by hand.
 */

/**
 * Mean squared error of a probability against a 0/1 outcome. `pick` grades an
 * alternative predictor on the same rows -- the base rate, a fitted model -- so the
 * comparison never re-derives the outcome column.
 *
 * Null for an empty set. The mean of nothing is not zero, and a zero here would
 * read as a perfect score.
 */
export function brierScore(rows, pick = r => r.p) {
  if (!rows?.length) return null;
  return rows.reduce((sum, r) => sum + (pick(r) - r.y) ** 2, 0) / rows.length;
}

/**
 * Reliability bins: what was predicted against what happened, in `bins` groups of
 * EQUAL COUNT.
 *
 * Equal count rather than equal width, because a simulator's probabilities are not
 * spread evenly -- most of them pile up near 0 and 1 -- and equal-width bins would
 * put nearly every row in the two end bins, where a large disagreement averages
 * away against the many rows around it. Equal counts give every bin the same weight
 * in the worst-gap figure, which is the number the conclusion is drawn from.
 *
 * The last bin takes the remainder, so no row is dropped: 10 rows in 3 bins is
 * 3/3/4, never 3/3/3 with one row quietly discarded.
 */
export function reliabilityBins(rows, bins = 10) {
  if (!rows?.length) return [];
  const sorted = [...rows].sort((a, b) => a.p - b.p);
  const per = Math.max(1, Math.floor(sorted.length / bins));
  const out = [];
  for (let b = 0; b < bins; b++) {
    const lo = b * per;
    if (lo >= sorted.length) break;
    const hi = b === bins - 1 ? sorted.length : Math.min(sorted.length, (b + 1) * per);
    const slice = sorted.slice(lo, hi);
    if (!slice.length) continue;
    out.push({
      n: slice.length,
      predicted: +(slice.reduce((s, r) => s + r.p, 0) / slice.length).toFixed(4),
      observed: slice.reduce((s, r) => s + r.y, 0) / slice.length
    });
  }
  return out;
}
