/**
 * Weekly ensemble: five heads, one convex blend.
 *
 * WHERE THE LIVE WEIGHTS ARE. Not in this file. Production reads promoted fits from
 * `weekly_ensemble_fits` through weekly-weight-store.js#activeWeeklyWeightSet, and
 * since fit-1 was promoted (scripts/promote-weekly-ensemble.mjs) every 2026
 * prediction uses ONE global vector, [0.20 structural, 0.40 season_to_date, 0.15
 * last3, 0.05 last1, 0.20 median], fit on pooled 2023-2025. The per-position
 * WEEKLY_ENSEMBLE_WEIGHTS below are the FROZEN COLD-START FALLBACK, reached only
 * when no promoted fit predates the week being predicted. Their provenance: fit on
 * 2023 only, architecture selected on 2024, evaluated once on 2025 (MAE 4.425).
 * This block used to describe those constants as if they were what production runs.
 *
 * EXCEPT WEEKS 2-4 (fit-2, promoted 2026-09-18 by scripts/promote-early-week-weights.mjs).
 * fit-2 carries fit-1's vector unchanged plus an `early` block: a player with 1-3
 * prior in-season games gets the structural head alone in weeks 2-4. fit-1's vector
 * had only ever been fit and graded on weeks 5-18; at week 2 it put 80% of the
 * projection on the week-1 score. Walk-forward, weeks 2-4, played player-weeks:
 *
 *              live fit-1   structural-only   diff (player-clustered 90% CI)
 *     2024       4.7233         4.4867        -0.2313 [-0.3575, -0.1053]   n=929
 *     2025       4.7099         4.3175        -0.3965 [-0.5222, -0.2725]   n=969
 *
 * start/sit pair accuracy 0.605 -> 0.626 (2024) and 0.621 -> 0.647 (2025); 2025 80%
 * coverage 0.756 -> 0.811. The gain is in 1-2 prior games; with 3 (mostly week 4)
 * structural-only and fit-1 are a wash (2023-2025 CIs straddle 0). Fitted per-bucket
 * weights and a k/(n+k) shrinkage also beat live but lost to structural-only on
 * 2025, so the pre-registered gate chose structural-only. Weeks 1 and 5-18 are
 * byte-identical to fit-1 (0 of 15,175 week 5-18 predictions moved in 2024-2025).
 *
 * WHAT THE FIVE HEADS ARE. Two signals, not five. Four heads — season_to_date,
 * last3, last1, median — re-weight one series, the player's own prior fantasy
 * points. Pooled 2023-2025 (n=13,340): PC1 of the head correlation matrix explains
 * 86.2% of the variance (eigenvalues 4.31, 0.37, 0.19, 0.10, 0.03), effective rank
 * exp(spectral entropy) = 1.74, season_to_date/median r = 0.964. Refit on subsets:
 * structural alone 4.788, season_to_date alone 4.396, the two together 4.370, all
 * five 4.346 — the three extra heads buy 0.024 MAE. They are kept for a small,
 * real robustness gain, not because they carry independent information, and a
 * sixth head built from the same series will stall the same way. A genuine second
 * axis has to be week-level.
 *
 * WHY CONVEX. The original rationale was aesthetic — no head leveraged into an
 * unstable extrapolation, every prediction interpretable — and it was never
 * priced. It has now been measured, and the honest statement is a tradeoff, not a
 * free lunch: leave-one-season-out over 2021-2025, an unconstrained least-absolute-
 * deviation fit with an intercept beats the convex grid in 5 of 5 folds by 0.078
 * MAE (4.344 vs 4.422 mean held-out; more than the ensemble's whole 0.048 edge
 * over season_to_date), but it does so with a level shift (intercept -0.83 to
 * -0.97, coefficients summing to ~1.0) that biases predictions by -1.02 to -1.56
 * pts/player-week against -0.16 to -0.62 for convex. Convexity is what keeps the
 * level near-unbiased, and the level is what the summing consumers (lineup totals,
 * playoff points, trade deltas) need. Keeping it is defensible; calling it free is
 * not. See also the level bias note on weeklyEnsemblePrediction.
 */
export const WEEKLY_ROLE_RECENCY = Object.freeze({ seasonDecay: 0.05, weekHalfLife: 5 });
export const WEEKLY_ENSEMBLE_HEADS = Object.freeze([
  'structural', 'season_to_date', 'last3', 'last1', 'median'
]);
export const WEEKLY_ENSEMBLE_WEIGHTS = Object.freeze({
  QB: Object.freeze([0.40, 0.45, 0.00, 0.10, 0.05]),
  RB: Object.freeze([0.50, 0.20, 0.10, 0.15, 0.05]),
  WR: Object.freeze([0.60, 0.00, 0.00, 0.10, 0.30]),
  TE: Object.freeze([0.80, 0.20, 0.00, 0.00, 0.00])
});

/**
 * The blended weekly point estimate.
 *
 * LEVEL: this is a conditional MEDIAN, not a mean. The weights are chosen by
 * minimising MAE, and weekly fantasy scores are right-skewed, so the blend sits
 * below the conditional mean: mean signed error of the promoted weights is
 * -0.26 / -0.17 / -0.31 / -0.58 / -0.32 pts per player-week for 2021-2025,
 * negative in every season. Rankings are unaffected (a near-uniform shift does not
 * reorder), so start/sit is fine. Anything that SUMS these — a nine-starter lineup
 * total, playoff points, a trade delta — inherits -1.5 to -5 points of level. Not
 * corrected here, because correcting it changes live numbers and has to be graded.
 *
 * Two silent degradations live in this function and are reported, not hidden, by
 * weeklyEnsembleMode() below: an unknown position returns the bare structural head,
 * and a non-finite head is replaced by structural, which quietly hands that head's
 * weight to structural. Neither throws.
 */
export function weeklyEnsemblePrediction(context, weightSet = WEEKLY_ENSEMBLE_WEIGHTS) {
  const weights = weeklyEnsembleWeightsFor(context, weightSet);
  if (!weights) return context.structural;
  return WEEKLY_ENSEMBLE_HEADS.reduce((sum, head, index) => {
    const value = Number(context[head]);
    return sum + weights[index] * (Number.isFinite(value) ? value : context.structural);
  }, 0);
}

/**
 * What weeklyEnsemblePrediction() ACTUALLY did for this context, so an audit record
 * can say so instead of inferring "ensemble ran" from `context != null`. That
 * inference was wrong in two cases: a position with no weight vector (K, DST, FB, a
 * lowercase or null position from an import) silently fell to the structural head —
 * 4.749 MAE instead of 4.330 — while the record still said 'position_ensemble'; and a
 * non-finite head silently reassigned its weight to structural.
 */
export function weeklyEnsembleMode(context, weightSet = WEEKLY_ENSEMBLE_WEIGHTS) {
  if (!context) return 'structural_only_no_current_season_history';
  const weights = weightSet ? weeklyEnsembleWeightsFor(context, weightSet) : null;
  if (!weights) return 'structural_fallback_no_weights_for_position';
  const substituted = WEEKLY_ENSEMBLE_HEADS.some(head => !Number.isFinite(Number(context[head])));
  const bucket = weeklyEarlyBucket(context, weightSet);
  const base = bucket != null ? `early_week_bucket_${bucket}` : 'position_ensemble';
  return substituted ? `${base}_heads_substituted` : base;
}

/**
 * EARLY-WEEK BUCKETS (weeks 2-4). The promoted 5-vector was fit and graded on weeks
 * 5-18 only, but production applied it from week 2, where season_to_date, last3,
 * last1 and median are all the player's single week-1 score — so 80% of a week-2
 * projection was one game. A fit may now carry, beside the per-position 5-vectors,
 *
 *   weightSet.early = { weeks: [2, 4], buckets: { 1: {QB,RB,WR,TE}, 2: {...}, 3: {...} } }
 *
 * keyed by how many in-season games the player has before the predicted week
 * (`context.prior_weeks`). It is read only when prior_weeks is 1-3 AND the week is
 * inside `early.weeks`; everything else — 4+ prior games, weeks 5-18, the week-1
 * cold start — runs the per-position vector exactly as before. The per-position
 * contract is unchanged: `weightSet[position]` is still the 5-array a bare array
 * would silently lose. Promotion, gate and numbers: scripts/promote-early-week-weights.mjs.
 *
 * WHERE THE WINDOW IS ENFORCED. Two places that read the same stored window:
 *   - weekly-weight-store.js#activeWeeklyWeightSet({season, week}) drops `early`
 *     outside the window, which is what production relies on (the production context
 *     from weeklyEnsembleContext carries no week);
 *   - here, when the context DOES carry a week (weekly-backtest.js contexts do), so a
 *     replay of weeks 5-18 with a week-3 weight set still gets the live vector.
 */
export const EARLY_WEEK_MAX_PRIOR_WEEKS = 3;

function earlyWindowHas(early, week) {
  const [lo, hi] = Array.isArray(early?.weeks) ? early.weeks : [];
  return Number.isInteger(week) && week >= lo && week <= hi;
}

/** The early bucket (1-3 prior games) that applies to this context, or null. */
export function weeklyEarlyBucket(context, weightSet) {
  const early = weightSet?.early;
  if (!early || !context) return null;
  const n = context.prior_weeks;
  if (!Number.isInteger(n) || n < 1 || n > EARLY_WEEK_MAX_PRIOR_WEEKS) return null;
  if (context.week != null && !earlyWindowHas(early, context.week)) return null;
  // A bucket that lacks this position falls back to the position's live vector
  // (never to structural); saveWeeklyFit refuses to store such a bucket anyway.
  return Array.isArray(early.buckets?.[n]?.[context.position]) ? n : null;
}

/**
 * The 5-vector weeklyEnsemblePrediction() actually applies to this context, or null
 * when it falls back to the structural head. Use this — not `weightSet[position]` —
 * wherever an audit record reports "the weights".
 */
export function weeklyEnsembleWeightsFor(context, weightSet = WEEKLY_ENSEMBLE_WEIGHTS) {
  if (!context) return null;
  const bucket = weeklyEarlyBucket(context, weightSet);
  if (bucket != null) return weightSet.early.buckets[bucket][context.position];
  return weightSet[context.position] ?? null;
}

/** The weight set as it may be used for `week`: `early` is dropped outside its window. */
export function weeklyWeightSetForWeek(weights, week) {
  if (!weights?.early || earlyWindowHas(weights.early, week)) return weights;
  const { early: _outsideWindow, ...positionVectors } = weights;
  return positionVectors;
}

export function weeklyEnsembleContext({ structural, priorWeeks, position }) {
  if (!priorWeeks?.length) return null;
  const ordered = [...priorWeeks].sort((a, b) => a - b);
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const context = {
    structural,
    season_to_date: mean(priorWeeks),
    last3: mean(priorWeeks.slice(-3)),
    last1: priorWeeks.at(-1),
    // On an even-length history this is the UPPER of the two central values, not
    // their midpoint ([2, 20] -> 20, not 11), so the head called `median` runs high
    // on even histories. weekly-backtest.js computes it identically, so there is no
    // train/serve skew and the fitted weights are consistent with this definition.
    // Do not "fix" it without refitting the weights, which were fit against it.
    median: ordered[Math.floor(ordered.length / 2)],
    position
  };
  // How many in-season games feed the four history heads, for the early-week buckets.
  // Set only when those buckets can apply (1-3 games), so a 4+ history — every
  // player the promoted weeks 5-18 path grades — keeps exactly its old shape. The
  // week-1 cold start in player-week-engine.js passes ONE prior-season average as
  // priorWeeks and so also gets prior_weeks = 1; activeWeeklyWeightSet() keeps
  // `early` out of week 1, which is what stops the bucket-1 weights reaching it.
  if (priorWeeks.length <= EARLY_WEEK_MAX_PRIOR_WEEKS) context.prior_weeks = priorWeeks.length;
  return context;
}
