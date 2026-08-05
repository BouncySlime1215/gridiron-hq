/**
 * One frozen decision policy for NFL live picks and historical replay.
 *
 * Forecasting and decision policy are deliberately separate. Models may change
 * behind a version-pinned experiment, but production and replay must select the
 * same markets, threshold, disagreement guard, ranking, and weekly capacity.
 */
export const NFL_PRODUCTION_POLICY = Object.freeze({
  id: 'nfl-spread-v1',
  version: '1.0.0',
  markets: Object.freeze(['spread']),
  minEdge: 3,
  maxDisagreement: 4.5,
  maxPicksPerWeek: 5,
  ranking: 'absolute_edge_desc',
  priceRequirement: 'stored_quote_required'
});

export function normalizeNflPolicy(raw = {}) {
  const markets = (raw.markets ?? NFL_PRODUCTION_POLICY.markets)
    .filter(m => m === 'spread' || m === 'total');
  const minEdge = Number(raw.minEdge ?? NFL_PRODUCTION_POLICY.minEdge);
  const maxDisagreement = raw.maxDisagreement === null ? null
    : Number(raw.maxDisagreement ?? NFL_PRODUCTION_POLICY.maxDisagreement);
  const maxPicksPerWeek = Math.max(1, Math.floor(Number(
    raw.maxPicksPerWeek ?? NFL_PRODUCTION_POLICY.maxPicksPerWeek
  )));
  if (!markets.length) throw new Error('NFL policy requires a supported market');
  if (!Number.isFinite(minEdge) || minEdge < 0 || minEdge > 14) throw new Error('NFL policy minEdge outside safe range');
  if (maxDisagreement != null && (!Number.isFinite(maxDisagreement) || maxDisagreement < 0 || maxDisagreement > 20)) {
    throw new Error('NFL policy maxDisagreement outside safe range');
  }
  if (!Number.isFinite(maxPicksPerWeek) || maxPicksPerWeek > 20) throw new Error('NFL policy weekly cap outside safe range');
  return {
    ...NFL_PRODUCTION_POLICY, ...raw, markets: [...new Set(markets)],
    minEdge, maxDisagreement, maxPicksPerWeek
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
    else if (candidate.line == null) abstentionReason = 'missing_line';
    else if (candidate.american_price == null) abstentionReason = 'missing_price';
    else if (!Number.isFinite(candidate.edge_points)) abstentionReason = 'missing_model_edge';
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
