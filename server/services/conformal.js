/**
 * Split-conformal prediction intervals, Mondrian-binned.
 *
 * Why this exists (Giant Plan 7.3, fixes #15/#16/#18). Two different places in
 * this codebase were turning a point forecast into an uncertainty statement by
 * assuming a shape:
 *
 *   - nfl-market.js graded every game through `normalCdf(predMargin / marginStd)`
 *     with ONE pooled standard deviation, so a pick'em and a two-touchdown
 *     favourite were handed the same interval width and the same tail shape.
 *   - nfl-ensemble.js's `predictiveDistribution` pooled all-history residuals and
 *     then widened them by an ad hoc `1 + disagreement/30` multiplier — a number
 *     with no derivation and no coverage guarantee, which is exactly why that
 *     function self-labelled `production_eligible: false`.
 *
 * Split conformal replaces both assumptions with one empirical quantile. Given a
 * calibration set of residuals that the point forecast never saw, the interval
 *
 *     point ± Q_{ceil((n+1)·level)/n}( |residual| )
 *
 * covers a genuinely exchangeable future residual with probability at least
 * `level`, with no distributional assumption at all. The `(n+1)` in the rank is
 * the whole finite-sample guarantee: it is what keeps a small calibration set
 * honest instead of quietly under-covering.
 *
 * Mondrian binning is the conditional half. Marginal coverage — 80% of all games
 * — is easy and can hide a badly-behaved slice: an interval that over-covers
 * pick'ems and under-covers blowouts averages out to look perfect. Binning the
 * calibration set by a feature known before kickoff (here, the market's own
 * spread bucket) and taking the quantile WITHIN the bin gives per-bin coverage
 * instead, which is what a staking decision on a single game actually needs. The
 * guarantee survives binning because conformal prediction only needs
 * exchangeability within each bin, not across bins.
 *
 * Bins that are too thin to estimate a tail quantile fall back to the pooled
 * calibration set rather than reporting a confidently wrong narrow interval — an
 * under-covering narrow interval is strictly worse than an honest wide one.
 */

/** Index of the bin `value` falls in, given ascending interior edges. */
export function binIndex(edges, value) {
  if (value == null || !Number.isFinite(value)) return edges.length; // unknown -> top bin
  let i = 0;
  while (i < edges.length && value >= edges[i]) i++;
  return i;
}

/** Human label for a bin, for auditability of what a width came from. */
export function binLabel(edges, index) {
  const lo = index === 0 ? 0 : edges[index - 1];
  const hi = index === edges.length ? null : edges[index];
  return hi == null ? `${lo}+` : `${lo}-${hi}`;
}

/**
 * The conformal quantile of |residual| for a two-sided interval at `level`.
 *
 * Rank `ceil((n + 1) · level)`, 1-indexed, on the sorted absolute residuals. If
 * that rank exceeds n the calibration set cannot certify the level at all; the
 * honest answer is the largest observed miss (and `exhausted: true` so callers
 * can see the guarantee is capped rather than met).
 */
export function conformalQuantile(sortedAbs, level) {
  const n = sortedAbs.length;
  if (!n) return { halfWidth: null, exhausted: true, n: 0 };
  const rank = Math.ceil((n + 1) * level);
  if (rank > n) return { halfWidth: sortedAbs[n - 1], exhausted: true, n };
  return { halfWidth: sortedAbs[rank - 1], exhausted: false, n };
}

/**
 * Build a Mondrian split-conformal calibrator.
 *
 * @param samples  [{ key, residual }] — `key` is the binning feature's value
 *                 (e.g. |market spread|), `residual` is actual − predicted.
 *                 Every residual must come from a prediction that did not see
 *                 its own game; this module cannot check that for you.
 * @param edges    ascending interior bin edges on `key`
 * @param minBin   a bin below this many residuals borrows the pooled set
 */
export function buildConformal(samples, { edges = [], minBin = 150 } = {}) {
  const usable = samples.filter(s => Number.isFinite(s.residual));
  const pooledSigned = usable.map(s => s.residual).sort((a, b) => a - b);
  const pooledAbs = usable.map(s => Math.abs(s.residual)).sort((a, b) => a - b);

  const bins = [];
  for (let i = 0; i <= edges.length; i++) {
    const own = usable.filter(s => binIndex(edges, s.key) === i);
    const borrowed = own.length < minBin;
    bins.push({
      index: i,
      label: binLabel(edges, i),
      n: own.length,
      borrowed_pool: borrowed,
      signed: borrowed ? pooledSigned : own.map(s => s.residual).sort((a, b) => a - b),
      abs: borrowed ? pooledAbs : own.map(s => Math.abs(s.residual)).sort((a, b) => a - b)
    });
  }

  const binFor = key => bins[binIndex(edges, key)] ?? bins[bins.length - 1];

  return {
    method: 'mondrian_split_conformal',
    edges,
    calibration_n: usable.length,
    bins: bins.map(b => ({ label: b.label, n: b.n, borrowed_pool: b.borrowed_pool })),

    /** Half-width of the two-sided `level` interval for a game in `key`'s bin. */
    halfWidth(key, level) {
      return conformalQuantile(binFor(key).abs, level).halfWidth;
    },

    /** [lo, hi] conformal interval around `point`. */
    interval(point, key, level) {
      const h = conformalQuantile(binFor(key).abs, level).halfWidth;
      return h == null ? null : [point - h, point + h];
    },

    /** Diagnostics for one game's interval — which bin, how many residuals, capped? */
    describe(key, level) {
      const b = binFor(key);
      const q = conformalQuantile(b.abs, level);
      return { bin: b.label, calibration_n: q.n, borrowed_pool: b.borrowed_pool,
        half_width: q.halfWidth == null ? null : +q.halfWidth.toFixed(2), guarantee_exhausted: q.exhausted };
    },

    /**
     * P(point + residual > threshold) from the bin's own empirical residual
     * distribution — the same calibration set the interval comes from, so the
     * probability and the interval can never tell different stories. Clamped off
     * the 0/1 endpoints: a finite calibration set is not evidence of impossibility.
     */
    probabilityAbove(point, key, threshold) {
      const signed = binFor(key).signed;
      if (!signed.length) return null;
      let above = 0;
      for (const r of signed) if (point + r > threshold) above++;
      return Math.min(0.995, Math.max(0.005, above / signed.length));
    },

    /** The bin's own residual sample, for callers that need to resample it. */
    residualsFor(key) { return binFor(key).signed; }
  };
}

/**
 * Exponentially recency-weighted resampling weights.
 *
 * A residual from 1999 and one from 2024 are not equally informative about next
 * Sunday: rule changes, kicking accuracy and pace have all moved the scoring
 * distribution. `decay` is the model's own fitted season-carryover — the same
 * parameter that already says how much a team's rating survives an offseason —
 * so the amount of forgetting is estimated from this data rather than picked.
 *
 * Returns a cumulative-weight array for O(log n) inverse-CDF sampling, plus the
 * effective sample size (Kish) so a caller can see how much history the weights
 * actually left in play.
 */
export function recencyWeights(seasons, { decay = 1, referenceSeason = null, minEffectiveFraction = 0.4 } = {}) {
  if (!seasons.length) return { cumulative: [], total: 0, effectiveN: 0, decay, applied_decay: decay };
  const ref = referenceSeason ?? Math.max(...seasons);
  const kish = d => {
    const w = seasons.map(s => d ** Math.max(0, ref - s));
    const total = w.reduce((a, b) => a + b, 0);
    const sum2 = w.reduce((a, b) => a + b * b, 0);
    return { w, total, eff: sum2 > 0 ? total * total / sum2 : 0 };
  };

  // An effective-sample floor, and why it is here rather than left to the
  // fitted decay alone. The carryover was estimated for how fast a TEAM's
  // rating goes stale, not for how fast the league's residual DISTRIBUTION
  // does; borrowing it is a reasonable prior, not a measured one. At
  // carryover 0.5 across a 1999-2025 pool it would leave roughly two seasons
  // of residuals doing all the work — a variance increase big enough to matter
  // and one that the held-out evidence available here (a four-season window)
  // cannot detect either way. So the decay is relaxed, by bisection, until at
  // least this fraction of the pool survives in Kish effective-sample terms.
  // Recency weighting is meant to forget stale history, not to discard the
  // sample size that made the quantile estimable in the first place.
  let applied = decay;
  const floor = minEffectiveFraction * seasons.length;
  if (kish(decay).eff < floor) {
    let lo = decay, hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (kish(mid).eff < floor) lo = mid; else hi = mid;
    }
    applied = hi;
  }

  const { w, total, eff } = kish(applied);
  let running = 0;
  const cumulative = w.map(v => (running += v));
  return {
    cumulative, total,
    effectiveN: +eff.toFixed(1),
    decay, applied_decay: +applied.toFixed(4),
    floor_engaged: applied !== decay,
    min_effective_fraction: minEffectiveFraction,
    reference_season: ref
  };
}

/** Inverse-CDF draw from a cumulative-weight array; `u` is uniform in [0,1). */
export function weightedDraw(cumulative, total, u) {
  const target = u * total;
  let lo = 0, hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] <= target) lo = mid + 1; else hi = mid;
  }
  return lo;
}
