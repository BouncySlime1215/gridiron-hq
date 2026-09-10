/**
 * One frozen decision policy for NFL live picks and historical replay.
 *
 * Forecasting and decision policy are deliberately separate. Models may change
 * behind a version-pinned experiment, but production and replay must select the
 * same markets, threshold, disagreement guard, ranking, and weekly capacity.
 */
export const NFL_PRODUCTION_POLICY = Object.freeze({
  id: 'nfl-spread-v1',
  /**
   * Codex correction C15: the expected-return gate was added at 1.1.0 without
   * bumping the identity past it, so two materially different economics ran
   * under one version. 1.2.0 is this correction: push semantics are explicit,
   * thresholds are validated, and eligibility is re-checked at the refreshed
   * offered price rather than only at selection time. A decision recorded
   * under 1.1.0 was decided by different rules and must never be compared to
   * one recorded under this version as though the policy had not changed.
   */
  version: '1.2.0',
  markets: Object.freeze(['spread']),
  minEdge: 3,
  maxDisagreement: 4.5,
  maxPicksPerWeek: 5,
  ranking: 'absolute_edge_desc',
  priceRequirement: 'stored_quote_required',
  // A large forecast-to-market gap is not evidence by itself.  The current
  // NFL calibration has to demonstrate an out-of-sample improvement over the
  // no-vig market before a live candidate can be published as a pick.
  requireCalibratedAdvantage: true,
  /**
   * Codex audit finding E2: beating the no-vig FAIR probability is not the
   * same as beating the OFFERED price, and this policy previously only
   * checked the former. A 51% forecast against a fair 50% is a genuine
   * forecasting improvement and still loses 2.636 cents per dollar at -110.
   * Nothing anywhere in the chain computed expected return at the actual
   * quoted odds, so an improvement over fair could become a published pick
   * while being negative-EV to take.
   *
   * This is the executable-economics floor, applied to the real price:
   * required net return per unit staked, after the slippage/cost buffer
   * below. Deliberately ABOVE zero — a bet whose expected value is
   * epsilon-positive is not worth taking once price movement between
   * selection and acceptance is real, and this project has measured
   * exactly zero forward CLV to justify assuming otherwise.
   */
  minExpectedReturn: 0.01,
  /**
   * Subtracted from the modeled win probability before computing expected
   * return: a conservative haircut standing in for price deterioration
   * between selection and acceptance, and for the fact that a calibrated
   * probability is itself an estimate. Not a measured constant — this
   * project has no forward CLV history to derive one from — so it is small,
   * explicit, and disclosed on every decision rather than hidden in a
   * formula.
   */
  probabilityHaircut: 0.01
});

/**
 * The forward-evidence sample gates, frozen as v1.3. One definition: four
 * services used to carry their own copies (250 in two of them, 200 in the
 * other two), so the same ledger could read "gate passed" on one page and
 * "accumulating" on another. v1.3 governs: 200 settled independent decisions
 * overall before any aggregate CLV claim, 75 in a market before a
 * market-specific claim. These are declared OPERATIONAL MINIMUMS, not a
 * universal statistical-sufficiency proof (see the frozen contract's own
 * provenance note).
 *
 * SOURCE MOVED 2026-09-10 (Codex audit, folder-reorganization disposition):
 * the numeric thresholds and their promotion discipline are unchanged from
 * the original `PROFITABILITY_PLAN.md §2 Market-edge gates` (that document
 * is superseded and removed from the working tree per Nick's "one active
 * plan" instruction); the frozen contract now lives at
 * docs/evidence/contracts/profitability-policy-v1.3.md, verbatim. A path
 * cleanup must never silently change these values or claim a historical run
 * used a different gate than it actually did.
 */
export const FORWARD_SAMPLE_TARGETS = Object.freeze({
  overall: 200,
  per_market: 75,
  source: 'docs/evidence/contracts/profitability-policy-v1.3.md §Market-edge gates'
});

// Historical diagnostics grade the selector that existed before the current
// calibration gate. Name that contract explicitly so an audit manifest never
// claims to test today's production policy while executing this older rule.
export const NFL_HISTORICAL_REPLAY_POLICY = Object.freeze({
  ...NFL_PRODUCTION_POLICY,
  id: 'nfl-spread-historical-replay-v1',
  version: '1.0.0',
  requireCalibratedAdvantage: false,
  // Explicitly NOT inherited from production. The whole point of this policy
  // is to grade the selector that historically existed, and that selector had
  // no executable-return gate; silently applying today's (Codex audit finding
  // E2) would change what every historical replay bets and make the blind
  // audit's numbers incomparable to every previous run. A diagnostic replay
  // has no calibrated probability to price with either.
  minExpectedReturn: null,
  authority: 'diagnostic_only',
  note: 'Grades the historical selector; it is not the current production publication gate.'
});

/**
 * Expected net return per unit staked, at the ACTUAL offered price (Codex
 * audit finding E2).
 *
 *   EV = p_win * profit_multiple - p_loss        (pushes return the stake)
 *
 * `winProbability` is CONDITIONAL on the bet being decided — which is what
 * this project's cover calibrator actually produces, since it discards
 * pushes when building its binary labels (`nfl-cover-calibration.js`). Push
 * mass is therefore applied separately here rather than being folded into
 * the probability: it scales the magnitude of the expected return (a bet
 * that pushes some of the time risks less and wins less) without changing
 * its sign.
 *
 * Returns null rather than a number when the inputs cannot support the
 * calculation — an unpriceable bet is not a zero-EV bet.
 */
export function expectedNetReturn({ winProbability, americanPrice, pushProbability = 0 } = {}) {
  // Reject null/undefined BEFORE Number(): `Number(null)` is 0, which would
  // price a missing probability as a certain loss rather than refusing to
  // price it at all — an unknown is not a zero.
  if (winProbability == null || americanPrice == null) return null;
  const p = Number(winProbability);
  const push = Number.isFinite(pushProbability) ? Math.min(Math.max(pushProbability, 0), 1) : 0;
  if (!Number.isFinite(p) || p < 0 || p > 1) return null;
  const price = Number(americanPrice);
  if (!Number.isFinite(price) || Math.abs(price) < 100) return null;
  const profitMultiple = price > 0 ? price / 100 : 100 / Math.abs(price);
  const decided = 1 - push;
  return decided * (p * profitMultiple - (1 - p));
}

export function normalizeNflPolicy(raw = {}) {
  const markets = (raw.markets ?? NFL_PRODUCTION_POLICY.markets)
    .filter(m => m === 'spread' || m === 'total' || m === 'moneyline');
  const minEdge = Number(raw.minEdge ?? NFL_PRODUCTION_POLICY.minEdge);
  const maxDisagreement = raw.maxDisagreement === null ? null
    : Number(raw.maxDisagreement ?? NFL_PRODUCTION_POLICY.maxDisagreement);
  const maxPicksPerWeek = Math.max(1, Math.floor(Number(
    raw.maxPicksPerWeek ?? NFL_PRODUCTION_POLICY.maxPicksPerWeek
  )));
  const requireCalibratedAdvantage = raw.requireCalibratedAdvantage == null
    ? NFL_PRODUCTION_POLICY.requireCalibratedAdvantage
    : Boolean(raw.requireCalibratedAdvantage);

  // Codex correction C15: "validate finite thresholds/haircut and their
  // domains." A NEGATIVE haircut does not make the policy braver in some
  // abstract sense -- it INCREASES the modelled win probability, which can
  // flip a rejection into a selection. A haircut is a conservative
  // adjustment by definition, and one that adds confidence is a
  // configuration error, not a preference.
  const probabilityHaircut = raw.probabilityHaircut == null
    ? NFL_PRODUCTION_POLICY.probabilityHaircut : Number(raw.probabilityHaircut);
  if (!Number.isFinite(probabilityHaircut) || probabilityHaircut < 0 || probabilityHaircut >= 1) {
    throw new Error(`NFL policy probabilityHaircut must be a finite value in [0,1), got ${raw.probabilityHaircut}`);
  }
  // `null` is a meaningful value here (the historical replay policy has no
  // executable-return gate, deliberately), so `?? default` would be wrong --
  // it would resurrect production's floor for exactly the policy that must
  // not have one. Only an ABSENT key falls back.
  const minExpectedReturn = !('minExpectedReturn' in raw)
    ? NFL_PRODUCTION_POLICY.minExpectedReturn
    : (raw.minExpectedReturn == null ? null : Number(raw.minExpectedReturn));
  if (minExpectedReturn != null && (!Number.isFinite(minExpectedReturn)
      || minExpectedReturn < 0 || minExpectedReturn > 1)) {
    throw new Error('NFL policy minExpectedReturn outside safe range');
  }
  if (!markets.length) throw new Error('NFL policy requires a supported market');
  if (!Number.isFinite(minEdge) || minEdge < 0 || minEdge > 14) throw new Error('NFL policy minEdge outside safe range');
  if (maxDisagreement != null && (!Number.isFinite(maxDisagreement) || maxDisagreement < 0 || maxDisagreement > 20)) {
    throw new Error('NFL policy maxDisagreement outside safe range');
  }
  if (!Number.isFinite(maxPicksPerWeek) || maxPicksPerWeek > 20) throw new Error('NFL policy weekly cap outside safe range');
  return {
    ...NFL_PRODUCTION_POLICY, ...raw, markets: [...new Set(markets)],
    minEdge, maxDisagreement, maxPicksPerWeek, requireCalibratedAdvantage, minExpectedReturn,
    probabilityHaircut
  };
}
/**
 * Evaluates and ranks a full weekly candidate set. Every input receives a
 * decision record, including abstentions, so missing data cannot disappear.
 */
export function applyNflPolicy(rawCandidates, rawPolicy = NFL_PRODUCTION_POLICY) {
  const policy = normalizeNflPolicy(rawPolicy);
  const evaluated = rawCandidates.map((candidate, inputIndex) => {
    let abstentionReason = null;
    if (!policy.markets.includes(candidate.market)) abstentionReason = 'market_not_in_policy';
    // Moneyline has no line by definition — it is priced entirely off the
    // American odds — so requiring one here would abstain on every candidate
    // regardless of whether a real edge exists, which is a missing-data check
    // mistakenly applied to a market that was never supposed to have that field.
    else if (candidate.market !== 'moneyline' && candidate.line == null) abstentionReason = 'missing_line';
    else if (candidate.american_price == null) abstentionReason = 'missing_price';
    else if (!Number.isFinite(candidate.edge_points)) abstentionReason = 'missing_model_edge';
    else if (policy.requireCalibratedAdvantage && candidate.calibration_eligible !== true) {
      abstentionReason = 'calibration_not_proven';
    }
    else if (candidate.edge_points < policy.minEdge) abstentionReason = 'edge_below_threshold';
    else if (candidate.disagreement == null) abstentionReason = 'missing_disagreement';
    else if (policy.maxDisagreement != null && candidate.disagreement > policy.maxDisagreement) {
      abstentionReason = 'model_disagreement';
    }

    // Codex audit finding E2: forecast skill, calibration eligibility and
    // BET PROFITABILITY are three separate conditions, and only the first two
    // were ever checked. A calibrated probability that beats the no-vig fair
    // price can still lose money at the offered price. Reported separately
    // (never folded into edge_points, which is in game points, not money)
    // and applied last, so an abstention names the specific thing that failed.
    const haircut = policy.probabilityHaircut;

    // Codex correction C15: the board does not emit `push_probability`, so
    // `candidate.push_probability ?? 0` silently priced every integer line as
    // though a push were impossible. It is not: a -3 spread pushes on roughly
    // one game in ten, and treating that mass as decided overstates both the
    // win and the loss branch. An unknown push on an integer line is
    // UNAVAILABLE, not zero.
    //
    // Half-point lines are the exception and are exact rather than assumed:
    // integer final scores cannot land on a half, so their push mass is zero
    // by arithmetic.
    const halfPoint = candidate.line != null
      && Math.abs(Math.abs(candidate.line % 1) - 0.5) < 1e-9;
    const pushProbability = candidate.push_probability != null ? candidate.push_probability
      : (halfPoint || candidate.market === 'moneyline' ? 0 : null);

    const haircutProbability = candidate.model_probability == null
      ? null : candidate.model_probability - haircut;
    const expectedReturn = pushProbability == null ? null : expectedNetReturn({
      winProbability: haircutProbability,
      americanPrice: candidate.american_price,
      pushProbability
    });
    if (abstentionReason == null && policy.minExpectedReturn != null) {
      if (pushProbability == null) abstentionReason = 'push_probability_unknown';
      else if (expectedReturn == null) abstentionReason = 'expected_return_unknown';
      else if (expectedReturn < policy.minExpectedReturn) abstentionReason = 'negative_expected_return';
    }

    return { ...candidate, input_index: inputIndex,
      // The economic condition, always reported even when this policy does
      // not gate on it, so a diagnostic replay still shows what a bet would
      // have been worth at its real price.
      expected_return: expectedReturn == null ? null : +expectedReturn.toFixed(5),
      expected_return_after_haircut_of: haircut || null,
      // The push treatment this decision was actually made under, recorded
      // rather than left to be inferred. `null` means the push mass was
      // unknown on an integer line and the candidate was abstained, not that
      // it was assumed to be zero.
      push_probability: pushProbability,
      push_treatment: pushProbability == null ? 'unknown_on_integer_line'
        : (halfPoint ? 'zero_by_arithmetic_half_point' : 'supplied_estimate'),
      eligible: abstentionReason == null, abstention_reason: abstentionReason };
  });

  const ranked = evaluated.filter(x => x.eligible)
    .sort((a, b) => b.edge_points - a.edge_points || a.input_index - b.input_index);
  ranked.forEach((x, i) => { x.policy_rank = i + 1; });
  for (const x of ranked.slice(policy.maxPicksPerWeek)) {
    x.eligible = false;
    x.abstention_reason = 'weekly_capacity';
  }
  const decisions = evaluated.sort((a, b) => (a.policy_rank ?? 999) - (b.policy_rank ?? 999) || a.input_index - b.input_index);
  return { policy, decisions, selected: decisions.filter(x => x.eligible).slice(0, policy.maxPicksPerWeek) };
}
