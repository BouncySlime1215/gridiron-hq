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
 * Qualifying legs, the CROSS-BOTH window — every line where six points
 * strictly crosses both 3 and 7, which is the mechanism and therefore the
 * whole set:
 *   favourites  -7.0 to -8.5   teased to  -1.0 to -2.5
 *   underdogs   +1.5 to +3.0   teased to  +7.5 to +9.0
 *
 * This is wider than the classic Wong window, which omits -7.0 and +3.0 for no
 * reason the mechanism supports: a favourite laying 7 teased to -1 crosses 7
 * and 3 exactly as one laying 7.5 does. Widening it roughly doubles the number
 * of legs a week offers, at a rate the data cannot distinguish.
 *
 * MEASURED ON THIS DATABASE, 1999-2024:
 *   2,894 legs, 26 pushes, 2,868 decided, 74.06%
 *   favourites 74.41% (n=940), underdogs 73.89% (n=1,954)
 *
 * 2025 and 2026 are EXCLUDED and the exclusion is load-bearing rather than
 * cautious: `game_lines.spread` is corrupted for both seasons. Integer share
 * falls 47.7% -> 24.9% -> 16.2%, and the -8.0 and +2.0 buckets hold zero rows
 * in either season, so a window including them silently pools six of eight
 * legs. The earlier headline of 74.69% over "1999-2025" was computed across
 * that contamination.
 *
 * The authority for all of this is
 * `server/betting/nfl/strategy/teaser-leg-rates.js`, which computes it from
 * the table rather than quoting it, and which this module now defers to. Two
 * numbers there correct figures this file used to assert:
 *
 *  - The per-leg rate must not be ranked by line. Chi-square across the eight
 *    lines is 5.994 on 7 df, p = 0.54 — LESS dispersion than a single common
 *    rate predicts. +1.5 reading 78.70% and +2.0 reading 70.91% on identical
 *    n=169 is noise, not a better number.
 *  - Same-week legs on this family are NEGATIVELY correlated, rho = -0.044
 *    (joint 54.00% against p^2 of 54.85%, 8,224 pairs). The +0.082 this
 *    project used to quote is real but belongs to the classic six-line window.
 *    So independence is mildly OPTIMISTIC here, not conservative.
 *
 * THE HONEST CAVEATS, because this is the one place in this codebase where a
 * positive result could cost real money if overstated:
 *
 *  1. The edge is ENTIRELY price-dependent, and this is the binding
 *     constraint rather than the football. Break-even on two legs at this
 *     family's rate is -120.22 under stake-back push grading. The same bet is
 *     +9.06% at +100, +4.16% at -110 and -3.37% at -130. Books know about Wong
 *     teasers, and many have moved 2-team 6-point teasers to -120 or worse
 *     precisely because of this.
 *  2. Nothing separates one qualifying leg from another. The model's own edge
 *     correlates -0.007 with how games land against the spread over 2,761
 *     games; 501 game-feature hypotheses and 4,060 window searches produced no
 *     survivor of multiple-comparison correction. The only real separator
 *     between two tickets is push exposure, since a half-point leg cannot push
 *     at all. Do not add a ranking here.
 *  3. Legs must be in DIFFERENT games. Two legs from one game are correlated
 *     and the independence assumption behind p^2 fails.
 *  4. This is a historical measurement, not a forward result. It goes into
 *     forward CLV tracking like anything else before it sizes real money.
 */
import { rows } from '../db/index.js';
import { impliedProb, stakeFor } from './nfl-execution-edge.js';
import {
  CROSS_BOTH_LINES, KEY_NUMBERS, TEASER_POINTS, MEASUREMENT_SEASONS, ticketEV,
} from '../betting/nfl/strategy/teaser-leg-rates.js';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/**
 * Does this spread qualify for a 6-point teaser leg?
 *
 * Membership is delegated rather than restated. The eight numbers are derived
 * in `teaser-leg-rates.js` from the mechanism -- six points must gain both 3
 * and 7 -- and a second hand-maintained copy of that list here is a copy that
 * will eventually disagree with the measurement built on it.
 *
 * `crosses` used strict inequalities, which quietly mislabelled the two lines
 * the window was missing. A favourite at exactly -7.0 fails `abs(-7) > 7`, so
 * a leg that gains 7 outright would have reported crossing only 3; a dog at
 * exactly +3.0 fails `3 < 3` the same way. Sitting ON a key number and teasing
 * through it converts that number's push into a win, which is a gain, not a
 * miss. Inclusive bounds say so.
 */
export function wongLeg(spread, points = 6) {
  if (!Number.isFinite(spread)) return null;
  const qualifies = points === TEASER_POINTS && CROSS_BOTH_LINES.includes(spread);
  if (!qualifies) return { qualifies: false, from: spread };
  const to = spread + points;
  const gains = k => (spread <= -k && to > -k) || (spread <= k && to >= k);
  return {
    qualifies: true, type: spread < 0 ? 'favorite' : 'underdog',
    from: spread, to, crosses: KEY_NUMBERS.filter(gains),
  };
}

/**
 * Historical performance of the qualifying window, recomputed from data rather
 * than quoted from the header — so if the database changes, the numbers here
 * change with it instead of silently going stale.
 */
export function wongHistory({ seasons = null, points = 6 } = {}) {
  // The measurement window is bounded by default, and the bound is a data
  // defect rather than a preference. `game_lines.spread` is corrupted for 2025
  // and 2026 -- whole integers are largely absent, and the -8.0 and +2.0
  // buckets are empty in both -- so including them pools six of the eight legs
  // and reports the result as if it were all eight. A caller may still ask for
  // those seasons explicitly; it just cannot get them by accident.
  const from = seasons?.length ? Math.min(...seasons) : MEASUREMENT_SEASONS.from;
  const to = seasons?.length ? Math.max(...seasons) : MEASUREMENT_SEASONS.to;
  const g = rows(`SELECT season, spread, team_score, opp_score FROM game_lines
                  WHERE spread IS NOT NULL AND team_score IS NOT NULL AND opp_score IS NOT NULL
                    AND season BETWEEN ? AND ?`, from, to);
  const legs = [];
  for (const x of g) {
    const leg = wongLeg(x.spread, points);
    if (!leg?.qualifies) continue;
    const result = (x.team_score - x.opp_score) + leg.to;
    legs.push({ season: x.season, type: leg.type, push: result === 0, win: result > 0 ? 1 : 0 });
  }
  if (!legs.length) return { legs: 0 };

  // A push is kept in the leg count and taken out of the rate's denominator.
  // Reporting only the decided rate, as this used to, hides the fact that the
  // four integer legs can push at all -- and a ticket's third outcome, where
  // one leg pushes and the book reduces the bet, is priced off exactly that
  // mass. `teaser-leg-rates.js` needs the split; so does honest settlement.
  const pushes = legs.filter(l => l.push).length;
  const decided = legs.filter(l => !l.push);
  const n = decided.length, wins = decided.filter(l => l.win).length;
  const p = wins / n, se = Math.sqrt(p * (1 - p) / n);
  return {
    legs: legs.length, decided: n, wins, pushes,
    win_rate: r4(p), standard_error: r4(se),
    push_share: r4(pushes / legs.length),
    favorites: decided.filter(l => l.type === 'favorite').length,
    underdogs: decided.filter(l => l.type === 'underdog').length,
    seasons: [Math.min(...legs.map(l => l.season)), Math.max(...legs.map(l => l.season))]
  };
}

/**
 * Is a 2-team teaser at this price +EV, given the measured leg rate?
 *
 * Legs are assumed independent, which requires them to be in different games —
 * enforced by the caller, and flagged in `assumptions` rather than left silent.
 */
export function teaserEV({ americanPrice = -110, legRate = null, standardError = null, legs = 2,
  pushShare = null } = {}) {
  // Only recompute history when the caller didn't already have it — but a
  // caller supplying legRate without standardError still needs it for z, so
  // fetch history for the SE whenever it wasn't explicitly provided too.
  const hist = legRate == null || standardError == null ? wongHistory() : null;
  const p = legRate ?? hist?.win_rate;
  if (!Number.isFinite(p)) return { error: 'no leg rate available' };
  const imp = impliedProb(americanPrice);
  const payout = 1 / imp;                       // decimal return on a winning teaser
  const need = Math.pow(imp, 1 / legs);
  const se = standardError ?? hist?.standard_error ?? null;
  const z = se ? (p - need) / se : null;

  // A ticket has THREE outcomes, not two, and this used to model two. A push on
  // one leg neither wins nor loses it: the book removes that leg and the ticket
  // reduces. `p^legs * payout - 1` prices the reduced bucket as a total loss,
  // which overstates expected value -- at +100 on this family it reads +9.70%
  // where the correct figure is +9.06%.
  //
  // The correction LOWERS the number. That is worth stating plainly, because
  // the widened leg set and a good price arrived at the same time as this fix,
  // and it would be easy to read a maths correction as a discovery.
  //
  // The push share is taken from the measured history rather than assumed,
  // and `ticketEV` grades the reduced bucket conservatively (stake back) since
  // what a reduced ticket actually pays is book-specific and unobserved here.
  // PUSH SHARE IS A PROPERTY OF THE POSTED NUMBER, NOT OF THE FAMILY.
  //
  // The four half-point lines cannot push at all; the four integer lines push
  // 0.7%-2.5% of the time. Pricing a ticket of two half-point legs with the
  // pooled 0.9% invents a reduced bucket that physically cannot occur, and
  // pricing two -7 legs with it understates the one that can.
  //
  // Measured across all 36 unordered pairs at -110 the error runs from -0.97pp
  // to +0.55pp of EV — a 1.52pp spread, and 3.54 points of break-even price. At
  // a quoted -119 the pooled figure calls a ticket +EV that is, on two -7 legs,
  // actually negative. So a caller that knows which legs it holds should pass
  // their share; the pooled value is the fallback for a caller pricing the
  // family in the abstract, and it is labelled as such in the return.
  const pooledPushShare = hist?.push_share ?? wongHistory().push_share ?? 0;
  const effectivePushShare = Number.isFinite(pushShare) ? pushShare : pooledPushShare;
  const perLeg = { w: (1 - effectivePushShare) * p, t: effectivePushShare };
  // A ticket with more than two legs is REFUSED rather than silently priced by
  // the two-state formula this function exists to replace. A three-leg ticket
  // with one push reduces to a double and with two pushes to a single, and
  // those pay differently; one scalar cannot say which happened.
  if (legs !== 2) {
    return { error: `teaserEV models the reduced-push bucket only for a two-leg ticket; ` +
      `a ${legs}-leg ticket with a possible push reduces to several different bets`,
    price: americanPrice, legs };
  }
  const priced = ticketEV({ legs: [perLeg, perLeg], americanPrice });
  const ev = priced.ev;

  return {
    price: americanPrice, legs, leg_rate: r4(p),
    breakeven_leg_rate: r4(need),
    ev_per_bet: r4(ev),
    push_share: r4(effectivePushShare),
    push_share_source: Number.isFinite(pushShare) ? 'caller_legs' : 'family_pooled',
    probabilities: priced.probabilities,
    reduced_payout: priced.reduced_payout,
    reduced_payout_verified: false,
    z: z == null ? null : r4(z),
    verdict: ev <= 0 ? 'negative EV — do not bet at this price'
      : z != null && z > 1.64 ? 'significantly +EV at this price'
        : '+EV point estimate, not statistically significant — thin',
    assumptions: [
      'Legs must be in DIFFERENT games; same-game legs are correlated and p^n fails.',
      'A push reduces the ticket rather than losing it; the reduced payout is graded as stake back because no book\'s reduced price has been observed here.',
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
  const ev = teaserEV({ americanPrice, legRate: hist.win_rate, standardError: hist.standard_error });
  const priceOk = americanPrice >= minPrice;

  const qualifying = (games ?? []).map(g => {
    const leg = wongLeg(g.spread, points);
    return leg?.qualifies ? { ...g, teaser: leg } : null;
  }).filter(Boolean);

  // STAKE ON THE TICKET'S ACTUAL WIN PROBABILITY, NOT THE SQUARED LEG RATE.
  //
  // `hist.win_rate` is a rate CONDITIONAL ON THE LEG BEING DECIDED, so squaring
  // it answers "both legs win given neither pushed" — not "this ticket wins".
  // The real probability is `ev.probabilities.win`, which is computed two lines
  // above and was being ignored.
  //
  // Measured: 0.548488 against a true 0.538660, overstated by 0.98pp. Through
  // quarter-Kelly at -110 on a 100u bankroll that is **1.30u where the correct
  // figure stakes 0.78u — 67% over**. At -118 and -120 it stakes 0.39u and
  // 0.17u where the correct probability refuses the bet outright.
  //
  // This line predates the commit that split the push out of `win_rate`; that
  // commit corrected the EV and left the staking input on the superseded
  // number. Correcting EV and leaving the stake behind is the more dangerous
  // half to miss, because EV is read by a person and the stake is not.
  const staking = priceOk && ev.ev_per_bet > 0
    ? stakeFor({ winProbability: ev.probabilities.win, americanPrice,
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
