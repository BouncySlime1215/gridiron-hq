/**
 * Trades ranked by the only thing that actually matters: championship odds.
 *
 * Every trade tool in this app — and every one anywhere — scores a deal in
 * points per week. Points are a proxy. Nobody's season goal is "average 3 more
 * points"; it is to win the league, and those are not the same objective. A
 * deal that adds 2 ppg to a team already leading its division is worth far less
 * than one that adds 1 ppg to a team on the playoff bubble, because title odds
 * are steeply nonlinear in exactly the region where most teams live.
 *
 * The simulator that answers this has existed the whole time and was used to
 * print one percentage on one card. `tradeImpact` even runs the league twice
 * under COMMON RANDOM NUMBERS — same seed before and after — so the delta it
 * reports is the trade's effect rather than the difference between two noisy
 * simulations. That is the right technique and it is what makes a delta this
 * small measurable at all.
 *
 * WHY THIS IS TWO ENGINES AND NOT ONE: a full simulation costs ~7 seconds, and
 * the space of plausible 2-for-2 deals across nine rivals is thousands. Scoring
 * them all would take hours. So the cheap lineup-based finder generates
 * candidates and the expensive simulator scores only the shortlist — a filter
 * feeding a scorer, which is the only structure that makes this tractable.
 */
import { row } from '../db/index.js';
import { findTrades } from './trade-engine.js';
import { tradeImpact } from './season-sim.js';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

const _cache = new Map();
export function clearTitleOddsTradeCache() { _cache.clear(); }

/**
 * @param shortlist how many finder candidates to simulate. Each costs ~7s, so
 *   this is the dial between coverage and latency. The default is deliberately
 *   modest; the finder already ranks by lineup gain, so the deals most likely
 *   to move title odds are near the top of its list.
 */
export function titleOddsTrades(leagueId, {
  teamId = null, shortlist = 8, runs = 800, requireMutual = true
} = {}) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };

  const key = `${leagueId}|${teamId}|${shortlist}|${runs}|${requireMutual}|${lg.fetched_at}`;
  if (_cache.has(key)) return _cache.get(key);

  const found = findTrades(lg, { myTeamId: teamId, requireMutual, limit: shortlist * 3 });
  if (found.error) return found;

  // One deal per partner+headline idea. Simulating ten variants of the same
  // swap burns the entire budget re-answering one question.
  const seen = new Set();
  const candidates = [];
  for (const d of found.deals ?? []) {
    const headline = list => list.slice().sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0]?.id;
    const k = `${d.partner_id}|${headline(d.i_give)}|${headline(d.i_get)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    candidates.push(d);
    if (candidates.length >= shortlist) break;
  }

  const scored = [];
  for (const d of candidates) {
    const impact = tradeImpact(lg, {
      myTeamId: teamId ?? lg.my_team_id, theirTeamId: d.partner_id,
      iGive: d.i_give.map(p => p.id), iGet: d.i_get.map(p => p.id),
      runs, seed: 1                     // fixed seed: every deal faces the same season
    });
    if (impact.error) continue;
    scored.push({
      partner: d.partner, partner_id: d.partner_id,
      i_give: d.i_give.map(p => ({ id: p.id, name: p.name, position: p.position })),
      i_get: d.i_get.map(p => ({ id: p.id, name: p.name, position: p.position })),
      ppg_delta: d.me?.ppg_delta ?? null,
      value_delta: d.me?.value_delta ?? null,
      fairness: d.fairness ?? null,
      title_before: impact.me.title_before, title_after: impact.me.title_after,
      title_delta: r4(impact.me.title_delta),
      playoff_delta: r4(impact.me.playoff_delta),
      // What the deal does for THEM, because a trade they will not accept is
      // worth nothing however much it helps us.
      their_title_delta: r4(impact.them.title_delta),
      mutual_title_gain: impact.me.title_delta > 0 && impact.them.title_delta > 0
    });
  }

  scored.sort((a, b) => (b.title_delta ?? 0) - (a.title_delta ?? 0));

  // The comparison that justifies the whole feature: does ranking by points
  // pick the same deal as ranking by championship probability? When it does
  // not, points was giving the wrong answer.
  const byPoints = [...scored].sort((a, b) => (b.ppg_delta ?? 0) - (a.ppg_delta ?? 0));

  // The disagreement that matters is NOT "the two rankings pick different
  // partners". It is that the deal points likes is one championship odds
  // rejects — a trade can add three points a week and still make you less
  // likely to win the league, and that is the case worth shouting about.
  const topByPoints = byPoints[0] ?? null;
  const pointsSaysYesTitleSaysNo = !!topByPoints && (topByPoints.ppg_delta ?? 0) > 0
    && (topByPoints.title_delta ?? 0) < 0;
  const allPositivePointsNegativeTitle = scored.length > 0
    && scored.every(d => (d.ppg_delta ?? 0) > 0 && (d.title_delta ?? 0) < 0);
  const differentPick = scored.length > 1 && topByPoints && scored[0]
    && topByPoints.partner !== scored[0].partner;
  const disagree = pointsSaysYesTitleSaysNo || differentPick;

  const value = {
    league: lg.name,
    considered: found.deals?.length ?? 0,
    simulated: scored.length,
    runs_each: runs,
    deals: scored,
    best_by_title: scored[0] ?? null,
    best_by_points: byPoints[0] ?? null,
    objectives_disagree: disagree,
    every_deal_helps_points_hurts_title: allPositivePointsNegativeTitle,
    disagreement_note: allPositivePointsNegativeTitle
      ? 'EVERY shortlisted deal adds points per week and LOWERS your championship odds. The points ' +
        'ranking would have recommended all of them. Points is a proxy; this is the thing it proxies ' +
        'for, and here they point in opposite directions.'
      : pointsSaysYesTitleSaysNo
        ? 'The deal that adds the most points per week LOWERS your championship odds. Take the title ' +
          'ranking — points is the proxy, not the goal.'
        : differentPick
          ? 'Points and championship odds pick different deals. The points ranking is the one to ignore.'
          : 'Both rankings agree on the top deal.',
    note: 'Each deal is simulated twice under common random numbers — the same season plays out ' +
      'with and without the trade — so the delta is the trade\'s effect and not the gap between ' +
      'two noisy runs. Candidates come from the lineup-based finder because simulating every ' +
      'possible deal would take hours.'
  };
  _cache.set(key, value);
  return value;
}
