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
  const weights = weightSet[context.position];
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
  if (!weightSet?.[context.position]) return 'structural_fallback_no_weights_for_position';
  const substituted = WEEKLY_ENSEMBLE_HEADS.some(head => !Number.isFinite(Number(context[head])));
  return substituted ? 'position_ensemble_heads_substituted' : 'position_ensemble';
}

export function weeklyEnsembleContext({ structural, priorWeeks, position }) {
  if (!priorWeeks?.length) return null;
  const ordered = [...priorWeeks].sort((a, b) => a - b);
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
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
}
