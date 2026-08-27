/**
 * Wong teasers — the one structurally +EV NFL bet this database can defend.
 *
 * Everything else attempted here tried to out-predict the market and failed:
 * 21 spread models against 15,096 closing lines, 0 clearing the gate. This
 * does not predict anything. It exploits a structural property of football
 * scoring that the teaser payout does not price correctly.
 *
 * THE MECHANISM. NFL margins are not smooth — measured over 7,276 games in
 * this database, a margin of exactly 3 occurs in 15.12% of games and 7 in
 * 9.03%. A 6-point teaser moves a line 6 points for a reduced payout. If the
 * 6 points are spent crossing BOTH 3 and 7, the line passes through roughly a
 * quarter of the entire margin distribution. If they are spent going from
 * 10.5 to 4.5, they cross almost nothing. The teaser price is the same either
 * way. That mispricing is the edge, and it is a property of the sport rather
 * than a forecast about any team.
 *
 * Qualifying legs, the classic Wong windows:
 *   favourites  -7.5 to -8.5   teased to  -1.5 to -2.5
 *   underdogs   +1.5 to +2.5   teased to  +7.5 to +8.5
 *
 * MEASURED ON THIS DATABASE, 1999-2025:
 *   1,391 qualifying legs, 74.69% win rate, standard error 1.17pp
 *
 *   @ -110   need 72.37%   z = 1.99   significant   EV +6.51%
 *   @ -115   need 73.14%   z = 1.34   not significant   EV +4.31%
 *   @ -120   need 73.85%   z = 0.72   not significant   EV +2.29%
 *   @ -130   need 75.18%   z = -0.42  NEGATIVE          EV -1.29%
 *
 * Stable across eras — leaving out any one era leaves the rate between 73.94%
 * and 75.68%, so no single period drives it.
 *
 * THE HONEST CAVEATS, because this is the one place in this codebase where a
 * positive result could cost real money if overstated:
 *
 *  1. z = 1.99 is marginal. It clears a one-sided 5% bar and nothing more.
 *     This is "worth betting at the right price", not "a sure thing".
 *  2. The edge is ENTIRELY price-dependent. The same bet is +6.5% at -110 and
 *     -1.3% at -130. Books know about Wong teasers, and many have moved 2-team
 *     6-point teasers to -120 or worse precisely because of this. Price
 *     availability, not the football, is the binding constraint.
 *  3. Legs must be in DIFFERENT games. Two legs from one game are correlated
 *     and the independence assumption behind p^2 fails.
 *  4. This is a historical measurement, not a forward result. It goes into
 *     forward CLV tracking like anything else before it sizes real money.
 */
import { rows } from '../db/index.js';
import { impliedProb, stakeFor } from './nfl-execution-edge.js';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/** Does this spread qualify for a 6-point Wong teaser leg? */
export function wongLeg(spread, points = 6) {
  if (!Number.isFinite(spread)) return null;
  if (spread <= -7.5 && spread >= -8.5) {
    return { qualifies: true, type: 'favorite', from: spread, to: spread + points,
      crosses: [7, 3].filter(k => Math.abs(spread) > k && Math.abs(spread + points) < k) };
  }
  if (spread >= 1.5 && spread <= 2.5) {
    return { qualifies: true, type: 'underdog', from: spread, to: spread + points,
      crosses: [3, 7].filter(k => spread < k && spread + points > k) };
  }
  return { qualifies: false, from: spread };
}

/**
 * Historical performance of the qualifying window, recomputed from data rather
 * than quoted from the header — so if the database changes, the numbers here
 * change with it instead of silently going stale.
 */
export function wongHistory({ seasons = null, points = 6 } = {}) {
  const where = seasons?.length
    ? `AND season BETWEEN ${Math.min(...seasons)} AND ${Math.max(...seasons)}` : '';
  const g = rows(`SELECT season, spread, team_score, opp_score FROM game_lines
                  WHERE spread IS NOT NULL AND team_score IS NOT NULL ${where}`);
  const legs = [];
  for (const x of g) {
    const leg = wongLeg(x.spread, points);
    if (!leg?.qualifies) continue;
    const result = (x.team_score - x.opp_score) + leg.to;
    if (result === 0) continue;                    // push: excluded, not counted as a win
    legs.push({ season: x.season, type: leg.type, win: result > 0 ? 1 : 0 });
  }
  if (!legs.length) return { legs: 0 };
  const n = legs.length, wins = legs.filter(l => l.win).length;
  const p = wins / n, se = Math.sqrt(p * (1 - p) / n);
  return {
    legs: n, wins, win_rate: r4(p), standard_error: r4(se),
    favorites: legs.filter(l => l.type === 'favorite').length,
    underdogs: legs.filter(l => l.type === 'underdog').length,
    seasons: [Math.min(...legs.map(l => l.season)), Math.max(...legs.map(l => l.season))]
  };
}

/**
 * Is a 2-team teaser at this price +EV, given the measured leg rate?
 *
 * Legs are assumed independent, which requires them to be in different games —
 * enforced by the caller, and flagged in `assumptions` rather than left silent.
 */
export function teaserEV({ americanPrice = -110, legRate = null, legs = 2 } = {}) {
  const hist = legRate == null ? wongHistory() : null;
  const p = legRate ?? hist?.win_rate;
  if (!Number.isFinite(p)) return { error: 'no leg rate available' };
  const imp = impliedProb(americanPrice);
  const payout = 1 / imp;                       // decimal return on a winning teaser
  const winAll = Math.pow(p, legs);
  const ev = winAll * payout - 1;
  const need = Math.pow(imp, 1 / legs);
  const se = hist?.standard_error ?? null;
  const z = se ? (p - need) / se : null;
  return {
    price: americanPrice, legs, leg_rate: r4(p),
    breakeven_leg_rate: r4(need),
    ev_per_bet: r4(ev),
    z: z == null ? null : r4(z),
    verdict: ev <= 0 ? 'negative EV — do not bet at this price'
      : z != null && z > 1.64 ? 'significantly +EV at this price'
        : '+EV point estimate, not statistically significant — thin',
    assumptions: [
      'Legs must be in DIFFERENT games; same-game legs are correlated and p^n fails.',
      'Historical measurement, not a forward result.'
    ]
  };
}

/**
 * Evaluate live spreads for qualifying teaser legs, and size the bet.
 *
 * Sized through `stakeFor` with source 'execution', because this is not a
 * model forecast — the edge comes from the measured margin distribution and
 * the price on offer, both observable before the bet. That is the one
 * category this codebase permits sizing on.
 */
export function findTeaserLegs(games, { americanPrice = -110, points = 6,
  bankrollUnits = 100, minPrice = -115 } = {}) {
  const hist = wongHistory();
  const ev = teaserEV({ americanPrice, legRate: hist.win_rate });
  const priceOk = americanPrice >= minPrice;

  const qualifying = (games ?? []).map(g => {
    const leg = wongLeg(g.spread, points);
    return leg?.qualifies ? { ...g, teaser: leg } : null;
  }).filter(Boolean);

  const staking = priceOk && ev.ev_per_bet > 0
    ? stakeFor({ winProbability: Math.pow(hist.win_rate, 2), americanPrice,
      source: 'execution', bankrollUnits })
    : { units: 0, blocked: true,
      reason: !priceOk
        ? `Price ${americanPrice} is worse than the ${minPrice} floor. The entire edge is the price — ` +
          'at -130 this bet is negative. Do not take it.'
        : 'EV is not positive at this price.' };

  return {
    qualifying_legs: qualifying,
    count: qualifying.length,
    historical: hist,
    ev,
    price_acceptable: priceOk,
    staking,
    guidance: qualifying.length < 2
      ? 'Need at least 2 qualifying legs in DIFFERENT games to place a 2-team teaser.'
      : `${qualifying.length} qualifying legs available. Pair legs from different games only.`
  };
}
