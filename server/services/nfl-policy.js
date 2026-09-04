/**
 * One frozen decision policy for NFL live picks and historical replay.
 *
 * Forecasting and decision policy are deliberately separate. Models may change
 * behind a version-pinned experiment, but production and replay must select the
 * same markets, threshold, disagreement guard, ranking, and weekly capacity.
 */
export const NFL_PRODUCTION_POLICY = Object.freeze({
  id: 'nfl-spread-v1',
  version: '1.1.0',
  markets: Object.freeze(['spread']),
  minEdge: 3,
  maxDisagreement: 4.5,
  maxPicksPerWeek: 5,
  ranking: 'absolute_edge_desc',
  priceRequirement: 'stored_quote_required',
  // A large forecast-to-market gap is not evidence by itself.  The current
  // NFL calibration has to demonstrate an out-of-sample improvement over the
  // no-vig market before a live candidate can be published as a pick.
  requireCalibratedAdvantage: true
});

/**
 * The forward-evidence sample gates from PROFITABILITY_PLAN.md §2. One
 * definition: four services used to carry their own copies (250 in two of
 * them, 200 in the other two), so the same ledger could read "gate passed"
 * on one page and "accumulating" on another. The plan (v1.3) governs: 200
 * settled independent decisions overall before any aggregate CLV claim, 75
 * in a market before a market-specific claim.
 */
export const FORWARD_SAMPLE_TARGETS = Object.freeze({
  overall: 200,
  per_market: 75,
  source: 'PROFITABILITY_PLAN.md §2 Market-edge gates'
});

// Historical diagnostics grade the selector that existed before the current
// calibration gate. Name that contract explicitly so an audit manifest never
// claims to test today's production policy while executing this older rule.
export const NFL_HISTORICAL_REPLAY_POLICY = Object.freeze({
  ...NFL_PRODUCTION_POLICY,
  id: 'nfl-spread-historical-replay-v1',
  version: '1.0.0',
  requireCalibratedAdvantage: false,
  authority: 'diagnostic_only',
  note: 'Grades the historical selector; it is not the current production publication gate.'
});

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
  if (!markets.length) throw new Error('NFL policy requires a supported market');
  if (!Number.isFinite(minEdge) || minEdge < 0 || minEdge > 14) throw new Error('NFL policy minEdge outside safe range');
  if (maxDisagreement != null && (!Number.isFinite(maxDisagreement) || maxDisagreement < 0 || maxDisagreement > 20)) {
    throw new Error('NFL policy maxDisagreement outside safe range');
  }
  if (!Number.isFinite(maxPicksPerWeek) || maxPicksPerWeek > 20) throw new Error('NFL policy weekly cap outside safe range');
  return {
    ...NFL_PRODUCTION_POLICY, ...raw, markets: [...new Set(markets)],
    minEdge, maxDisagreement, maxPicksPerWeek, requireCalibratedAdvantage
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
    return { ...candidate, input_index: inputIndex, eligible: abstentionReason == null, abstention_reason: abstentionReason };
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
