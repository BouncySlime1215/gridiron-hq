/**
 * North-star row 19: attention budget across the leagues (pure).
 *
 * Leverage this week = the best confirmed expected gain available (objective
 * points), scaled up as the trade deadline gets close, plus a bump when the
 * next move changed since the last refresh (something needs a look). Ranked
 * high to low; each row says why.
 */
export function leverage({ expected = 0, weeksToDeadline = null, changed = false, error = null }) {
  if (error) return { value: 0, why: 'planner failed for this league' };
  const urgency = Number.isFinite(weeksToDeadline) ? (weeksToDeadline <= 1 ? 1.5 : weeksToDeadline <= 3 ? 1.2 : 1) : 1;
  const value = Math.max(0, expected) * urgency + (changed ? 0.005 : 0);
  const bits = [`best move worth ${(Math.max(0, expected) * 100).toFixed(1)} pts`];
  if (urgency > 1) bits.push(`deadline in ${weeksToDeadline} wk`);
  if (changed) bits.push('next move changed');
  return { value, why: bits.join(', ') };
}

/**
 * One row per league (a league listed twice keeps its last row), ranked 1..of.
 * `of` is the number of leagues ranked, so rank <= of always holds.
 */
export function rankAttention(leagues) {
  const byLeague = new Map();
  for (const l of leagues) byLeague.set(String(l.league), l);
  const rows = [...byLeague.values()].map(l => ({ league: l.league, ...leverage(l) }))
    .sort((a, b) => b.value - a.value);
  return rows.map((x, i) => ({ ...x, rank: i + 1, of: rows.length }));
}
