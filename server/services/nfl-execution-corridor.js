/**
 * Rule 1 of the two stress-test rules the architecture assessment asks Package
 * H to encode: the MARKET LINE CORRIDOR.
 *
 * The idea, from the master plan's own Package H brief, is a principle rather
 * than a wired check: "Stored extreme prices should be challenged first,
 * because they often represent bad joins or stale feeds." The assessment
 * (docs/MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08.md, Part 1.3) asks for it
 * literally: a model output whose gap from the market's own line exceeds a
 * threshold is logged `needs_review` before it may enter the paper ledger.
 *
 * THE THRESHOLD IS NOT THE PROPOSAL'S 4.5 POINTS, AND THAT MATTERS.
 *
 * The proposal's 4.5 was chosen for a generic NFL model with no knowledge of
 * this project's residual distributions. Measured against them (see
 * CORRIDOR_DERIVATION below, and test/nfl-execution-corridor.test.js), 4.5
 * would flag 6.3-7.2% of every model output this project produces — one in
 * fifteen, a review queue nobody can work, and a rule that would be switched
 * off within a week. The reason is that "a large divergence" has no fixed
 * meaning here: across the fifteen models in the last completed blind audit,
 * the MEDIAN absolute divergence from the market ranges from 0.076 points
 * (specialist_team) to 4.0 points (player_builder), a 52x spread. For
 * player_builder, 4.5 points is its ordinary Tuesday; for line_movement, whose
 * largest divergence in 831 games was 2.15 points, 4.5 is unreachable.
 *
 * The threshold used here — 11.5 points — is the 99.5th percentile of this
 * project's own pooled residual distribution, fit on training folds only and
 * validated out of fold. `deriveCorridorThreshold()` is the function that
 * produced it and is exported so a future reader can re-derive it from a fresh
 * sample rather than trusting a constant.
 *
 * WHAT THE OUT-OF-FOLD EVIDENCE SAYS. The corridor's premise — that an extreme
 * divergence is more likely a bug than found alpha — is falsifiable, and was
 * tested rather than assumed. On held-out seasons, flagged model outputs are
 * 2.65x worse than simply believing the market (squared-error ratio), against
 * 1.04x for outputs inside the corridor; the week-clustered 95% interval on
 * that difference is [0.93, 2.45], entirely above zero. Flagged outputs were
 * also directionally correct only 45.7% of the time. The premise holds on this
 * project's own data: past the corridor, divergence is error, not edge.
 *
 * SCOPE. This is evaluation infrastructure. The check returns a verdict and a
 * reason; it never prices, stakes or places anything. The only thing wired to
 * it is `nfl-execution-decision.js#attemptAcceptance`, which refuses to record
 * an acceptance outside the corridor unless a human explicitly acknowledges it
 * — the same shape as the existing suspect-price gate.
 */

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/** Linear-interpolated quantile of an already-ascending array. */
function quantile(ascending, p) {
  if (!ascending.length) return null;
  const i = (ascending.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return ascending[lo] + (ascending[hi] - ascending[lo]) * (i - lo);
}

/**
 * The review budget, and the only number here chosen rather than measured.
 *
 * It is a policy choice, not a fit: one flagged model output in two hundred is
 * a queue a human can actually read every week. Everything downstream of it —
 * the 11.5-point threshold — is then measured, not chosen. Stating it this way
 * round is deliberate: the alternative (pick a points threshold that "feels
 * right" and discover the review load afterwards) is how 4.5 got proposed.
 */
export const CORRIDOR_TARGET_FLAG_RATE = 0.005;

/**
 * Derive a corridor width from a sample of this project's own model-vs-market
 * divergences, in points. `residuals` is an array of signed (or absolute)
 * divergences; only magnitude is used.
 *
 * MUST be called with a TRAINING sample only when the result is going to be
 * evaluated — fitting a risk threshold on the same rows it is scored against
 * is exactly as overfit as fitting a model that way, and the assessment is
 * explicit that risk rules get no exemption from that.
 */
export function deriveCorridorThreshold(residuals, { targetFlagRate = CORRIDOR_TARGET_FLAG_RATE } = {}) {
  if (!Array.isArray(residuals)) throw new Error('residuals must be an array of model-vs-market divergences in points');
  if (!(targetFlagRate > 0 && targetFlagRate < 1)) throw new Error('targetFlagRate must be strictly between 0 and 1');
  const magnitudes = residuals.map(Number).filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
  if (!magnitudes.length) return { corridor_points: null, sample_size: 0, reason: 'no usable residuals supplied' };
  const threshold = quantile(magnitudes, 1 - targetFlagRate);
  return {
    corridor_points: r4(threshold),
    sample_size: magnitudes.length,
    target_flag_rate: targetFlagRate,
    realized_in_sample_flag_rate: r4(magnitudes.filter(m => m > threshold).length / magnitudes.length),
    median_abs_residual: r4(quantile(magnitudes, 0.5)),
    p99_abs_residual: r4(quantile(magnitudes, 0.99)),
    max_abs_residual: r4(magnitudes[magnitudes.length - 1])
  };
}

/**
 * Where 11.5 came from, recorded next to the rule so a future reader never has
 * to take it on faith. Every number below is reproduced by
 * test/nfl-execution-corridor.test.js from the same frozen substrate.
 */
export const CORRIDOR_DERIVATION = Object.freeze({
  derived_on: '2026-09-08',
  population: 'nfl_weekly_expert_examples, blind audit run 17 — the last completed comparable audit',
  population_detail: '12,318 model-vs-market divergences: 15 models x 831 games x 56 weeks, seasons 2022-2025, ' +
    'read from a read-only connection; no rebuild was run against league data',
  statistic: 'absolute divergence, in points, between a model output and the market line at the same decision instant',
  fold_protocol: 'expanding chronological folds by season, one-week embargo at each train/test boundary; ' +
    'the threshold is fit on the training block only and scored on the untouched test season',
  target_flag_rate: CORRIDOR_TARGET_FLAG_RATE,

  // Fit on each training block, scored on the season after it.
  out_of_fold: Object.freeze([
    Object.freeze({ test_season: 2023, train_rows: 2718, fitted_threshold_points: 11.684, realized_flag_rate: 0.00577 }),
    Object.freeze({ test_season: 2024, train_rows: 5838, fitted_threshold_points: 11.781, realized_flag_rate: 0.00288 }),
    Object.freeze({ test_season: 2025, train_rows: 8958, fitted_threshold_points: 11.514, realized_flag_rate: 0.00609 })
  ]),

  // The premise test: is a flagged divergence alpha, or error?
  alpha_test: Object.freeze({
    method: 'out-of-fold squared error of the model output vs. squared error of believing the market (residual 0)',
    inside_corridor: Object.freeze({ n: 9314, model_over_market_mse_ratio: 1.037, directional_accuracy: 0.4589 }),
    flagged: Object.freeze({ n: 46, model_over_market_mse_ratio: 2.647, directional_accuracy: 0.4565 }),
    difference_week_clustered_95: Object.freeze([0.928, 2.452]),
    conclusion: 'past the corridor, a divergence is error rather than edge — the interval excludes zero, so this ' +
      'is a measured result on held-out seasons rather than an assumption imported with the rule'
  }),

  // Forms that were tried and lost, kept rather than quietly dropped.
  rejected_forms: Object.freeze([
    Object.freeze({ form: 'per-model median-scaled z', reason: 'out-of-fold flag rate 0.51% / 2.98% / 0.06% against a 0.5% ' +
      'target — the per-model scale is itself unstable across seasons, and for a spiky model with a near-zero median ' +
      '(specialist_team: median 0.076, p99 8.97) the denominator explodes the statistic' }),
    Object.freeze({ form: 'per-model p95-scaled z', reason: 'out-of-fold flag rate 1.22% / 3.69% / 1.64% — same instability, ' +
      'less extreme' }),
    Object.freeze({ form: "the proposal's flat 4.5 points", reason: 'flags 7.15% / 6.31% / 6.28% of all model outputs ' +
      'out of fold, roughly one in fifteen — not a bug detector, an off switch' })
  ]),

  chosen_form: 'pooled absolute divergence, one threshold in points for every model',
  chosen_form_rationale: 'the only form whose realized out-of-fold flag rate stayed near target on all three held-out ' +
    'seasons, and the only one whose fitted value was stable across training blocks (11.684 / 11.781 / 11.514, a ' +
    'spread of 0.27 points). The scaled forms divide by a per-model scale estimated from few effective observations, ' +
    'which is unstable by construction; the out-of-fold table confirms an objection that was available a priori.',

  known_limitations: 'derived from spread-market divergences in points. A totals corridor, or a corridor on a ' +
    'probability-quoted market, needs its own derivation from its own residuals — the number below is not portable ' +
    'across markets and must not be reused as if it were.'
});

/**
 * The shipped corridor width, in points: the 99.5th percentile of the full
 * derivation population (11.6055), rounded down to 11.5 so the constant reads
 * as a decision rather than as spurious precision. At 11.5 the realized flag
 * rate is 0.56% over the whole population and 0.67% / 0.35% / 0.61% on the
 * three held-out seasons.
 */
export const MARKET_LINE_CORRIDOR_POINTS = 11.5;

/**
 * The check itself. `modelLine` and `marketLine` must be expressed in the SAME
 * sign frame — both as the number of points the same side is getting. Mixing
 * frames is not a hypothetical: the blind audit carries its internal model and
 * market numbers in one frame and its per-pick line in another, and reading
 * one against the other produces a mean divergence of -4.99 points out of
 * nothing at all. There is no way to detect that from the two numbers alone,
 * so the caller owns it and this note exists to make the trap visible.
 */
export function marketLineCorridorCheck({ modelLine, marketLine, corridorPoints = MARKET_LINE_CORRIDOR_POINTS } = {}) {
  if (!Number.isFinite(modelLine) || !Number.isFinite(marketLine)) {
    return {
      verdict: 'not_evaluated', divergence_points: null, corridor_points: corridorPoints,
      reason: 'a corridor check needs both a model line and a market line in the same sign frame; ' +
        'one or both were missing, and an unevaluated check is reported as such rather than as a pass'
    };
  }
  if (!Number.isFinite(corridorPoints) || corridorPoints <= 0) {
    throw new Error('corridorPoints must be a positive number of points');
  }
  const divergence = modelLine - marketLine;
  const outside = Math.abs(divergence) > corridorPoints;
  return {
    verdict: outside ? 'needs_review' : 'inside_corridor',
    divergence_points: r4(divergence),
    corridor_points: corridorPoints,
    // How far into the tail of this project's own history the divergence sits.
    percentile_of_project_history: outside ? '>99.5th' : null,
    reason: outside
      ? `the model line is ${r4(Math.abs(divergence))} points from the market, past the ${corridorPoints}-point ` +
        'corridor derived from this project\'s own residual history. Divergences this large have historically been ' +
        'error rather than edge (2.65x the market\'s squared error out of fold), so this is challenged as a probable ' +
        'bad join, stale feed or sign-frame mistake before it is treated as a signal.'
      : null
  };
}
