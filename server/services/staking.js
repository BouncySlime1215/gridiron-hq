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
 *
 * ---------------------------------------------------------------------------
 * PORTFOLIO-LEVEL RISK (slateRiskCheck / the openBets path on safeStakeFor)
 *
 * Everything above sizes ONE bet. The gap: `safeStakeFor`'s portfolio cap has
 * always been a flat sum of independent Kelly fractions, capped at
 * `maxPortfolioFraction`. That is exactly what a real quant desk would call
 * wrong — Busseti, Ryu & Boyd, "Risk-Constrained Kelly Gambling" (Stanford,
 * arXiv:1603.06183), size a whole bet vector against the full outcome-
 * covariance matrix with a convex objective plus an explicit drawdown-
 * probability constraint, not by summing scalars as if every bet's outcome
 * were independent of every other. Whelan (2025), "On optimal betting
 * strategies with multiple mutually exclusive outcomes" (Bulletin of Economic
 * Research), shows the correlation-aware optimum can even prescribe a
 * deliberately negative-EV bet on one leg purely to hedge another — but ONLY
 * when there is real edge somewhere in the slate. Against a no-edge, vig-only
 * market (which is this app's entire registry today — see model-governance.js
 * and the cover/total calibration gates), that kind of "hedge" only pays more
 * vig for no benefit, so nothing here is allowed to manufacture a stake out of
 * a correlation calculation alone.
 *
 * What is implemented is a documented simplification of Busseti/Ryu/Boyd, not
 * a different idea:
 *   - the bet-outcome correlation matrix is estimated with the same rule-based,
 *     shared-factor logic as correlation.js's archetypes (same game, division
 *     rivalry, shared weather, shared officiating crew) rather than a fitted
 *     per-pair number, because a game-level "archetype" table like
 *     correlation.js's does not exist yet for spread/total bets;
 *   - the aggregate risk measure is the closed-form quadratic form
 *     sqrt(wᵀCw) (portfolio variance under a correlation matrix), not a
 *     solved convex/QP with a chance constraint, because these slates are
 *     small (~10-16 games) and every input is a model probability with real
 *     error of its own — solving a QP precisely against noisy marginals would
 *     be false precision, and a deterministic closed form is exactly as easy
 *     to test and reason about;
 *   - a genuine Busseti/Ryu/Boyd-style drawdown-probability constraint IS
 *     estimated, by Monte Carlo rather than solved in closed form: the same
 *     Gaussian-copula machinery correlation.js and nfl-prop-correlation.js
 *     already use for fantasy lineups and same-game parlays is reused here to
 *     simulate the correlated win/loss vector for the slate and read off how
 *     often it would lose more than half of what was staked in one week.
 *
 * One thing worth being precise about, because it looks at first like it could
 * go the other way: sqrt(wᵀCw) is PROVABLY never larger than the naive flat
 * sum Σw for any valid correlation matrix — every off-diagonal entry is ≤ 1,
 * so wᵀCw ≤ wᵀ𝟙𝟙ᵀw = (Σw)². The flat sum the app uses today is therefore
 * already the maximally-conservative case (mathematically equivalent to
 * assuming every bet is perfectly correlated with every other). What
 * correlation-awareness actually buys is not a bigger number for correlated
 * slates — it is a SMALLER number for genuinely independent ones, and a
 * number that correctly sits BETWEEN the two for partially-correlated ones,
 * so that a correlated slate and an independent slate staking the identical
 * flat total are no longer scored identically (which is the actual bug: today
 * they are indistinguishable). That is exactly the comparison the regression
 * test in test/slate-risk-staking.test.js makes: same total stake, correlated
 * slate reads riskier than independent slate.
 *
 * This is only used as a replacement for the flat scalar when the caller
 * opts in by passing `openBets` with correlation context; the legacy
 * `openPortfolioFraction` scalar path is completely untouched, so every
 * existing caller keeps today's behavior byte-for-byte. And because the
 * single-bet blockers (calibration, forward sample, uncertainty) are still
 * evaluated first and unconditionally, and slateRiskCheck only ever looks at
 * bets that already have a positive stake_fraction, none of this can turn a
 * zero-edge stake into a nonzero one — see the "no-edge floor" regression
 * test in test/slate-risk-staking.test.js.
 */

import { cholesky, correlatedNormals, probit, withRandomSeed } from './stats-util.js';

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
 * Rule-based correlation between two bets' OUTCOMES, for portfolio risk
 * purposes only — this says nothing about whether either bet has edge.
 *
 * Each bet descriptor is whatever the caller already has on hand:
 *   { team, opponent, division_rivalry, weather_bucket, officiating_crew, ... }
 * All fields are optional; missing context just means that factor contributes
 * nothing, never a crash and never a fabricated correlation.
 *
 * The weights are deliberately small and are NOT fitted from data the way
 * correlation.js's archetypes are — there is no equivalent archetype table yet
 * for game-level spread/total bets. Where this codebase HAS actually measured
 * one of these factors, that measurement sets the weight instead of folklore:
 * nfl-officials.js's own refereeTotals() found no crew clears the multiple-
 * comparisons-corrected significance threshold for moving a total, so the
 * shared-crew weight here is a token amount, not the effect size sometimes
 * claimed for "high-penalty" or "high-total" referees.
 */
export function estimateBetCorrelation(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Two different bets settling off the literal same game (e.g. the spread and
  // the total on one matchup) are close to mechanically linked, the same way a
  // receiver's receptions and receiving-yards props are within one game — see
  // samePlayerCorrelation in nfl-prop-correlation.js for the same idea applied
  // to one player's two stats instead of one game's two markets.
  if (a.team && b.team && a.opponent && b.opponent &&
      ((a.team === b.team && a.opponent === b.opponent) || (a.team === b.opponent && a.opponent === b.team))) {
    return 0.80;
  }
  let rho = 0;
  // Two SEPARATE divisional games in the same week: rivalry familiarity and the
  // public-money/script pressure that comes with it is a soft structural prior,
  // not a fitted archetype — kept small on purpose.
  if (a.division_rivalry && b.division_rivalry) rho = Math.max(rho, 0.08);
  // A shared adverse-weather system (not a dome, not "neutral") nudges both
  // games' scripts the same direction — more rushing, more clock-eating drives.
  if (a.weather_bucket && b.weather_bucket && a.weather_bucket === b.weather_bucket
      && !['dome', 'neutral'].includes(a.weather_bucket)) {
    rho = Math.max(rho, 0.15);
  }
  // Shared officiating crew — see the note above: this app's own audit found no
  // significant crew effect, so the weight stays token-sized.
  if (a.officiating_crew && b.officiating_crew && a.officiating_crew === b.officiating_crew) {
    rho = Math.max(rho, 0.03);
  }
  return rho;
}

function slateCorrelationMatrix(bets) {
  const n = bets.length;
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    m[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const rho = estimateBetCorrelation(bets[i], bets[j]);
      m[i][j] = rho; m[j][i] = rho;
    }
  }
  return m;
}

const quadraticForm = (w, m) => {
  let total = 0;
  for (let i = 0; i < w.length; i++) for (let j = 0; j < w.length; j++) total += w[i] * w[j] * m[i][j];
  return Math.max(0, total);
};

/**
 * Correlation-aware portfolio risk for a set of already-sized bets (a week's
 * slate). See the file header for the full method note, including the proof
 * that `correlated_risk_fraction` can never exceed `flat_fraction` — the flat
 * sum is the maximally-conservative (perfectly-correlated) case, and this
 * measure's job is to correctly come in BELOW it for a genuinely independent
 * slate while staying close to it for a genuinely correlated one, so two
 * slates staking the identical flat total are no longer scored identically.
 * Returns:
 *   - flat_fraction: the naive sum this app used before (Σw);
 *   - correlated_risk_fraction: sqrt(wᵀCw), which grows toward flat_fraction
 *     as bets share more game/division/weather/crew factors, and shrinks
 *     toward it for a genuinely diversified slate;
 *   - effective_open_fraction: alias of correlated_risk_fraction — the number
 *     safeStakeFor's `openBets` path checks against the portfolio cap;
 *   - drawdown_probability: a Monte Carlo estimate (Busseti/Ryu/Boyd's chance
 *     constraint, evaluated by simulation rather than solved in closed form)
 *     of the odds the whole slate loses more than half of what was staked, in
 *     one week — only computed when every bet carries a model_probability.
 *
 * Only bets with a positive stake_fraction participate — a bet already sized
 * to zero by its own gates contributes nothing to the aggregate, by
 * construction, so this can never manufacture risk (or stake) out of bets
 * that were never going to be placed.
 */
export function slateRiskCheck(bets, { drawdownFraction = 0.5, trials = 8000, seed = 733 } = {}) {
  const staked = (bets ?? []).filter(b => Number.isFinite(b?.stake_fraction) && b.stake_fraction > 0);
  const flatFraction = staked.reduce((s, b) => s + b.stake_fraction, 0);
  if (staked.length < 2) {
    return { bets: bets?.length ?? 0, staked_bets: staked.length,
      flat_fraction: r3(flatFraction) ?? 0, correlated_risk_fraction: r3(flatFraction) ?? 0,
      effective_open_fraction: r3(flatFraction) ?? 0, risk_amplification: 1, drawdown_probability: null,
      note: 'fewer than two staked bets — correlation has nothing to act on' };
  }
  const weights = staked.map(b => b.stake_fraction);
  const matrix = slateCorrelationMatrix(staked);
  const correlatedRiskFraction = Math.sqrt(quadraticForm(weights, matrix));

  let drawdownProbability = null;
  if (staked.every(b => Number.isFinite(b.model_probability) && b.model_probability > 0 && b.model_probability < 1)) {
    const L = cholesky(matrix);
    const thresholds = staked.map(b => probit(1 - b.model_probability)); // z <= threshold => that bet loses
    let hits = 0;
    withRandomSeed(seed, () => {
      for (let t = 0; t < trials; t++) {
        const z = correlatedNormals(L);
        let lost = 0;
        for (let i = 0; i < staked.length; i++) if (z[i] <= thresholds[i]) lost += weights[i];
        if (lost > drawdownFraction * flatFraction) hits++;
      }
    });
    drawdownProbability = r3(hits / trials);
  }

  return {
    bets: bets?.length ?? 0, staked_bets: staked.length,
    flat_fraction: r3(flatFraction),
    correlated_risk_fraction: r3(correlatedRiskFraction),
    effective_open_fraction: r3(correlatedRiskFraction),
    risk_amplification: flatFraction > 0 ? r3(correlatedRiskFraction / flatFraction) : 1,
    drawdown_probability: drawdownProbability,
    drawdown_threshold_fraction: drawdownFraction,
    method: 'closed-form correlation quadratic form sqrt(wᵀCw) — provably ≤ the naive flat sum for any ' +
      'valid correlation matrix, and strictly less than it whenever the slate is not perfectly ' +
      'correlated, which is what lets it tell a correlated slate apart from an independent one at the ' +
      'same total stake. Drawdown probability is a Monte Carlo chance-constraint estimate using the ' +
      'same copula machinery as correlation.js / nfl-prop-correlation.js.'
  };
}

/**
 * Production-safe wrapper. A larger stake is never unlocked by an AI label or
 * point edge alone: calibration, forward sample, uncertainty and portfolio
 * exposure must all be known first.
 *
 * `openBets` is the optional, correlation-aware alternative to the flat
 * `openPortfolioFraction` scalar: pass the week's other already-sized bets
 * (each with a stake_fraction and whatever of {team, opponent,
 * division_rivalry, weather_bucket, officiating_crew, model_probability} is
 * known) and the exposure checked against the cap becomes
 * slateRiskCheck(openBets).effective_open_fraction instead of a flat sum —
 * correctly smaller for a diversified slate, correctly closer to the flat sum
 * for a genuinely correlated one. Omit it (or pass an empty array) and
 * behavior is byte-for-byte what it was before, off the `openPortfolioFraction`
 * scalar alone.
 */
export function safeStakeFor({ winProb, americanOdds, bankroll = 100, calibrationPassed = false,
  forwardSettled = 0, uncertaintyWidth = null, openPortfolioFraction = 0, openBets = null,
  multiplier = 0.25, maxSingleFraction = 0.025, maxPortfolioFraction = 0.08 }) {
  const blockers = [];
  if (!Number.isFinite(winProb) || winProb <= 0 || winProb >= 1) blockers.push('model probability is invalid');
  if (!Number.isFinite(americanOdds) || americanOdds === 0) blockers.push('market price is invalid');
  if (!calibrationPassed) blockers.push('cover calibration has not beaten the market out of sample');
  if (!Number.isFinite(forwardSettled) || forwardSettled < 250) blockers.push(`forward sample is ${Number.isFinite(forwardSettled) ? forwardSettled : 0}/250`);
  if (!Number.isFinite(uncertaintyWidth)) blockers.push('predictive interval width is unavailable');
  else if (uncertaintyWidth > 24) blockers.push(`80% margin interval is too wide (${uncertaintyWidth} points)`);

  // Correlation-aware aggregate exposure is only ever computed once the single-
  // bet blockers above are already known — nothing past this point can rescue a
  // bet that failed calibration, sample size or uncertainty, and nothing past
  // this point can raise a zero stake to a nonzero one.
  let slateRisk = null;
  let effectivePortfolioFraction = openPortfolioFraction;
  if (Array.isArray(openBets) && openBets.length) {
    slateRisk = slateRiskCheck(openBets);
    effectivePortfolioFraction = slateRisk.effective_open_fraction ?? 0;
  }
  if (!Number.isFinite(effectivePortfolioFraction) || effectivePortfolioFraction < 0) blockers.push('weekly portfolio exposure is invalid');
  else if (effectivePortfolioFraction >= maxPortfolioFraction) {
    blockers.push(`weekly portfolio exposure cap is already reached${slateRisk ? ' (correlation-adjusted)' : ''}`);
  }
  if (blockers.length) return {
    units: 0, stake: 0, stake_fraction: 0, execution_eligible: false, blockers,
    recommendation: 'shadow only — stake sizing cannot create an edge', slate_risk: slateRisk
  };
  const remaining = Math.max(0, maxPortfolioFraction - effectivePortfolioFraction);
  const sized = stakeFor({ winProb, americanOdds, bankroll, multiplier,
    maxUnitFraction: Math.min(maxSingleFraction, remaining) });
  return { ...sized, execution_eligible: sized.stake_fraction > 0, blockers: [],
    portfolio_fraction_after: r3(effectivePortfolioFraction + sized.stake_fraction),
    slate_risk: slateRisk,
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
