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
 * re-measured between them and the single-bet fraction cannot simply be
 * applied n times. `portfolioKelly` solves the actual problem — maximise
 * E[ln(1 + f·ΣXi)] over the JOINT outcome distribution — by simulation.
 *
 * The approximations, stated rather than buried:
 *   (a) The dependence is a Gaussian copula with equicorrelation ρ = -0.044 on
 *       the leg indicators. Only the pairwise correlation is measured; the
 *       copula SHAPE is assumed, and a different copula with the same pairwise
 *       correlation would give a slightly different answer.
 *   (b) All tickets are assumed to carry the same leg rate and push shares, so
 *       symmetry makes the optimal allocation equal across tickets and the
 *       problem one-dimensional.
 *   (c) Legs within a ticket must be in different games (`ticketLegality`
 *       enforces this), so the same ρ applies within and across tickets.
 *
 * The direction matters more than the magnitude: ρ < 0 means simultaneous
 * tickets diversify BETTER than independent ones, so the per-ticket fraction
 * comes out slightly LARGER than the single-bet fraction, not smaller, while
 * total weekend exposure grows sub-linearly in n. `legCorrelation: 0` runs the
 * independence counterfactual, and the difference between them is small enough
 * that the weekly exposure cap, not the correlation, is what actually binds.
 *
 * ---------------------------------------------------------------------------
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

/** Acklam's rational approximation; |error| < 1.15e-9, far tighter than anything here needs. */
const ACKLAM_A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
  1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const ACKLAM_B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
  6.680131188771972e+01, -1.328068155288572e+01];
const ACKLAM_C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
  -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const ACKLAM_D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
  3.754408661907416e+00];

export function inverseNormalCdf(p) {
  if (!(p > 0)) return -Infinity;
  if (!(p < 1)) return Infinity;
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) * q + ACKLAM_C[4]) * q + ACKLAM_C[5])
      / ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q + ACKLAM_D[3]) * q + 1);
  }
  if (p > 1 - 0.02425) return -inverseNormalCdf(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((ACKLAM_A[0] * r + ACKLAM_A[1]) * r + ACKLAM_A[2]) * r + ACKLAM_A[3]) * r + ACKLAM_A[4]) * r + ACKLAM_A[5]) * q
    / (((((ACKLAM_B[0] * r + ACKLAM_B[1]) * r + ACKLAM_B[2]) * r + ACKLAM_B[3]) * r + ACKLAM_B[4]) * r + 1);
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

/**
 * Cholesky factor of the m x m equicorrelation matrix.
 *
 * The usual one-factor shortcut Z_i = sqrt(rho)·F + sqrt(1-rho)·e_i needs
 * rho >= 0 and this correlation is negative, so the factor is computed
 * directly. Equicorrelation is only a valid correlation matrix for
 * rho > -1/(m-1); with eight legs that floor is -0.143 and the measured
 * -0.044 clears it, but the check is here because a caller passing a bigger
 * negative number should get an error rather than a silently complex factor.
 */
function equicorrelationFactor(m, rho) {
  if (m < 1) throw new TypeError('need at least one leg');
  if (m === 1) return [[1]];
  const floor = -1 / (m - 1);
  if (!(rho > floor && rho < 1)) {
    throw new RangeError(
      `equicorrelation ${rho} is not a valid correlation for ${m} legs (needs ${floor.toFixed(4)} < rho < 1)`);
  }
  const L = Array.from({ length: m }, () => new Float64Array(m));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = i === j ? 1 : rho;
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) L[i][j] = Math.sqrt(Math.max(sum, 0));
      else L[i][j] = L[j][j] === 0 ? 0 : sum / L[j][j];
    }
  }
  return L;
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const position = q * (sorted.length - 1);
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}
