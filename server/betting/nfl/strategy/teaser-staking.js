/**
 * How much to stake on a Wong teaser ticket, and — more usefully — when not to.
 *
 * The strategy this sizes is measured in `teaser-leg-rates.js`: a two-team
 * six-point teaser built from the eight lines that cross both 3 and 7, pooled
 * decided leg rate 74.0586% on 2,868 decided legs (2,894 with pushes), priced
 * by the owner's DraftKings account at +100 with a push reducing the ticket to
 * a single. Break-even sits near -120.2, so the live margin is roughly three
 * points of leg rate. Volume is 15-33 tickets a season.
 *
 * Two staking rules are in the codebase today and both are wrong in the same
 * direction:
 *
 *   flat 1 unit          insensitive to price. Bets the same at +100, where
 *                        the edge is real, as at -118, where it is a rounding
 *                        error, as at -125, where it is negative.
 *   stakeFor's Kelly     quarter-Kelly on a POINT ESTIMATE of a two-outcome
 *                        bet. This bet has three outcomes, and the probability
 *                        is not a point.
 *
 * ---------------------------------------------------------------------------
 * 1. EXACT KELLY FOR THIS BET
 *
 * The textbook f* = (b·p - q)/b is derived for a bet that either wins b or
 * loses everything. A two-leg teaser at DraftKings has four outcomes, which
 * collapse to three distinct payoffs. Writing b for the profit multiple, r for
 * whatever the reduced (one-leg-pushed) branch pays, and taking the outcome
 * probabilities from the same construction `ticketProbabilities` uses:
 *
 *     outcome     profit per unit     probability
 *     win         +b                  W = w1·w2
 *     reduced     +r                  R = w1·t2 + t1·w2
 *     both push    0                  P = t1·t2
 *     loss        -1                  L = 1 - (w1+t1)(w2+t2)
 *
 * Expected log wealth from staking fraction f of the bankroll:
 *
 *     g(f) = W·ln(1+f·b) + R·ln(1+f·r) + P·ln(1) + L·ln(1-f)
 *
 *     g'(f)  = W·b/(1+f·b) + R·r/(1+f·r) - L/(1-f)
 *     g''(f) = -W·b²/(1+f·b)² - R·r²/(1+f·r)² - L/(1-f)²   < 0
 *
 * g is strictly concave on the feasible interval (every branch keeps wealth
 * positive), so there is exactly one maximum and g'(0) = W·b + R·r - L = EV
 * decides whether it is to the right of zero. The stake therefore goes to zero
 * exactly at break-even and turns negative below it — the refusal is a
 * property of the objective, not a rule bolted on afterwards.
 *
 * For the DEFAULT grading (`stake_back`, r = 0) the reduced branch drops out
 * of g entirely, because ln(1+f·0) = ln(1) = 0, and the first-order condition
 * solves in closed form:
 *
 *     W·b/(1+f·b) = L/(1-f)
 *     W·b·(1-f)   = L·(1+f·b)
 *     W·b - L     = f·b·(W + L)
 *     f*          = (b·W - L) / (b·(W + L))
 *
 * Divide top and bottom by (W+L) and set p = W/(W+L), q = L/(W+L):
 *
 *     f* = (b·p - q)/b
 *
 * which is the textbook formula applied to the probabilities CONDITIONAL ON
 * THE TICKET BEING DECIDED. That is the first result worth writing down: a
 * push branch that returns the stake does not change the optimal fraction at
 * all. It scales the growth rate by (W+L) and leaves the stake alone. Anyone
 * who "adjusts Kelly down for push risk" on a stake-back push is adjusting for
 * something that is not there.
 *
 * The other two gradings collapse the same way — `same_price` merges R into W,
 * `graded_loss` merges R into L — so all three of this codebase's gradings have
 * a closed form. `closedFormKelly` computes it and `kellyForOutcomes` solves
 * g'(f) = 0 numerically without assuming any of that, because the moment the
 * book prices a surviving single at something other than the teaser price
 * (r ∉ {0, b, -1}) the closed form stops applying and the numeric solver does
 * not. The two agree to 1e-12 wherever both are defined, which is the check
 * that the derivation above is not merely plausible.
 *
 * When P = R = 0 the conditioning is vacuous, W + L = 1, and f* = (b·p - q)/b
 * exactly. `test/teaser-staking.test.js` pins that identity.
 *
 * ---------------------------------------------------------------------------
 * 2. PARAMETER UNCERTAINTY — AND A RESULT THE BRIEF DID NOT EXPECT
 *
 * The leg rate is not 74.06%. It is 74.06% ± 2.3pp forward (`forwardRatePrior`
 * widens the 0.81pp sampling error to carry 26 seasons of market drift), and
 * that interval straddles break-even at -120. So the obvious move is to
 * maximise expected log wealth INTEGRATING over the posterior rather than at
 * its mean, and expect a smaller number.
 *
 * It is smaller only if you do it with a criterion that can produce a smaller
 * number, and expected log wealth is not one of them. The reason is one line
 * of algebra: g(f) is LINEAR in the outcome probabilities, so
 *
 *     E_ρ[ g(f; ρ) ] = E[W]·ln(1+f·b) + E[R]·ln(1+f·r) + E[L]·ln(1-f)
 *
 * Integrating over the posterior is therefore identical to plugging the
 * POSTERIOR-PREDICTIVE probabilities into the same solver. For an ordinary
 * two-outcome bet, where W = ρ is affine in the parameter, E[W] = E[ρ] and the
 * answer is exactly Kelly at the posterior mean: uncertainty changes nothing.
 * That is a theorem, not an artefact of this bet.
 *
 * For THIS bet it changes something, and in the wrong direction. A two-leg
 * ticket wins with probability ρ²·(1-t1)(1-t2), and ρ² is convex, so
 *
 *     E[ρ²] = E[ρ]² + Var[ρ] > E[ρ]²
 *
 * Rate uncertainty is a shared factor across both legs — it induces POSITIVE
 * dependence between them — and a parlay likes positive dependence. At the
 * measured posterior the predictive ticket-win probability is about 0.05pp
 * HIGHER than at the mean, and `predictiveKelly` comes out about 1% LARGER
 * than `pointEstimateKelly`. The honest headline for item 2 of the brief is
 * therefore: the expected-log-wealth gap is +1%, not -anything, and any
 * staking module that claims to have shrunk Kelly "because of uncertainty"
 * while maximising expected log wealth has made an arithmetic mistake.
 *
 * The reason to bet less is real, but it lives in a different objective.
 * Expected log wealth is the right criterion for a bettor who will place
 * enough bets for the law of large numbers to arrive. This strategy places
 * 15-33 a season. Over one season you do not experience the average of the
 * worlds the posterior describes; you experience ONE of them, drawn once and
 * then held fixed for every ticket you place. In roughly 8.5% of those worlds
 * (at +100) the bet is negative-EV outright and no fraction is safe.
 *
 * So `robustKelly` maximises a LOWER QUANTILE of the per-bet growth rate
 * rather than its mean:
 *
 *     maximise over f:   Q_q{ g(f; ρ) }   with ρ ~ posterior
 *
 * and this has a clean simplification. g(f; ρ) is strictly increasing in ρ for
 * any f > 0 (raising the leg rate moves mass from the -1 branch to the +b
 * branch, and ln(1+f·b) > 0 > ln(1-f)). A monotone transform commutes with
 * quantiles, so
 *
 *     Q_q{ g(f; ρ) } = g(f; Q_q{ρ})
 *
 * The uncertainty-aware fraction is exactly point-estimate Kelly evaluated at
 * the q-th percentile of the posterior. "Bet as if the 25th-percentile world
 * were true" is not a heuristic here; it is the exact solution to a one-sided
 * robust-Bayes criterion, and it is strictly smaller than Kelly at the mean
 * for every non-degenerate posterior because Q_q{ρ} < E[ρ] for q < 0.5.
 *
 * At the measured posterior and +100 that is a 50% cut: 9.18% of bankroll at
 * the mean, 4.63% at the 25th percentile. THAT is the gap this module exists
 * to produce, and it comes from the quantile criterion, not from the integral.
 *
 * ---------------------------------------------------------------------------
 * 3. THE FRACTION MULTIPLIER
 *
 * Default 0.25, applied on top of the robust fraction, for reasons specific to
 * this bet rather than by convention:
 *
 *   - The posterior is not the whole uncertainty. The 74.06% was chosen as the
 *     cross-both family after looking at the data; the push grading is
 *     UNVERIFIED and the conservative choice already gives away the reduced
 *     bucket; the -0.044 leg correlation is measured on overlapping pairs. None
 *     of that is in a Beta.
 *   - The price is fragile. Three points of leg rate is the entire edge, and
 *     the difference between +100 and -115 consumes about half of it. A bet
 *     whose edge can be erased by the book moving one price deserves less than
 *     its growth-optimal share.
 *   - Roughly a quarter to a third of seasons finish red even when the edge is
 *     real (`seasonDrawdown` measures this rather than quoting it). A staking
 *     plan that only looks sane in the median season is not a plan.
 *   - Full Kelly carries a 50% chance of halving the bankroll at some point;
 *     quarter-Kelly's chance of ever reaching a fraction a of the bankroll is
 *     a^(2/f - 1) = a^7, and keeps f(2-f) = 44% of maximum growth. That trade
 *     is the standard one and it is the right one here.
 *
 * Compounded with the 0.25 quantile that is an effective ~0.125 of
 * point-estimate Kelly. That sounds timid until you notice what it produces:
 * about 1.16 units on a 100-unit bankroll at +100 — which is to say, almost
 * exactly the flat 1 unit the strategy already bets. See the closing note.
 *
 * ---------------------------------------------------------------------------
 * 4. SIMULTANEOUS TICKETS
 *
 * Two to four tickets settle on the same weekend, so the bankroll cannot be
 * re-measured between them and the single-bet fraction cannot simply be applied
 * n times. `portfolioKelly` solves the actual problem — maximise
 * E[ln(1 + f·(X1 + ... + Xn))] over the JOINT distribution — and it solves it
 * exactly, by enumeration rather than simulation.
 *
 * It is exact because it can be. Two-leg tickets over at most four tickets is
 * at most eight legs and 3^8 = 6,561 patterns, which is a loop, not a Monte
 * Carlo. `weekendPayoffDistribution` writes the joint law down; the
 * approximations are in the MODEL, not in the arithmetic, and they are two:
 * pushes are independent of everything (they are a property of the posted line,
 * not of the game), and the decided legs follow a second-order Bahadur
 * expansion, which matches every marginal and every pairwise correlation
 * exactly and sets the higher joint cumulants to zero. At one ticket that
 * expansion collapses to P(both win) = p² + rho·p·q, which is not an
 * approximation but the measured quantity itself.
 *
 * The first version of this used a Gaussian copula and Monte Carlo. Both parts
 * were mistakes and the header of `weekendPayoffDistribution` records why: the
 * sampling noise moved the answer by a third between seeds, and the copula
 * silently shrank the measured -0.044 binary correlation to about -0.025 on
 * the way through the tetrachoric map.
 *
 * Two effects pull opposite ways. Simultaneity lowers the per-ticket fraction
 * (the tickets compete for one bankroll) and negative correlation raises it
 * (they hedge each other). Both are small. The larger correlation effect is the
 * one INSIDE a ticket: rho = -0.044 between its two legs costs about 0.85pp of
 * win probability, which the scanner's independence-assuming EV does not
 * charge for, and that is worth more than everything the portfolio solve finds.
 *
 * 5. WHAT THIS MODULE IS ACTUALLY FOR
 *
 * `recommendStake` reports `probability_negative_ev` next to the stake, and on
 * a bet this thin that number is the output that matters. It is the posterior
 * mass below the leg rate at which EV is zero at the quoted price:
 *
 *     +100   8.5%       -110   25.6%
 *     -115   37.2%      -120   49.6%
 *
 * The scanner's existing gate is the break-even price, -120.2, which lets -115
 * through. At -115 the posterior says it is a 37% chance there is no edge at
 * all. `maxNegativeEvProbability` (default 0.20) refuses everything from -110
 * down, and that is a materially tighter and better-justified gate than the
 * one it sits behind.
 *
 * This module imports `profitMultiple` from the price contract and NOTHING
 * else. No database, no measurement, no posterior construction — the posterior
 * arrives as an argument so that the staking logic can be tested and argued
 * with on its own. `test/teaser-staking.test.js` cross-checks the outcome
 * probabilities and the three push gradings against `teaser-leg-rates.js` so
 * that the local re-derivation cannot silently fork from the canonical one.
 *
 * ---------------------------------------------------------------------------
 * CLOSING NOTE, AND THE HONEST ANSWER TO "IS THIS WORTH IT"
 *
 * At the recorded price the machinery recommends 1.16 units where the flat
 * plan bets 1.00. Over 15-33 tickets a season that difference is invisible:
 * `seasonDrawdown` puts the two plans' terminal-wealth and max-drawdown
 * distributions within a couple of percentage points of each other. For SIZING
 * AT +100, flat 1 unit is close enough and this file is not worth running.
 *
 * What is worth running is everything else in it. Flat staking has no opinion
 * about price, and the stake it should produce falls by half between +100 and
 * -115 and to nothing by -120. It has no opinion about the 8.5%-to-50% chance
 * that the edge is not there. And it has no opinion about four tickets landing
 * on one weekend. Those are the decisions that can lose the bankroll; the
 * stake number is not.
 */
import { profitMultiple } from '../contracts/spread-probabilities.js';

export const TEASER_STAKING_VERSION = 'nfl-teaser-staking-v1';

/**
 * The measured family, quoted for defaults and reporting only. Nothing here
 * is re-measured — `teaser-leg-rates.js` owns the measurement and these are
 * the numbers it reports, restated so this module can run without a database.
 */
export const MEASURED = Object.freeze({
  decidedLegRate: 0.7405857740585774,   // 2,124 / 2,868 decided legs, 1999-2024
  pushShare: 26 / 2894,                 // 0.898% — structural, line-specific
  forwardRateSd: 0.023,                 // FORWARD_RATE_SD in teaser-season.js
  legCorrelation: -0.044,               // same-week, different-game legs
  recordedPrice: 100,                   // DraftKings, owner's account
  ticketsPerSeason: [15, 33]
});

export const DEFAULT_KELLY_FRACTION = 0.25;
export const DEFAULT_CONFIDENCE = 0.25;
export const DEFAULT_REDUCED_PAYOUT = 'stake_back';

/**
 * What the reduced (one-leg-pushed) branch pays, as a profit multiple.
 *
 * Mirrors the REDUCED_PAYOUTS table in `teaser-leg-rates.js`, which is
 * module-private there. `stake_back` is the default for the reason stated in
 * that file: the push-removes-the-leg rule is confirmed on the owner's
 * DraftKings account but what the surviving single settles at is NOT, and
 * pricing the optimistic grading before someone has watched a real ticket
 * settle books a payout the book has not agreed to. The cross-check in
 * `test/teaser-staking.test.js` fails if this table ever disagrees with the
 * break-even prices that module computes.
 */
function reducedProfit(reducedPayout, b) {
  switch (reducedPayout) {
    case 'stake_back': return 0;
    case 'same_price': return b;
    case 'graded_loss': return -1;
    default: throw new TypeError(
      `unknown reducedPayout '${reducedPayout}'; expected one of stake_back, same_price, graded_loss`);
  }
}

/**
 * Profit multiple back to an American price, exactly.
 *
 * `americanFromDecimal` in the price contract rounds to a whole number because
 * it is a display helper. A break-even price of -120.2 rounds to -120, and
 * -120 is a price a book actually offers — so rounding here would turn "this
 * is one fifth of a point below break-even" into "this is break-even".
 */
function exactAmerican(multiple) {
  if (!Number.isFinite(multiple) || multiple <= 0) return null;
  return multiple >= 1 ? 100 * multiple : -100 / multiple;
}

/* ------------------------------------------------------------- numerics -- */

/** Seeded, so a recommendation that moves when nobody changed anything is a bug, not variance. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Lanczos, g = 7. Only ever called with shapes in the hundreds. */
const LANCZOS = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7];

function logGamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  let x = 0.99999999999980993;
  const zz = z - 1;
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (zz + i + 1);
  const t = zz + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Continued fraction for the incomplete beta (modified Lentz). */
function betaContinuedFraction(a, b, x) {
  const MAX_ITERATIONS = 400, EPSILON = 3e-14, TINY = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITERATIONS; m++) {
    const m2 = 2 * m;
    let numerator = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + numerator * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + numerator / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    numerator = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + numerator * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + numerator / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return h;
}

/** P(X <= x) for X ~ Beta(alpha, beta). */
export function betaCdf(x, alpha, beta) {
  if (!(x > 0)) return 0;
  if (!(x < 1)) return 1;
  const front = Math.exp(logGamma(alpha + beta) - logGamma(alpha) - logGamma(beta)
    + alpha * Math.log(x) + beta * Math.log1p(-x));
  return x < (alpha + 1) / (alpha + beta + 2)
    ? front * betaContinuedFraction(alpha, beta, x) / alpha
    : 1 - front * betaContinuedFraction(beta, alpha, 1 - x) / beta;
}

/** Inverted by bisection: 200 halvings of [0,1] is exact to machine precision and costs nothing at this call rate. */
export function betaQuantile(q, alpha, beta) {
  if (!(q > 0)) return 0;
  if (!(q < 1)) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, alpha, beta) < q) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Marsaglia-Tsang. Both shapes here are well above 1, so the a < 1 boost is not needed. */
function gammaSample(shape, rng) {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = standardNormal(rng);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = rng();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

function betaSample(alpha, beta, rng) {
  const x = gammaSample(alpha, rng);
  return x / (x + gammaSample(beta, rng));
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const position = q * (sorted.length - 1);
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

/* -------------------------------------------------------- the ticket ---- */

/**
 * The ticket's outcome vector: every distinct payoff with its probability.
 *
 * The probability construction is the one in `ticketProbabilities` — all-win,
 * all-push and no-loss accumulated multiplicatively, with the reduced bucket
 * derived by subtraction so the four numbers sum to exactly 1 rather than
 * approximately. It is re-derived here instead of imported because
 * `teaser-leg-rates.js` opens the 9.8 GB database at import time and a staking
 * calculator should not need one; the cross-check test pins the two together.
 *
 * INDEPENDENCE within the ticket is assumed here exactly as it is there. The
 * measured rho = -0.044 makes this a mild OVERSTATEMENT of `win` (about 0.85pp
 * on two legs), not a safety margin. `portfolioKelly` models the correlation
 * explicitly; this function does not, so that the single-ticket numbers stay
 * comparable with the ones the scanner already prints.
 */
export function ticketOutcomes({ legs, americanPrice, reducedPayout = DEFAULT_REDUCED_PAYOUT } = {}) {
  if (!Array.isArray(legs) || legs.length < 2) {
    throw new TypeError('ticketOutcomes needs at least two legs — a one-leg teaser is a straight bet');
  }
  let win = 1, bothPush = 1, noLoss = 1;
  for (const leg of legs) {
    const w = leg?.w, t = leg?.t ?? 0;
    if (!Number.isFinite(w) || !Number.isFinite(t) || w < 0 || t < 0 || w + t > 1 + 1e-9) {
      throw new TypeError(`each leg needs { w, t } with w >= 0, t >= 0 and w + t <= 1; got ${JSON.stringify(leg)}`);
    }
    win *= w;
    bothPush *= t;
    noLoss *= w + t;
  }
  const reduced = Math.max(0, noLoss - win - bothPush);
  const loss = 1 - noLoss;

  const b = profitMultiple(americanPrice);
  if (b == null) throw new TypeError(`americanPrice must be a real price at or beyond +/-100, got ${americanPrice}`);
  if (legs.length > 2 && reduced > 0) {
    // A three-leg ticket with one push reduces to a double and with two pushes
    // reduces to a single, and those pay differently. One scalar cannot say
    // which happened. `ticketEV` refuses this case and so does this.
    throw new TypeError('ticketOutcomes models the reduced bucket only for a two-leg ticket; ' +
      `a ${legs.length}-leg ticket with a possible push reduces to several different bets`);
  }
  const r = reducedProfit(reducedPayout, b);

  const outcomes = [
    { name: 'win', profit: b, probability: win },
    { name: 'reduced', profit: r, probability: reduced },
    { name: 'both_push', profit: 0, probability: bothPush },
    { name: 'loss', profit: -1, probability: loss }
  ];
  const ev = outcomes.reduce((sum, o) => sum + o.probability * o.profit, 0);

  return {
    outcomes,
    probabilities: { win, reduced, both_push: bothPush, loss },
    ev,
    profit_multiple: b,
    reduced_profit_multiple: r,
    reduced_payout: reducedPayout,
    reduced_payout_verified: false,
    american_price: americanPrice
  };
}

/* --------------------------------------------------------- exact Kelly -- */

/** Expected log wealth from staking `fraction` on this outcome vector. -Infinity where the bankroll would go non-positive. */
export function growthRate(fraction, outcomes) {
  let g = 0;
  for (const { profit, probability } of outcomes) {
    if (!(probability > 0)) continue;
    const wealth = 1 + fraction * profit;
    if (!(wealth > 0)) return -Infinity;
    g += probability * Math.log(wealth);
  }
  return g;
}

/** dg/df. Strictly decreasing in f, which is what makes the bisection below valid. */
function growthSlope(fraction, outcomes) {
  let slope = 0;
  for (const { profit, probability } of outcomes) {
    if (!(probability > 0)) continue;
    slope += probability * profit / (1 + fraction * profit);
  }
  return slope;
}

/**
 * The closed form, where one exists.
 *
 * Collapses outcomes onto distinct payoffs first, so `same_price` (which
 * merges the reduced branch into the win) and `graded_loss` (which merges it
 * into the loss) both land on the {+b, 0, -1} shape the derivation in the
 * header solves. Returns null when a reduced branch pays something that is
 * none of those three, because then g'(f) = 0 is a genuine quadratic and the
 * numeric solver is the honest answer.
 */
export function closedFormKelly(outcomes) {
  const byProfit = new Map();
  for (const { profit, probability } of outcomes) {
    if (!(probability > 0)) continue;
    byProfit.set(profit, (byProfit.get(profit) ?? 0) + probability);
  }
  const profits = [...byProfit.keys()].sort((a, b) => a - b);
  const positive = profits.filter(p => p > 0);
  const negative = profits.filter(p => p < 0);
  if (positive.length !== 1 || negative.length > 1) return null;
  if (negative.length === 1 && negative[0] !== -1) return null;

  const b = positive[0];
  const W = byProfit.get(b);
  const L = negative.length ? byProfit.get(-1) : 0;
  if (!(L > 0)) return null;                    // no losing branch: Kelly is unbounded
  return (b * W - L) / (b * (W + L));
}

/**
 * Growth-optimal fraction for an arbitrary discrete outcome vector.
 *
 * Solved by bisection on g'(f) = 0 over [0, 1/worstLoss). g' is continuous and
 * strictly decreasing there (g'' < 0 everywhere), g'(0) = EV, and g' -> -Infinity
 * at the upper end, so a sign change is guaranteed whenever EV > 0 and
 * bisection cannot miss it. No closed form is assumed; `closed_form` reports
 * the analytic value alongside where one exists so the two can be compared.
 *
 * `fraction` is the Kelly multiplier applied afterwards — see the header for
 * why 0.25 rather than 1.
 */
export function kellyForOutcomes(outcomes, { fraction = DEFAULT_KELLY_FRACTION } = {}) {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new TypeError(`Kelly fraction multiplier must be in (0, 1], got ${fraction}`);
  }
  const live = outcomes.filter(o => o.probability > 0);
  const ev = live.reduce((sum, o) => sum + o.probability * o.profit, 0);
  const worstLoss = -Math.min(...live.map(o => o.profit));

  if (!(worstLoss > 0)) {
    return {
      full_kelly: 0, stake_fraction: 0, blocked: true, ev,
      reason: 'no losing outcome — Kelly is unbounded, which means this is not a real sports bet'
    };
  }
  if (!(ev > 0)) {
    return {
      full_kelly: 0, stake_fraction: 0, blocked: true, ev,
      fraction_used: fraction,
      reason: ev === 0
        ? 'exactly break-even at this price — the growth-optimal stake is zero'
        : 'negative EV at this price — do not bet'
    };
  }

  const upper = (1 / worstLoss) * (1 - 1e-12);
  let lo = 0, hi = upper;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (growthSlope(mid, live) > 0) lo = mid; else hi = mid;
  }
  const full = (lo + hi) / 2;
  const closed = closedFormKelly(outcomes);

  return {
    full_kelly: full,
    fraction_used: fraction,
    stake_fraction: full * fraction,
    ev,
    growth_rate_full: growthRate(full, live),
    growth_rate_at_stake: growthRate(full * fraction, live),
    closed_form: closed,
    closed_form_agrees: closed == null ? null : Math.abs(closed - full) < 1e-10,
    blocked: false
  };
}

/**
 * The textbook two-outcome formula, kept as a named reference rather than a
 * comment so the test can assert the three-outcome solver reduces to it.
 * This is the same expression `kellyFraction` in nfl-execution-edge.js uses.
 */
export function textbookKelly({ winProbability, americanPrice }) {
  const b = profitMultiple(americanPrice);
  if (b == null) return null;
  const p = Number(winProbability);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return (b * p - (1 - p)) / b;
}

/* ----------------------------------------------------- the posterior ---- */

/**
 * Normalise a posterior argument to { alpha, beta }.
 *
 * Accepts either shape parameters directly or a { mean, sd } pair, which is
 * matched by moments the same way `forwardRatePrior` does it. That function is
 * NOT imported: it lives in a module that opens the database, and taking the
 * posterior as an argument is what lets this file be reasoned about alone. A
 * caller that wants the project's official forward prior passes
 * `forwardRatePrior({ mean })` straight through — it already returns
 * { alpha, beta }.
 */
export function betaPosterior(input) {
  if (input && Number.isFinite(input.alpha) && Number.isFinite(input.beta)) {
    if (!(input.alpha > 0 && input.beta > 0)) {
      throw new TypeError(`beta posterior needs alpha > 0 and beta > 0, got ${input.alpha}, ${input.beta}`);
    }
    const alpha = input.alpha, beta = input.beta;
    const mean = alpha / (alpha + beta);
    return {
      alpha, beta, mean,
      sd: Math.sqrt(mean * (1 - mean) / (alpha + beta + 1)),
      pseudo_sample_legs: alpha + beta
    };
  }
  const mean = input?.mean, sd = input?.sd ?? MEASURED.forwardRateSd;
  if (!Number.isFinite(mean) || mean <= 0 || mean >= 1) {
    throw new TypeError(`beta posterior needs a mean strictly between 0 and 1, got ${mean}`);
  }
  if (!Number.isFinite(sd) || sd <= 0) throw new TypeError(`beta posterior needs sd > 0, got ${sd}`);
  const concentration = (mean * (1 - mean)) / (sd * sd) - 1;
  if (!(concentration > 0)) throw new TypeError('posterior sd is too wide for this mean');
  return {
    alpha: mean * concentration,
    beta: (1 - mean) * concentration,
    mean, sd,
    pseudo_sample_legs: concentration
  };
}

/**
 * A leg at a given DECIDED win rate.
 *
 * The posterior is on the rate among DECIDED legs, because that is what
 * `familyRate.rate_of_decided` measures and what a forward projection has an
 * opinion about. The push share is structural, not uncertain — four of the
 * eight family lines are half-points and cannot push at all — so it is held
 * fixed and the unconditional win probability is rate x (1 - push).
 */
export function legsAtRate(rate, pushShares) {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new TypeError(`decided leg rate must be in [0, 1], got ${rate}`);
  }
  return pushShares.map(t => {
    if (!Number.isFinite(t) || t < 0 || t >= 1) throw new TypeError(`push share must be in [0, 1), got ${t}`);
    return { w: rate * (1 - t), t };
  });
}

function defaultPushShares(legCount = 2) {
  return Array.from({ length: legCount }, () => MEASURED.pushShare);
}

/** EV per unit staked at a given decided leg rate. Strictly increasing in the rate. */
export function ticketEvAtRate({ rate, pushShares = defaultPushShares(), americanPrice,
  reducedPayout = DEFAULT_REDUCED_PAYOUT } = {}) {
  return ticketOutcomes({ legs: legsAtRate(rate, pushShares), americanPrice, reducedPayout }).ev;
}

/**
 * The decided leg rate at which this ticket is exactly break-even.
 *
 * Bisected rather than solved, because the closed form differs by grading and
 * by leg count and a wrong closed form is invisible. EV is strictly increasing
 * in the rate, so bisection is exact.
 *
 * At the recorded +100 with the pooled push share this lands at 70.90%, which
 * is 1.37 posterior standard deviations below the measured 74.06%. Every
 * refusal decision in this module is downstream of that one number.
 */
export function breakEvenLegRate({ pushShares = defaultPushShares(), americanPrice,
  reducedPayout = DEFAULT_REDUCED_PAYOUT } = {}) {
  const ev = rate => ticketEvAtRate({ rate, pushShares, americanPrice, reducedPayout });
  if (ev(1) <= 0) return null;      // unbeatable price: even a certain leg loses money
  if (ev(0) >= 0) return 0;
  let lo = 0, hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (ev(mid) < 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The number that matters more than the stake: posterior mass below break-even.
 *
 * This is P(this bet is actually -EV), not P(this bet loses). A bet can be
 * +EV and lose; this is the probability that there was never anything to win.
 */
export function probabilityNegativeEv({ posterior, pushShares = defaultPushShares(),
  americanPrice, reducedPayout = DEFAULT_REDUCED_PAYOUT } = {}) {
  const post = betaPosterior(posterior);
  const threshold = breakEvenLegRate({ pushShares, americanPrice, reducedPayout });
  if (threshold == null) return { probability: 1, break_even_leg_rate: null, posterior: post,
    reason: 'no leg rate makes this price positive-EV' };
  return {
    probability: betaCdf(threshold, post.alpha, post.beta),
    break_even_leg_rate: threshold,
    margin_over_break_even: post.mean - threshold,
    posterior: post
  };
}

/* ------------------------------------------- three flavours of Kelly ---- */

/** Kelly at a single assumed leg rate. The building block; not the recommendation. */
export function pointEstimateKelly({ rate, posterior, pushShares = defaultPushShares(),
  americanPrice, reducedPayout = DEFAULT_REDUCED_PAYOUT, fraction = DEFAULT_KELLY_FRACTION } = {}) {
  const legRate = Number.isFinite(rate) ? rate : betaPosterior(posterior).mean;
  const ticket = ticketOutcomes({ legs: legsAtRate(legRate, pushShares), americanPrice, reducedPayout });
  return { ...kellyForOutcomes(ticket.outcomes, { fraction }), leg_rate: legRate, ticket };
}

/**
 * Kelly that maximises expected log wealth INTEGRATING over the posterior.
 *
 * The literal request, and the finding is that it does not do what it is
 * usually assumed to do. Because g is linear in the outcome probabilities,
 * E_rho[g(f; rho)] = g(f; predictive probabilities), so this is just the same
 * solver fed posterior-predictive probabilities. Those need E[rho] and E[rho²]:
 *
 *   W   = rho²·(1-t1)(1-t2)                      -> E[rho²]·(1-t1)(1-t2)
 *   NL  = (rho(1-t1)+t1)(rho(1-t2)+t2)
 *       = rho²·A + rho·B + C   with A = (1-t1)(1-t2),
 *                                   B = (1-t1)t2 + t1(1-t2),
 *                                   C = t1·t2
 *   P   = t1·t2 (no rho at all — push mass is structural)
 *
 * and E[rho²] = E[rho]² + Var[rho] > E[rho]², so the predictive win
 * probability is HIGHER than the win probability at the mean and this fraction
 * comes out LARGER than `pointEstimateKelly`. Rate uncertainty is a factor
 * shared by both legs; it correlates them positively; a parlay likes that.
 *
 * Two legs only, matching `ticketEV`'s own restriction — a third leg would
 * need E[rho³] and would reintroduce the reduced-bucket ambiguity that
 * function refuses.
 */
export function predictiveKelly({ posterior, pushShares = defaultPushShares(),
  americanPrice, reducedPayout = DEFAULT_REDUCED_PAYOUT, fraction = DEFAULT_KELLY_FRACTION } = {}) {
  const post = betaPosterior(posterior);
  if (pushShares.length !== 2) {
    throw new TypeError('predictiveKelly integrates the two-leg ticket only; ' +
      `got ${pushShares.length} legs`);
  }
  const [t1, t2] = pushShares;
  const m1 = post.mean;
  const m2 = post.mean * post.mean + post.sd * post.sd;   // E[rho²]

  const A = (1 - t1) * (1 - t2);
  const B = (1 - t1) * t2 + t1 * (1 - t2);
  const C = t1 * t2;

  const win = m2 * A;
  const noLoss = m2 * A + m1 * B + C;
  const bothPush = C;
  const reduced = Math.max(0, noLoss - win - bothPush);
  const loss = 1 - noLoss;

  const b = profitMultiple(americanPrice);
  if (b == null) throw new TypeError(`americanPrice must be a real price at or beyond +/-100, got ${americanPrice}`);
  const r = reducedProfit(reducedPayout, b);
  const outcomes = [
    { name: 'win', profit: b, probability: win },
    { name: 'reduced', profit: r, probability: reduced },
    { name: 'both_push', profit: 0, probability: bothPush },
    { name: 'loss', profit: -1, probability: loss }
  ];
  return {
    ...kellyForOutcomes(outcomes, { fraction }),
    posterior: post,
    predictive_probabilities: { win, reduced, both_push: bothPush, loss },
    note: 'maximises E[log wealth] integrated over the posterior; LARGER than Kelly at the ' +
      'posterior mean because the ticket win probability is convex in the leg rate'
  };
}

/**
 * The uncertainty-aware fraction that actually binds.
 *
 * Maximises the `confidence`-quantile of the per-bet growth rate over the
 * posterior instead of its mean. g(f; rho) is strictly increasing in rho for
 * f > 0, and quantiles commute with monotone transforms, so the solution is
 * exactly Kelly evaluated at the posterior's `confidence` quantile. Strictly
 * smaller than Kelly at the mean for every non-degenerate posterior, and it
 * converges to it as the posterior tightens — both of which the test pins.
 */
export function robustKelly({ posterior, confidence = DEFAULT_CONFIDENCE,
  pushShares = defaultPushShares(), americanPrice,
  reducedPayout = DEFAULT_REDUCED_PAYOUT, fraction = DEFAULT_KELLY_FRACTION } = {}) {
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new TypeError(`confidence quantile must be in (0, 1), got ${confidence}`);
  }
  const post = betaPosterior(posterior);
  const rate = betaQuantile(confidence, post.alpha, post.beta);
  const atQuantile = pointEstimateKelly({ rate, pushShares, americanPrice, reducedPayout, fraction });
  const atMean = pointEstimateKelly({ rate: post.mean, pushShares, americanPrice, reducedPayout, fraction });
  return {
    ...atQuantile,
    posterior: post,
    confidence,
    confidence_leg_rate: rate,
    point_estimate_full_kelly: atMean.full_kelly,
    point_estimate_stake_fraction: atMean.stake_fraction,
    shrinkage: atMean.full_kelly > 0 ? atQuantile.full_kelly / atMean.full_kelly : null,
    note: `growth-optimal in the ${(confidence * 100).toFixed(0)}th-percentile world rather than the average one`
  };
}
/* ------------------------------------------- simultaneous tickets ------- */

/**
 * The joint law of one weekend's tickets, enumerated exactly.
 *
 * WHY NOT SIMULATE. The first version of this drew correlated legs through a
 * Gaussian copula and solved the growth optimum on the sample. It was wrong
 * twice. The venial error is noise: the Kelly fraction is roughly EV/variance
 * and EV here is 0.09 against a per-ticket standard deviation near 1, so at
 * 20,000 draws the answer moved by 34% between seeds — a staking number that
 * depends on the seed is not a staking number. The real error is the copula:
 * rho = -0.044 was measured on the BINARY leg outcomes, and imposing it on the
 * latent normals produces a binary correlation of about -0.025, because the
 * tetrachoric map shrinks it by phi(z)²/(p·q). The simulation was quietly
 * modelling a little over half the dependence that was actually measured.
 *
 * WHAT THIS DOES INSTEAD. There are at most 3^(2n) leg patterns — 81 for two
 * tickets, 6,561 for four — so the joint law can simply be written down. Two
 * modelling choices, both stated rather than buried:
 *
 *   PUSHES ARE INDEPENDENT. A push is a structural property of the posted line
 *   (four of the eight family lines are half-points and cannot push at all),
 *   not a property of the game going the bettor's way. Each leg pushes on its
 *   own with its own share; the correlation applies to the decided outcome.
 *
 *   DECIDED LEGS FOLLOW A SECOND-ORDER BAHADUR EXPANSION. For exchangeable
 *   binary legs with common win probability p and common pairwise correlation
 *   rho, writing z_i = (y_i - p)/sqrt(p·q) for the standardised indicator:
 *
 *       P(y_1..y_d) = [ prod_i p^y_i·q^(1-y_i) ] · ( 1 + rho·SUM_{i<j} z_i·z_j )
 *
 *   This matches every marginal exactly and every pairwise correlation exactly,
 *   and assumes the third and higher joint cumulants are zero. For two legs it
 *   collapses to P(both win) = p² + rho·p·q, which IS the measured quantity —
 *   54.00% against p² = 54.85% at rho = -0.044 — so at one ticket this is not
 *   an approximation at all, it is the measurement.
 *
 *   FEASIBILITY, AND WHY THE TWO CORRELATIONS ARE SEPARATED. A second-order
 *   expansion cannot carry an arbitrary correlation: past a certain magnitude
 *   it assigns negative probability to the extreme patterns. The binding case
 *   is "every decided leg loses", whose correction factor falls like d², so
 *   rho = -0.044 is comfortably feasible over one ticket's two legs and is not
 *   feasible over four tickets' eight.
 *
 *   Shrinking one equicorrelation to fit is the obvious repair and it is
 *   backwards. The within-ticket correlation HURTS — it lowers the chance both
 *   legs land, which is the 0.85pp the scanner does not charge for — and the
 *   cross-ticket correlation HELPS. Shrinking both together gives back more
 *   than it takes and RAISES the stake: measured here, it moved the four-ticket
 *   recommendation from 0.86 units to 1.11. So the within-ticket term is kept
 *   at the measured value, which two legs always support, and only the
 *   cross-ticket term is shrunk to what the expansion can carry.
 *   `within_ticket_correlation` and `cross_ticket_correlation` report both.
 *   Clamping negative probabilities away was rejected for the same reason: it
 *   would delete exactly the disaster patterns the log utility cares most about.
 *
 * The result is deterministic, exact to the stated model, has no seed, and
 * costs microseconds.
 */
export function weekendPayoffDistribution({ rate, pushShares = defaultPushShares(),
  americanPrice, reducedPayout = DEFAULT_REDUCED_PAYOUT,
  tickets = 1, legCorrelation = MEASURED.legCorrelation } = {}) {
  if (!Number.isInteger(tickets) || tickets < 1) {
    throw new TypeError(`tickets must be a positive integer, got ${tickets}`);
  }
  if (!Number.isFinite(rate) || rate <= 0 || rate >= 1) {
    throw new TypeError(`decided leg rate must be strictly between 0 and 1, got ${rate}`);
  }
  const b = profitMultiple(americanPrice);
  if (b == null) throw new TypeError(`americanPrice must be a real price at or beyond +/-100, got ${americanPrice}`);
  const r = reducedProfit(reducedPayout, b);

  const legsPerTicket = pushShares.length;
  if (legsPerTicket < 2) throw new TypeError('a teaser ticket needs at least two legs');
  const m = tickets * legsPerTicket;
  if (m > 12) throw new RangeError(`enumerating ${3 ** m} patterns is not the intended use; got ${m} legs`);

  const legPush = [];
  for (let ticket = 0; ticket < tickets; ticket++) {
    for (const t of pushShares) {
      if (!Number.isFinite(t) || t < 0 || t >= 1) throw new TypeError(`push share must be in [0, 1), got ${t}`);
      legPush.push(t);
    }
  }

  const p = rate, q = 1 - rate;
  const sd = Math.sqrt(p * q);
  const zWin = q / sd, zLoss = -p / sd;

  const patterns = 3 ** m;
  const base = new Float64Array(patterns);
  const withinPairs = new Float64Array(patterns);
  const crossPairs = new Float64Array(patterns);
  const payoutCode = new Int32Array(patterns);
  const radix = tickets + 1;

  // Pass one: the independent weight of every pattern, its within-ticket and
  // cross-ticket pair sums, and what it pays. Ticket counts are packed into one
  // integer so that two patterns paying the same land in the same atom exactly
  // rather than nearly, which floating-point payoff keys would not guarantee.
  for (let code = 0; code < patterns; code++) {
    let remaining = code, weight = 1;
    let totalZ = 0, totalZsquared = 0, within = 0;
    let won = 0, reduced = 0, voided = 0, lost = 0;
    for (let ticket = 0; ticket < tickets; ticket++) {
      let ticketZ = 0, ticketZsquared = 0, ticketLost = false, pushed = 0;
      for (let leg = 0; leg < legsPerTicket; leg++) {
        const digit = remaining % 3;                 // 0 loss, 1 push, 2 win
        remaining = (remaining - digit) / 3;
        const t = legPush[ticket * legsPerTicket + leg];
        if (digit === 1) { weight *= t; pushed++; continue; }
        const z = digit === 2 ? zWin : zLoss;
        weight *= (1 - t) * (digit === 2 ? p : q);
        ticketZ += z;
        ticketZsquared += z * z;
        if (digit === 0) ticketLost = true;
      }
      within += (ticketZ * ticketZ - ticketZsquared) / 2;
      totalZ += ticketZ;
      totalZsquared += ticketZsquared;
      if (ticketLost) lost++;
      else if (pushed === 0) won++;
      else if (pushed === legsPerTicket) voided++;
      else reduced++;
    }
    base[code] = weight;
    withinPairs[code] = within;
    crossPairs[code] = (totalZ * totalZ - totalZsquared) / 2 - within;
    payoutCode[code] = won + radix * (reduced + radix * (voided + radix * lost));
  }

  // Feasibility, and the asymmetry that makes it matter. The within-ticket
  // correlation HURTS (it lowers the chance both legs land) and the
  // cross-ticket correlation HELPS (simultaneous tickets hedge each other), so
  // shrinking them together — which is what an equicorrelated model is forced
  // to do — gives back more than it takes and raises the stake. The
  // within-ticket term is kept at the measured value, which two legs always
  // support, and only the cross-ticket term is shrunk to whatever the expansion
  // can carry. Conservative by construction, and reported either way.
  let widestWithin = 0, narrowestWithin = 0;
  for (let code = 0; code < patterns; code++) {
    if (!(base[code] > 0)) continue;
    if (withinPairs[code] > widestWithin) widestWithin = withinPairs[code];
    if (withinPairs[code] < narrowestWithin) narrowestWithin = withinPairs[code];
  }
  let rhoWithin = legCorrelation;
  if (rhoWithin < 0 && widestWithin > 0) rhoWithin = Math.max(rhoWithin, -1 / widestWithin);
  if (rhoWithin > 0 && narrowestWithin < 0) rhoWithin = Math.min(rhoWithin, -1 / narrowestWithin);

  let rhoCross = legCorrelation;
  for (let code = 0; code < patterns; code++) {
    if (!(base[code] > 0)) continue;
    const headroom = 1 + rhoWithin * withinPairs[code];
    const c = crossPairs[code];
    if (c > 0 && rhoCross < 0) rhoCross = Math.max(rhoCross, -headroom / c);
    else if (c < 0 && rhoCross > 0) rhoCross = Math.min(rhoCross, -headroom / c);
  }

  const atoms = new Map();
  let mass = 0;
  for (let code = 0; code < patterns; code++) {
    if (!(base[code] > 0)) continue;
    const probability = base[code] * (1 + rhoWithin * withinPairs[code] + rhoCross * crossPairs[code]);
    if (!(probability > 0)) continue;
    mass += probability;
    const key = payoutCode[code];
    const existing = atoms.get(key);
    if (existing) { existing.probability += probability; continue; }
    let rest = key;
    const won = rest % radix; rest = (rest - won) / radix;
    const reduced = rest % radix; rest = (rest - reduced) / radix;
    const voided = rest % radix; rest = (rest - voided) / radix;
    const lost = rest;
    atoms.set(key, { won, reduced, voided, lost, probability, profit: won * b + reduced * r - lost });
  }

  const list = [...atoms.values()].sort((x, y) => x.profit - y.profit);
  for (const atom of list) atom.probability /= mass;

  let mean = 0;
  for (const atom of list) mean += atom.probability * atom.profit;
  let variance = 0;
  for (const atom of list) variance += atom.probability * (atom.profit - mean) ** 2;

  return {
    atoms: list,
    tickets,
    leg_rate: rate,
    leg_correlation: legCorrelation,
    within_ticket_correlation: rhoWithin,
    cross_ticket_correlation: rhoCross,
    correlation_shrunk: rhoWithin !== legCorrelation || rhoCross !== legCorrelation,
    mean, variance,
    profit_multiple: b,
    reduced_profit_multiple: r,
    model: 'pushes independent; decided legs under a second-order Bahadur expansion with the ' +
      'measured correlation on within-ticket pairs and, where the expansion cannot carry it, a ' +
      'shrunk correlation on cross-ticket pairs'
  };
}

/**
 * Growth-optimal per-ticket fraction when n tickets settle together.
 *
 * The thing this exists to prevent is applying the single-bet fraction n times,
 * which is not the answer to any question. The correct problem is
 *
 *     maximise over f:   E[ ln(1 + f·(X1 + ... + Xn)) ]
 *
 * over the JOINT distribution. With identical tickets, symmetry makes the
 * optimal allocation equal across them, so there is one scalar to find and the
 * same bisection that solves the single ticket solves this one — the only
 * difference is that the outcome vector now comes from
 * `weekendPayoffDistribution` instead of a single ticket, and the worst case is
 * -n rather than -1.
 *
 * Two effects pull in opposite directions and both are reported:
 *
 *   SIMULTANEITY reduces the per-ticket fraction. The bankroll cannot be
 *   re-measured between tickets, so they compete for the same capital. This is
 *   a third-order effect in the bet size — a mean-variance reader would say the
 *   per-ticket fraction is unchanged — and it is genuinely small here.
 *
 *   NEGATIVE CORRELATION raises it. rho < 0 means simultaneous tickets hedge
 *   each other slightly, so a weekend of four is less risky than four
 *   independent bets. `legCorrelation: 0` runs the independence counterfactual
 *   and `correlation_uplift` reports the ratio.
 *
 * Note what the single-ticket baseline means here: `single_ticket_correlated`
 * already includes the WITHIN-ticket correlation, which costs about 0.85pp of
 * win probability and is by far the larger of the two correlation effects. The
 * scanner's own EV numbers assume independence and are optimistic by that much.
 */
export function portfolioKelly({ rate, posterior, confidence = DEFAULT_CONFIDENCE,
  pushShares = defaultPushShares(), americanPrice, reducedPayout = DEFAULT_REDUCED_PAYOUT,
  tickets = 2, legCorrelation = MEASURED.legCorrelation,
  fraction = DEFAULT_KELLY_FRACTION } = {}) {
  let legRate = rate;
  if (!Number.isFinite(legRate)) {
    const post = betaPosterior(posterior);
    legRate = confidence == null ? post.mean : betaQuantile(confidence, post.alpha, post.beta);
  }
  const shared = { rate: legRate, pushShares, americanPrice, reducedPayout };

  const weekend = weekendPayoffDistribution({ ...shared, tickets, legCorrelation });
  const solved = kellyForOutcomes(weekend.atoms, { fraction });

  const independentWeekend = weekendPayoffDistribution({ ...shared, tickets, legCorrelation: 0 });
  const independent = kellyForOutcomes(independentWeekend.atoms, { fraction });

  const singleCorrelated = kellyForOutcomes(
    weekendPayoffDistribution({ ...shared, tickets: 1, legCorrelation }).atoms, { fraction });
  const singleIndependent = kellyForOutcomes(
    weekendPayoffDistribution({ ...shared, tickets: 1, legCorrelation: 0 }).atoms, { fraction });

  return {
    tickets,
    leg_rate: legRate,
    leg_correlation: legCorrelation,
    per_ticket_full_kelly: solved.full_kelly,
    per_ticket_stake_fraction: solved.stake_fraction,
    total_exposure_full_kelly: solved.full_kelly * tickets,
    total_exposure_stake_fraction: solved.stake_fraction * tickets,
    growth_rate_full: solved.growth_rate_full ?? null,
    blocked: solved.blocked === true,
    reason: solved.reason,
    single_ticket_correlated: singleCorrelated.full_kelly,
    single_ticket_independent: singleIndependent.full_kelly,
    per_ticket_vs_single: singleCorrelated.full_kelly > 0
      ? solved.full_kelly / singleCorrelated.full_kelly : null,
    total_vs_n_times_single: singleCorrelated.full_kelly > 0
      ? (solved.full_kelly * tickets) / (singleCorrelated.full_kelly * tickets) : null,
    within_ticket_correlation_cost: singleIndependent.full_kelly > 0
      ? singleCorrelated.full_kelly / singleIndependent.full_kelly : null,
    independent_per_ticket_full_kelly: independent.full_kelly,
    correlation_uplift: independent.full_kelly > 0 ? solved.full_kelly / independent.full_kelly : null,
    within_ticket_correlation: weekend.within_ticket_correlation,
    cross_ticket_correlation: weekend.cross_ticket_correlation,
    correlation_shrunk: weekend.correlation_shrunk,
    weekend_mean: weekend.mean,
    weekend_variance: weekend.variance,
    fraction_used: fraction,
    approximation: weekend.model + '; equal allocation across tickets follows from modelling them ' +
      'as identical, and only the pairwise leg correlation is measured'
  };
}

/* ---------------------------------------------------- the recommendation */

/**
 * The staking decision, with the guardrails that bind.
 *
 * Order of operations, and each step can refuse:
 *   1. How much posterior mass sits below break-even at this price. Over
 *      `maxNegativeEvProbability` and nothing else matters — refuse.
 *   2. Kelly in the `confidence`-percentile world, not the average one.
 *   3. The Kelly fraction multiplier.
 *   4. Portfolio solve if more than one ticket settles this weekend.
 *   5. Per-ticket cap, then per-week exposure cap.
 *
 * `probability_negative_ev` is reported whether or not it refuses, because on
 * a bet with three points of edge it is a more useful number than the stake.
 */
export function recommendStake({ posterior, pushShares = defaultPushShares(), americanPrice,
  reducedPayout = DEFAULT_REDUCED_PAYOUT, bankrollUnits = 100,
  fraction = DEFAULT_KELLY_FRACTION, confidence = DEFAULT_CONFIDENCE,
  simultaneousTickets = 1, legCorrelation = MEASURED.legCorrelation,
  maxUnitsPerTicket = 2, maxWeeklyUnits = 5, maxNegativeEvProbability = 0.20,
  flatUnits = 1 } = {}) {
  const post = betaPosterior(posterior);
  const b = profitMultiple(americanPrice);
  if (b == null) throw new TypeError(`americanPrice must be a real price at or beyond +/-100, got ${americanPrice}`);

  const negativeEv = probabilityNegativeEv({ posterior: post, pushShares, americanPrice, reducedPayout });
  const meanTicket = ticketOutcomes({ legs: legsAtRate(post.mean, pushShares), americanPrice, reducedPayout });
  const { win, reduced, loss } = meanTicket.probabilities;
  const breakEvenNumerator = reducedPayout === 'graded_loss' ? loss + reduced : loss;
  const breakEvenDenominator = reducedPayout === 'same_price' ? win + reduced : win;
  const breakEvenMultiple = breakEvenDenominator > 0 ? breakEvenNumerator / breakEvenDenominator : null;

  const context = {
    version: TEASER_STAKING_VERSION,
    american_price: americanPrice,
    profit_multiple: b,
    posterior: post,
    confidence,
    fraction_used: fraction,
    bankroll_units: bankrollUnits,
    simultaneous_tickets: simultaneousTickets,
    probability_negative_ev: negativeEv.probability,
    break_even_leg_rate: negativeEv.break_even_leg_rate,
    margin_over_break_even: negativeEv.margin_over_break_even ?? null,
    break_even_american: breakEvenMultiple == null ? null : exactAmerican(breakEvenMultiple),
    reduced_payout: reducedPayout,
    reduced_payout_verified: false
  };

  if (negativeEv.probability > maxNegativeEvProbability) {
    return {
      ...context, units: 0, stake_fraction: 0, blocked: true,
      blocked_by: 'negative_ev_probability',
      reason: `the posterior puts ${(negativeEv.probability * 100).toFixed(1)}% of its mass below the ` +
        `break-even leg rate of ${(negativeEv.break_even_leg_rate * 100).toFixed(2)}% at ${americanPrice}, ` +
        `over the ${(maxNegativeEvProbability * 100).toFixed(0)}% this strategy tolerates. The break-even ` +
        'price gate would pass this bet; the posterior says it is close to a coin flip whether there is ' +
        'any edge to stake at all.'
    };
  }

  const robust = robustKelly({ posterior: post, confidence, pushShares, americanPrice, reducedPayout, fraction });
  const pointEstimate = pointEstimateKelly({ rate: post.mean, pushShares, americanPrice, reducedPayout, fraction });
  const predictive = predictiveKelly({ posterior: post, pushShares, americanPrice, reducedPayout, fraction });

  if (robust.blocked || !(robust.full_kelly > 0)) {
    return {
      ...context, units: 0, stake_fraction: 0, blocked: true,
      blocked_by: 'no_edge_in_confidence_world',
      point_estimate_units: pointEstimate.stake_fraction * bankrollUnits,
      reason: `the ${(confidence * 100).toFixed(0)}th-percentile leg rate ` +
        `(${(robust.confidence_leg_rate * 100).toFixed(2)}%) is below break-even at ${americanPrice}, ` +
        'so the growth-optimal stake in that world is zero. ' + (robust.reason ?? '')
    };
  }

  const portfolio = portfolioKelly({
    rate: robust.confidence_leg_rate, pushShares, americanPrice, reducedPayout,
    tickets: simultaneousTickets, legCorrelation, fraction
  });
  const perTicketFullKelly = (!portfolio.blocked && portfolio.per_ticket_full_kelly > 0)
    ? portfolio.per_ticket_full_kelly
    : 0;

  if (!(perTicketFullKelly > 0)) {
    return {
      ...context, units: 0, stake_fraction: 0, blocked: true,
      blocked_by: 'no_edge_after_correlation',
      portfolio,
      reason: 'the within-ticket leg correlation removes what was left of the edge in the ' +
        `${(confidence * 100).toFixed(0)}th-percentile world. ` + (portfolio.reason ?? '')
    };
  }

  const rawFraction = perTicketFullKelly * fraction;
  const rawUnits = rawFraction * bankrollUnits;

  let units = rawUnits;
  let binding = null;
  if (units > maxUnitsPerTicket) { units = maxUnitsPerTicket; binding = 'per_ticket_cap'; }
  if (units * simultaneousTickets > maxWeeklyUnits) {
    units = maxWeeklyUnits / simultaneousTickets;
    binding = 'weekly_exposure_cap';
  }

  const pointEstimateUnits = pointEstimate.stake_fraction * bankrollUnits;

  return {
    ...context,
    units,
    stake_fraction: units / bankrollUnits,
    blocked: false,
    weekly_units: units * simultaneousTickets,
    full_kelly_per_ticket: perTicketFullKelly,
    confidence_leg_rate: robust.confidence_leg_rate,
    caps: {
      max_units_per_ticket: maxUnitsPerTicket,
      max_weekly_units: maxWeeklyUnits,
      uncapped_units: rawUnits,
      binding
    },
    comparison: {
      point_estimate_full_kelly: pointEstimate.full_kelly,
      point_estimate_units: pointEstimateUnits,
      predictive_full_kelly: predictive.full_kelly,
      predictive_units: predictive.stake_fraction * bankrollUnits,
      robust_full_kelly: robust.full_kelly,
      robust_units_uncapped: rawUnits,
      units_given_up_vs_point_estimate: pointEstimateUnits - rawUnits,
      percent_smaller_than_point_estimate: pointEstimateUnits > 0
        ? (1 - rawUnits / pointEstimateUnits) * 100 : null,
      predictive_vs_point_estimate_percent: pointEstimate.full_kelly > 0
        ? (predictive.full_kelly / pointEstimate.full_kelly - 1) * 100 : null,
      flat_units: flatUnits,
      robust_vs_flat: flatUnits > 0 ? rawUnits / flatUnits : null
    },
    portfolio,
    note: 'probability_negative_ev is the number to read first. On a bet with three points of edge, ' +
      'whether the edge exists matters more than how much of the bankroll it gets.'
  };
}

/* ------------------------------------------------------ the drawdown ---- */

/** Inverse-CDF sample from an enumerated weekend law. */
function sampleAtom(atoms, u) {
  let cumulative = 0;
  for (const atom of atoms) {
    cumulative += atom.probability;
    if (u <= cumulative) return atom.profit;
  }
  return atoms[atoms.length - 1].profit;
}

/**
 * The season as it is actually experienced, not as it averages.
 *
 * The leg rate is drawn ONCE PER SEASON from the posterior and then held fixed
 * for every ticket, which is the whole point. A bettor does not get the average
 * of the worlds the posterior describes; they get one world and 15-33 tickets
 * inside it. Redrawing the rate per ticket would average the bad worlds away
 * and produce a drawdown distribution nobody will ever experience —
 * `rateFixedPerSeason: false` does exactly that, and exists so the difference
 * can be shown rather than asserted.
 *
 * Within a weekend the tickets are drawn from the exact enumerated law, so the
 * leg correlation is carried properly. Weekends are independent of each other.
 *
 * Two plans go through the same machinery:
 *   'fractional_kelly'  stakes `perTicketFraction` of the CURRENT bankroll, so
 *                       it compounds and cannot quite be ruined.
 *   'flat'              stakes `flatUnits` of the STARTING bankroll every time,
 *                       which is what the strategy does today. It does not
 *                       compound, and it can reach zero.
 *
 * Defaults put 28 tickets on the board — 14 betting weeks at 2 a week — which
 * is mid-band for the 15-33 this strategy actually places.
 */
export function seasonDrawdown({ posterior, pushShares = defaultPushShares(), americanPrice,
  reducedPayout = DEFAULT_REDUCED_PAYOUT, plan = 'fractional_kelly',
  perTicketFraction = null, flatUnits = 1, bankrollUnits = 100,
  weeks = 14, ticketsPerWeek = 2, legCorrelation = MEASURED.legCorrelation,
  seasons = 4000, seed = 20260910, rateFixedPerSeason = true } = {}) {
  if (!['fractional_kelly', 'flat'].includes(plan)) {
    throw new TypeError(`unknown plan '${plan}'; expected fractional_kelly or flat`);
  }
  if (plan === 'fractional_kelly' && !(perTicketFraction > 0)) {
    throw new TypeError('fractional_kelly needs a positive perTicketFraction');
  }
  const post = betaPosterior(posterior);
  const rng = mulberry32(seed);
  const flatStake = flatUnits / bankrollUnits;
  const law = rate => weekendPayoffDistribution({ rate, pushShares, americanPrice,
    reducedPayout, tickets: ticketsPerWeek, legCorrelation }).atoms;

  const maxDrawdowns = [], terminals = [];
  let red = 0, ruined = 0;

  for (let season = 0; season < seasons; season++) {
    const seasonRate = rateFixedPerSeason ? betaSample(post.alpha, post.beta, rng) : null;
    let atoms = seasonRate == null ? null : law(seasonRate);
    let bankroll = 1, peak = 1, maxDrawdown = 0;

    for (let week = 0; week < weeks; week++) {
      if (seasonRate == null) atoms = law(betaSample(post.alpha, post.beta, rng));
      const payoff = sampleAtom(atoms, rng());

      const wanted = plan === 'flat' ? flatStake : perTicketFraction * bankroll;
      // Cannot risk more than is there. A flat plan late in a bad season is the
      // only way this clamp ever fires, which is the failure mode a flat plan
      // has and a fractional one does not.
      const stake = Math.min(wanted, bankroll / ticketsPerWeek);
      bankroll += stake * payoff;

      if (!(bankroll > 1e-9)) { bankroll = 0; maxDrawdown = 1; ruined++; break; }
      if (bankroll > peak) peak = bankroll;
      const drawdown = (peak - bankroll) / peak;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
    maxDrawdowns.push(maxDrawdown);
    terminals.push(bankroll);
    if (bankroll < 1) red++;
  }

  maxDrawdowns.sort((x, y) => x - y);
  terminals.sort((x, y) => x - y);
  const over = threshold => maxDrawdowns.filter(d => d >= threshold).length / seasons;

  return {
    plan,
    tickets_per_season: weeks * ticketsPerWeek,
    weeks, tickets_per_week: ticketsPerWeek, seasons,
    per_ticket_fraction: plan === 'flat' ? flatStake : perTicketFraction,
    stake_units: (plan === 'flat' ? flatStake : perTicketFraction) * bankrollUnits,
    max_drawdown: {
      p50: percentile(maxDrawdowns, 0.50),
      p75: percentile(maxDrawdowns, 0.75),
      p90: percentile(maxDrawdowns, 0.90),
      p95: percentile(maxDrawdowns, 0.95),
      p99: percentile(maxDrawdowns, 0.99),
      worst: maxDrawdowns[maxDrawdowns.length - 1],
      mean: maxDrawdowns.reduce((a, c) => a + c, 0) / seasons
    },
    probability_drawdown_over: { '20%': over(0.20), '35%': over(0.35), '50%': over(0.50) },
    terminal_bankroll: {
      p05: percentile(terminals, 0.05),
      p25: percentile(terminals, 0.25),
      p50: percentile(terminals, 0.50),
      p75: percentile(terminals, 0.75),
      p95: percentile(terminals, 0.95),
      mean: terminals.reduce((a, c) => a + c, 0) / seasons
    },
    probability_season_red: red / seasons,
    probability_ruin: ruined / seasons,
    rate_fixed_per_season: rateFixedPerSeason,
    seed
  };
}
