/**
 * Stake sizing by confidence.
 *
 * The thing to be clear about first: sizing does not create edge. If a bet has
 * negative expected value, betting more of it loses money faster, and no
 * staking scheme fixes that. Kelly is a growth-rate optimiser for edges that
 * already exist, not a way to manufacture one.
 *
 * What sizing does do, when confidence is *calibrated*, is allocate more of the
 * bankroll to the bets that are actually better. So the honest order of
 * operations is: measure whether confidence predicts outcome (calibration.js
 * territory — see replay analysis), and only then size by it.
 *
 * Kelly here is fractional by default. Full Kelly is the growth-optimal bet
 * only if the win probability is exactly right, and ours is an estimate with
 * real error — half Kelly gives up about a quarter of the growth for far less
 * volatility, and quarter Kelly is what most people should actually use.
 */

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

export const americanToDecimal = o => (o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o));
export const americanToProb = o => (o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100));

/**
 * Kelly fraction for a single bet.
 * f* = (bp - q) / b, where b is decimal odds minus 1.
 * Returns 0 when the bet has no edge — Kelly's own answer to a bad bet is to
 * not make it, which is worth preserving rather than flooring at some minimum.
 */
export function kellyFraction(winProb, americanOdds) {
  if (winProb == null || americanOdds == null) return 0;
  const b = americanToDecimal(americanOdds) - 1;
  if (b <= 0) return 0;
  const q = 1 - winProb;
  const f = (b * winProb - q) / b;
  return f > 0 ? f : 0;
}

/**
 * Converts a model probability and price into a recommended stake.
 *
 * `multiplier` is the Kelly fraction actually used — 0.25 by default because a
 * probability estimate carrying a few points of error can make full Kelly
 * wildly oversized, and the downside of overbetting is far worse than the
 * upside of underbetting.
 */
export function stakeFor({ winProb, americanOdds, bankroll = 100, multiplier = 0.25, maxUnitFraction = 0.05 }) {
  const full = kellyFraction(winProb, americanOdds);
  const frac = Math.min(full * multiplier, maxUnitFraction);
  const marketProb = americanToProb(americanOdds);
  const edge = winProb == null ? null : winProb - marketProb;
  return {
    model_probability: r3(winProb),
    market_probability: r3(marketProb),
    edge: r3(edge),
    full_kelly: r3(full),
    kelly_multiplier: multiplier,
    stake_fraction: r3(frac),
    stake: r3(frac * bankroll),
    units: r3(frac / 0.01),           // in 1%-of-bankroll units
    expected_value: winProb == null ? null
      : r3(winProb * (americanToDecimal(americanOdds) - 1) - (1 - winProb)),
    recommendation: full <= 0
      ? 'no bet — the price is worse than the model probability'
      : frac >= maxUnitFraction ? 'capped at the maximum single-bet fraction' : 'sized by fractional Kelly'
  };
}

/**
 * Production-safe wrapper. A larger stake is never unlocked by an AI label or
 * point edge alone: calibration, forward sample, uncertainty and portfolio
 * exposure must all be known first.
 */
export function safeStakeFor({ winProb, americanOdds, bankroll = 100, calibrationPassed = false,
  forwardSettled = 0, uncertaintyWidth = null, openPortfolioFraction = 0,
  multiplier = 0.25, maxSingleFraction = 0.025, maxPortfolioFraction = 0.08 }) {
  const blockers = [];
  if (!Number.isFinite(winProb) || winProb <= 0 || winProb >= 1) blockers.push('model probability is invalid');
  if (!Number.isFinite(americanOdds) || americanOdds === 0) blockers.push('market price is invalid');
  if (!calibrationPassed) blockers.push('cover calibration has not beaten the market out of sample');
  if (!Number.isFinite(forwardSettled) || forwardSettled < 250) blockers.push(`forward sample is ${Number.isFinite(forwardSettled) ? forwardSettled : 0}/250`);
  if (!Number.isFinite(uncertaintyWidth)) blockers.push('predictive interval width is unavailable');
  else if (uncertaintyWidth > 24) blockers.push(`80% margin interval is too wide (${uncertaintyWidth} points)`);
  if (!Number.isFinite(openPortfolioFraction) || openPortfolioFraction < 0) blockers.push('weekly portfolio exposure is invalid');
  else if (openPortfolioFraction >= maxPortfolioFraction) blockers.push('weekly portfolio exposure cap is already reached');
  if (blockers.length) return {
    units: 0, stake: 0, stake_fraction: 0, execution_eligible: false, blockers,
    recommendation: 'shadow only — stake sizing cannot create an edge'
  };
  const remaining = Math.max(0, maxPortfolioFraction - openPortfolioFraction);
  const sized = stakeFor({ winProb, americanOdds, bankroll, multiplier,
    maxUnitFraction: Math.min(maxSingleFraction, remaining) });
  return { ...sized, execution_eligible: sized.stake_fraction > 0, blockers: [],
    portfolio_fraction_after: r3(openPortfolioFraction + sized.stake_fraction),
    safeguards: { max_single_fraction: maxSingleFraction, max_portfolio_fraction: maxPortfolioFraction,
      minimum_forward_settled: 250, maximum_margin_interval_80: 24 } };
}

/**
 * Confidence tiers — and a warning attached to them.
 *
 * The obvious design is "bet more when the models agree", and that is what this
 * originally did. Measuring it on 1,880 replayed bets showed the opposite:
 *
 *   models disagree 0-3 pts   834 bets   47.7%   z = -2.70
 *   models disagree 3-4 pts   412 bets   51.5%
 *   models disagree 4-5 pts   276 bets   52.2%
 *   models disagree 5-6 pts   164 bets   47.0%
 *
 * The bucket where the component models agree most tightly is the *worst* performer.
 * That makes sense in hindsight: when every model agrees, they are all reading
 * the same obvious signal — which the market has also read and already priced.
 * The edge such a bet appears to have is usually the model being wrong in a
 * correlated way, not the market being wrong.
 *
 * So tight agreement is not upgraded here. The middle band gets the larger
 * stake because that is what the data supports, and the whole thing stays
 * conservative because none of these buckets clears break-even with a sample
 * worth trusting.
 */
export const TIERS = [
  {
    id: 'medium-agreement', label: 'Mid-band', units: 1.5,
    // 3-5 points of disagreement was the only band above water. Even so it is
    // 52.2% on 276 bets, which is not significantly better than break-even.
    test: c => c.disagreement != null && c.disagreement >= 3 && c.disagreement < 5 && Math.abs(c.edge) >= 1.5
  },
  {
    id: 'standard', label: 'Standard', units: 1,
    test: c => c.disagreement != null && c.disagreement < 6
  },
  { id: 'reduced', label: 'Reduced', units: 0.5, test: () => true }
];

export function tierFor(context) {
  return TIERS.find(t => t.test(context)) ?? TIERS[TIERS.length - 1];
}

/**
 * Applies tiered sizing across a set of graded bets and compares it to flat
 * staking.
 *
 * The comparison is the point. If tiered sizing does not beat flat on the same
 * bets, the confidence signal is not carrying information and the extra
 * complexity is buying nothing — which is a result worth seeing plainly.
 */
export function evaluateSizing(bets) {
  const flat = bets.reduce((s, b) => s + b.units, 0);
  let tiered = 0;
  const byTier = {};
  for (const b of bets) {
    const t = tierFor({ disagreement: b.disagreement, edge: b.edge });
    const staked = b.units * t.units;
    tiered += staked;
    const e = byTier[t.id] ?? { tier: t.label, units_per_bet: t.units, bets: 0, wins: 0, losses: 0, units: 0 };
    e.bets++;
    if (b.result === 'Won') e.wins++;
    if (b.result === 'Lost') e.losses++;
    e.units += staked;
    byTier[t.id] = e;
  }
  for (const e of Object.values(byTier)) {
    const settled = e.wins + e.losses;
    e.win_rate = settled ? r3(e.wins / settled) : null;
    e.roi = e.bets ? r3(e.units / (e.bets * e.units_per_bet)) : null;
  }
  return {
    flat_units: r3(flat),
    tiered_units: r3(tiered),
    // Total risked differs between schemes, so ROI is the only fair comparison.
    flat_roi: bets.length ? r3(flat / bets.length) : null,
    tiered_roi: r3(tiered / bets.reduce((s, b) => s + tierFor({ disagreement: b.disagreement, edge: b.edge }).units, 0)),
    by_tier: byTier,
    verdict: tiered > flat
      ? 'Tiered sizing beat flat on these bets — the confidence signal carried information.'
      : 'Tiered sizing did not beat flat. The confidence signal is not separating winners from losers here, so the added complexity is not earning anything.'
  };
}
