/**
 * A score-driven (GAS) dynamic joint model of BOTH teams' scores.
 *
 * Everything else in this repository that forecasts a game forecasts a MARGIN:
 * the ensemble emits a number, the market residual shrinks that number, and the
 * distribution around it is recovered afterwards from historical errors. This
 * module does the opposite. It models the two scoreboards jointly and lets the
 * margin, the total, the cover probability and the same-game correlation all
 * fall out of one joint distribution.
 *
 * WHY THIS SHAPE (Koopman & Lit 2015, JRSS-A 178(1), "A dynamic bivariate
 * Poisson model for analysing and forecasting match results"). Their head-to-
 * head finding is that the SCORE-DRIVEN version of a dynamic bivariate Poisson
 * beats both a static model and a fully parameter-driven state-space model, at
 * a tiny fraction of the compute, because the latent strengths are updated by a
 * closed-form function of the observation rather than by simulation. That
 * compute ratio is the only reason this is a reasonable thing to attempt inside
 * a Node/SQLite app: the filter is one forward pass with no integration, no
 * particle cloud and no matrix inversion.
 *
 * ===========================================================================
 * THE FOUR MODELLING DECISIONS, AND THE ONE THE LITERATURE GETS WRONG FOR NFL
 * ===========================================================================
 *
 * 1. THE POISSON UNIT IS A SCORING EVENT, NOT A POINT.
 *
 *    This is the decision that makes or breaks the whole idea, and taking the
 *    football paper's structure off the shelf unchanged gets it wrong. Soccer
 *    goals are worth one each, so goals are (nearly) Poisson. NFL points are
 *    not: they arrive in lumps of 3, 6, 7 and 8. An NFL team scores about 22.5
 *    points per game with a standard deviation of about 10.2, so the variance
 *    is roughly 104 against a mean of 22.5 — overdispersed by a factor of four
 *    and a half. A Poisson fitted to POINTS would claim a standard deviation of
 *    4.7 and would therefore be catastrophically overconfident about every
 *    margin and every total it prices. That is not a small calibration issue;
 *    it is the difference between a usable distribution and a dangerous one.
 *
 *    So the Poisson layer counts SCORING EVENTS (drives that end in points),
 *    which is the quantity that is plausibly Poisson, and each event carries a
 *    value drawn from a fitted distribution over {1, 2, 3, 6, 7, 8}. The
 *    observed score is the compound Poisson sum. Mean = lambda * E[V] and
 *    variance = lambda * E[V^2], so the model reproduces the real mean/variance
 *    ratio instead of contradicting it, and it puts its mass on the football
 *    lattice rather than smoothly across it.
 *
 *    The value 1 is in the support with a free probability even though no NFL
 *    score has ever been odd-by-one in that way, and that is deliberate: it
 *    makes the likelihood finite on ANY non-negative integer, so the model can
 *    be fitted to a data source that is not on the football lattice without
 *    silently returning -Infinity, and the fitted P(V=1) then reports how far
 *    off the lattice that source actually is. On real NFL scores it should fit
 *    to approximately zero. See `SEVERITY_VALUES`.
 *
 * 2. DEPENDENCE ENTERS AS A SHARED COUNT, NOT AS A CORRELATION PARAMETER.
 *
 *    Karlis & Ntzoufras' trivariate reduction: N_home = A_home + C and
 *    N_away = A_away + C with A_home, A_away, C independent Poisson. C is the
 *    shared scoring-event shock — the pace, the tempo, the game script that
 *    gives both teams more chances. It produces Cov(S_home, S_away) =
 *    lambda_c * E[V]^2 >= 0, which is the right sign and the right mechanism
 *    for football, and it costs one parameter.
 *
 *    NOTE the structural difference from the pure bivariate Poisson the paper
 *    uses. There the shared shock cancels exactly out of the margin, so the
 *    margin is Skellam and carries no information about the dependence. Here it
 *    does NOT cancel, because the shared EVENTS still draw independent VALUES:
 *    two extra scoring drives, one a field goal and one a touchdown, move the
 *    margin. So in this model the same parameter that creates the total's
 *    fat tail also widens the margin, which is a more honest description of
 *    football than the Skellam identity and is the reason `skellamPmf` below is
 *    provided as a reference implementation and a test oracle rather than as
 *    the production margin.
 *
 * 3. THE STRENGTHS ARE UPDATED BY THE SCORE OF THE LIKELIHOOD (GAS).
 *
 *    Each team carries a time-varying attack a_i and defence d_i, with
 *      log lambda_home = mu + eta + a_home - d_away
 *      log lambda_away = mu + a_away - d_home
 *    and after each game every one of the four states moves by the scaled
 *    derivative of that game's log-likelihood with respect to it:
 *      f_{t+1} = B * f_t + A * s_t.
 *    For the degenerate case of a plain Poisson the score reduces to exactly
 *    (observed - expected), which is the reassuring sanity check that this is a
 *    generalisation of the obvious update rule and not an unrelated one;
 *    `test/nfl-joint-score.test.js` pins that reduction. There is no omega term
 *    because the level of the strengths is not identified separately from mu.
 *
 * 4. STATICS ARE FIT PER SEASON, STATES UPDATE PER GAME.
 *
 *    The eight static parameters are re-estimated by maximum likelihood at each
 *    held-out season boundary using only games final before it. The states are
 *    not "refit" at all — they are filtered, so they already incorporate every
 *    game up to kickoff at zero marginal cost. That is the score-driven
 *    advantage and it is why a weekly cadence costs nothing here. The harness
 *    in `joint-score-backtest.js` gives the incumbent its full production
 *    WEEKLY refit anyway, because handicapping the baseline would make any win
 *    here meaningless.
 *
 * ===========================================================================
 * WHAT THIS MODULE DOES NOT DO
 * ===========================================================================
 *
 * It is not wired into `ensembleLine`, `marginPmf`, the teaser scanner or any
 * route. It writes no weight and changes no forecast. It is a model plus the
 * evidence needed to decide whether it should ever be any of those things, and
 * the honest reading of that evidence is recorded in
 * docs/evidence/2026-09-12/JOINT-SCORING-STAGE-3.md.
 */

export const JOINT_SCORE_VERSION = 'nfl-joint-score-gas-v1';

/**
 * The values a single scoring event can take.
 *
 * 3 field goal, 7 touchdown with the kick, 6 touchdown with a missed or
 * declined conversion, 8 touchdown with a two-point conversion, 2 safety (or a
 * defensive conversion). 1 is impossible in real football and is in the support
 * only so the likelihood stays finite on non-lattice data; see decision 1 in
 * the header. Its fitted probability is a diagnostic: on real NFL scores it
 * should be ~0, and a materially positive value means the score source is not
 * the football lattice.
 */
export const SEVERITY_VALUES = Object.freeze([1, 2, 3, 6, 7, 8]);

/**
 * Scores above this are not modelled. The NFL record for one team is 73.
 *
 * The truncation is not free and is not hidden: at a typical fitted rate the
 * mass beyond 80 points is about 9e-5, because a compound Poisson has a fatter
 * upper tail than the normal approximation suggests. Everything derived from a
 * truncated grid is therefore renormalised over it — see `jointSummary` — so
 * the distributions this module reports are proper, and the pre-normalisation
 * mass is reported alongside them as the diagnostic of how much was cut.
 */
export const MAX_SCORE = 80;

/**
 * Cap on the terms of the shared-shock mixture.
 *
 * Sized so the truncated tail is negligible at the largest lambda_c the
 * optimiser may reach, not at the one it usually finds. `adaptiveTerms` cuts it
 * down to what each call actually needs, which for a fitted lambda_c near 0.4
 * is about eight, so the cap costs nothing in the hot path and buys exactness
 * in the identity tests.
 */
const SHOCK_TERMS = 24;

/** Floor under any probability that enters a logarithm. */
const PROB_FLOOR = 1e-300;

const logistic = x => 1 / (1 + Math.exp(-x));
const logit = p => Math.log(p / (1 - p));
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

/* ------------------------------------------------------------ special functions */

/**
 * Modified Bessel function of the first kind, integer order, by its defining
 * series with the exponential scaled out.
 *
 * Only `skellamPmf` needs it, and `skellamPmf` exists as a reference oracle
 * rather than as production code, so clarity beats the usual continued-fraction
 * machinery. Returns exp(-x) * I_nu(x), which is the form the Skellam pmf wants
 * and which does not overflow.
 */
export function besselIScaled(nu, x) {
  const n = Math.abs(Math.round(nu));
  if (x < 0) throw new Error('besselIScaled expects x >= 0');
  if (x === 0) return n === 0 ? 1 : 0;
  // I_n(x) = sum_{k>=0} (x/2)^{2k+n} / (k! (k+n)!), multiplied through by e^-x.
  const half = x / 2;
  let logTerm = n * Math.log(half) - lgamma(n + 1) - x;
  let sum = Math.exp(logTerm);
  let term = sum;
  for (let k = 1; k < 400; k++) {
    // term_k / term_{k-1} = (x/2)^2 / (k (k+n))
    term *= (half * half) / (k * (k + n));
    sum += term;
    if (term < sum * 1e-18) break;
  }
  return sum;
}

/** Lanczos log-gamma. Standard coefficients, g = 7, n = 9. */
export function lgamma(z) {
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  const x = z - 1;
  let a = g[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += g[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Skellam pmf: P(X - Y = d) for independent X ~ Pois(l1), Y ~ Pois(l2).
 *
 * Present as a reference implementation and a test oracle. It is the exact
 * margin law of the textbook bivariate Poisson, and the fact that lambda_c does
 * not appear in it is the identity discussed in decision 2 of the header. It is
 * NOT the margin this model reports, because compounding the counts with random
 * point values breaks that cancellation.
 */
export function skellamPmf(d, l1, l2) {
  if (l1 <= 0 || l2 <= 0) return d === 0 ? 1 : 0;
  const x = 2 * Math.sqrt(l1 * l2);
  // besselIScaled returns exp(-x) * I_n(x), but the Skellam density carries
  // exp(-(l1 + l2)). The correction factor exp(x - (l1 + l2)) puts back exactly
  // the difference; writing it this way keeps the overflow protection that made
  // the scaled Bessel worth having in the first place.
  return Math.exp(x - (l1 + l2)) * Math.pow(l1 / l2, d / 2) * besselIScaled(Math.abs(d), x);
}

/**
 * Exact pmf of the textbook bivariate Poisson, by its defining sum.
 *
 * Also a test oracle: setting every scoring event to be worth exactly one point
 * must make this module's compound machinery agree with this closed form, which
 * is the strongest available check that the trivariate reduction, the Panjer
 * recursion and the shared-shock mixture are all wired up correctly.
 */
export function bivariatePoissonPmf(x, y, l1, l2, l3) {
  if (x < 0 || y < 0) return 0;
  const base = -(l1 + l2 + l3) + x * Math.log(Math.max(l1, PROB_FLOOR)) - lgamma(x + 1)
    + y * Math.log(Math.max(l2, PROB_FLOOR)) - lgamma(y + 1);
  let sum = 0;
  const ratio = l3 / Math.max(l1 * l2, PROB_FLOOR);
  for (let k = 0; k <= Math.min(x, y); k++) {
    sum += Math.exp(lgamma(x + 1) - lgamma(k + 1) - lgamma(x - k + 1)
      + lgamma(y + 1) - lgamma(k + 1) - lgamma(y - k + 1)
      + lgamma(k + 1) + k * Math.log(Math.max(ratio, PROB_FLOOR)));
  }
  return Math.exp(base) * sum;
}

/* ------------------------------------------------------- compound Poisson core */

/**
 * Compound Poisson pmf by the Panjer recursion.
 *
 *   P(0) = exp(-lambda)                                (severity has no atom at 0)
 *   P(s) = (lambda / s) * sum_{v <= s} v * q(v) * P(s - v)
 *
 * Exact, O(maxScore * |support|), and it needs no truncation of the event count
 * — which is why it is used instead of summing the count mixture directly.
 *
 * @param {number}   lambda    Expected number of scoring events.
 * @param {number[]} severity  Probability of each value in SEVERITY_VALUES.
 * @param {number}   maxScore  Highest score to compute.
 * @returns {Float64Array} pmf indexed by score, length maxScore + 1.
 */
export function compoundPoissonPmf(lambda, severity, maxScore = MAX_SCORE) {
  const p = new Float64Array(maxScore + 1);
  p[0] = Math.exp(-lambda);
  for (let s = 1; s <= maxScore; s++) {
    let acc = 0;
    for (let i = 0; i < SEVERITY_VALUES.length; i++) {
      const v = SEVERITY_VALUES[i];
      if (v <= s) acc += v * severity[i] * p[s - v];
    }
    p[s] = (lambda / s) * acc;
  }
  return p;
}

/** Convolve a pmf with one more scoring event. Used to build the shock ladder. */
function convolveSeverity(p, severity, maxScore) {
  const out = new Float64Array(maxScore + 1);
  for (let s = 0; s <= maxScore; s++) {
    let acc = 0;
    for (let i = 0; i < SEVERITY_VALUES.length; i++) {
      const v = SEVERITY_VALUES[i];
      if (v <= s) acc += severity[i] * p[s - v];
    }
    out[s] = acc;
  }
  return out;
}

/**
 * The ladder g^(0..terms), where g^(c) is the score law given that exactly c of
 * the scoring events came from the shared shock.
 *
 * One extra rung beyond `terms` is always built, because the derivative of the
 * compound Poisson with respect to its rate is exactly the difference between
 * adjacent rungs — see `gameGradients`. Getting that rung for free is the whole
 * reason the gradient costs nothing.
 */
function shockLadder(lambda, severity, terms, maxScore) {
  const ladder = [compoundPoissonPmf(lambda, severity, maxScore)];
  for (let c = 1; c <= terms + 1; c++) {
    ladder.push(convolveSeverity(ladder[c - 1], severity, maxScore));
  }
  return ladder;
}

/** Poisson weights P(C = c) for c = 0..terms, renormalised over the truncation. */
function shockWeights(lambdaC, terms) {
  const w = new Float64Array(terms + 1);
  let acc = Math.exp(-lambdaC), total = 0;
  for (let c = 0; c <= terms; c++) {
    w[c] = acc;
    total += acc;
    acc *= lambdaC / (c + 1);
  }
  for (let c = 0; c <= terms; c++) w[c] /= total;
  return w;
}

/**
 * How many shared-shock terms are worth carrying at this rate.
 *
 * The cut is on the REMAINING TAIL, not on the size of one term. Cutting on the
 * term is the obvious mistake and it is what an earlier version did: the sum of
 * everything past term c is much larger than term c itself, so the mixture was
 * being renormalised over a tail of order 1e-9 and the bivariate-Poisson
 * identity held only to nine decimals instead of machine precision.
 *
 * Truncating adaptively is the single largest saving in the fit, because the
 * likelihood is evaluated a million times and this loop is its innermost.
 */
function adaptiveTerms(lambdaC, cap = SHOCK_TERMS) {
  let term = Math.exp(-lambdaC), cumulative = term;
  for (let c = 0; c < cap; c++) {
    if (1 - cumulative < 1e-16 && c >= 2) return c;
    term *= lambdaC / (c + 1);
    cumulative += term;
  }
  return cap;
}

/**
 * g^(c)(target) for c = 0..terms+1, without materialising the whole ladder.
 *
 * Each rung depends only on the one below it, so two rolling buffers suffice
 * and the caller keeps them across games. The straightforward version allocated
 * fourteen arrays per team per game, which at a million likelihood evaluations
 * is tens of millions of allocations and was measured to dominate the fit.
 */
function ladderValuesAt(lambda, severity, terms, target, bufA, bufB) {
  const len = target + 1;
  const values = new Float64Array(terms + 2);

  // Rung 0: the compound Poisson itself, by Panjer, written into bufA.
  bufA[0] = Math.exp(-lambda);
  for (let s = 1; s < len; s++) {
    let acc = 0;
    for (let i = 0; i < SEVERITY_VALUES.length; i++) {
      const v = SEVERITY_VALUES[i];
      if (v <= s) acc += v * severity[i] * bufA[s - v];
    }
    bufA[s] = (lambda / s) * acc;
  }
  values[0] = bufA[target];

  let prev = bufA, cur = bufB;
  for (let c = 1; c <= terms + 1; c++) {
    for (let s = 0; s < len; s++) {
      let acc = 0;
      for (let i = 0; i < SEVERITY_VALUES.length; i++) {
        const v = SEVERITY_VALUES[i];
        if (v <= s) acc += severity[i] * prev[s - v];
      }
      cur[s] = acc;
    }
    values[c] = cur[target];
    const swap = prev; prev = cur; cur = swap;
  }
  return values;
}

// Scratch buffers for `ladderValuesAt`. The module is synchronous and
// single-threaded, so two are enough and they are never held across a yield.
const SCRATCH_A = new Float64Array(MAX_SCORE + 1);
const SCRATCH_B = new Float64Array(MAX_SCORE + 1);
const SCRATCH_C = new Float64Array(MAX_SCORE + 1);
const SCRATCH_D = new Float64Array(MAX_SCORE + 1);

/* --------------------------------------------------------- the joint law */

/**
 * The full joint pmf over (home score, away score).
 *
 *   f(x, y) = sum_c P(C = c) * g_home^(c)(x) * g_away^(c)(y)
 *
 * Conditional on the shared shock the two scoreboards are independent, so the
 * joint is a finite mixture of products — which is what makes every derived
 * quantity below a single pass over one matrix instead of a simulation.
 *
 * @returns {{ matrix: Float64Array, size: number, at: (x, y) => number }}
 */
export function jointScorePmf(lambdaHome, lambdaAway, lambdaC, severity, {
  maxScore = MAX_SCORE, terms = SHOCK_TERMS
} = {}) {
  const size = maxScore + 1;
  const t = Math.min(terms, adaptiveTerms(lambdaC, terms));
  const weights = shockWeights(lambdaC, t);
  const home = shockLadder(lambdaHome, severity, t, maxScore);
  const away = shockLadder(lambdaAway, severity, t, maxScore);
  const matrix = new Float64Array(size * size);
  for (let c = 0; c <= t; c++) {
    const w = weights[c];
    if (w < 1e-14) continue;
    const gh = home[c], ga = away[c];
    for (let x = 0; x < size; x++) {
      const wx = w * gh[x];
      if (wx < 1e-16) continue;
      const base = x * size;
      for (let y = 0; y < size; y++) matrix[base + y] += wx * ga[y];
    }
  }
  return { matrix, size, at: (x, y) => matrix[x * size + y] };
}

/** Marginal, margin and total laws plus the moments, from one joint matrix. */
export function jointSummary(joint) {
  const { matrix, size } = joint;
  // Every pmf and moment below is computed on the grid RENORMALISED over its
  // own truncated mass. That is not cosmetic. Un-normalised, the covariance of
  // an exactly independent pair comes out at +0.076 rather than 0, because the
  // cross term and the product of the marginal means lose different amounts to
  // the truncation — which would have been reported as this model's same-game
  // correlation. `mass` is kept and returned as the diagnostic of how much grid
  // was cut, but nothing is scored against an improper distribution.
  const homeMarginal = new Float64Array(size);
  const awayMarginal = new Float64Array(size);
  const margin = new Float64Array(2 * size - 1);   // index = margin + (size - 1)
  const total = new Float64Array(2 * size - 1);
  let mass = 0;
  for (let x = 0; x < size; x++) {
    const base = x * size;
    for (let y = 0; y < size; y++) {
      const p = matrix[base + y];
      if (p <= 0) continue;
      homeMarginal[x] += p;
      awayMarginal[y] += p;
      margin[x - y + size - 1] += p;
      if (x + y < 2 * size - 1) total[x + y] += p;
      mass += p;
    }
  }
  if (mass > 0) {
    for (let i = 0; i < size; i++) { homeMarginal[i] /= mass; awayMarginal[i] /= mass; }
    for (let i = 0; i < margin.length; i++) { margin[i] /= mass; total[i] /= mass; }
  }
  const moments = pmf => {
    let m1 = 0, m2 = 0;
    for (let i = 0; i < pmf.length; i++) { m1 += i * pmf[i]; m2 += i * i * pmf[i]; }
    return { mean: m1, variance: Math.max(0, m2 - m1 * m1) };
  };
  const hm = moments(homeMarginal), am = moments(awayMarginal);
  let cross = 0;
  for (let x = 0; x < size; x++) {
    const base = x * size;
    for (let y = 0; y < size; y++) cross += x * y * matrix[base + y];
  }
  if (mass > 0) cross /= mass;
  const covariance = cross - hm.mean * am.mean;
  const marginMean = hm.mean - am.mean;
  let marginVar = 0;
  for (let i = 0; i < margin.length; i++) {
    const d = (i - (size - 1)) - marginMean;
    marginVar += d * d * margin[i];
  }
  return {
    mass,
    home_marginal: homeMarginal,
    away_marginal: awayMarginal,
    margin_pmf: margin,
    margin_offset: size - 1,
    total_pmf: total,
    home_mean: hm.mean, away_mean: am.mean,
    home_sd: Math.sqrt(hm.variance), away_sd: Math.sqrt(am.variance),
    covariance,
    correlation: hm.variance > 0 && am.variance > 0
      ? covariance / Math.sqrt(hm.variance * am.variance) : 0,
    margin_mean: marginMean,
    margin_sd: Math.sqrt(marginVar),
    total_mean: hm.mean + am.mean
  };
}

/**
 * P(home margin beats `handicap`), with pushes split, from a margin pmf.
 *
 * `handicap` is the number the home side must beat, i.e. minus the posted home
 * spread. A half-point line has no push mass and the split term is zero.
 */
export function coverProbabilityFromMargin(marginPmf, offset, handicap) {
  let over = 0, push = 0, mass = 0;
  for (let i = 0; i < marginPmf.length; i++) {
    const p = marginPmf[i];
    if (p <= 0) continue;
    const d = i - offset;
    mass += p;
    if (d > handicap) over += p;
    else if (d === handicap) push += p;
  }
  if (mass <= 0) return null;
  return (over + 0.5 * push) / mass;
}

/* --------------------------------------------------------------- the gradients */

/**
 * Log-likelihood of one observed game and the derivatives of that log-
 * likelihood with respect to log lambda_home and log lambda_away.
 *
 * The derivative identity that makes this cheap: for a compound Poisson with
 * rate lambda, d/d lambda P(s) = (q * P)(s) - P(s), and (q * P) is exactly the
 * next rung of the shock ladder. So
 *
 *   d f / d lambda_home = sum_c P(C=c) [ g_home^(c+1)(x) - g_home^(c)(x) ] g_away^(c)(y)
 *
 * and the ladder was already built. No finite differences, no extra passes.
 *
 * Only the observed cell is needed, so this allocates ladders truncated at the
 * observed score rather than at MAX_SCORE — which is where most of the fitting
 * time is saved, since a typical NFL score is 23 and not 80.
 */
export function gameGradients(homeScore, awayScore, lambdaHome, lambdaAway, lambdaC, severity, {
  terms = SHOCK_TERMS
} = {}) {
  const hMax = Math.max(0, Math.min(homeScore, MAX_SCORE));
  const aMax = Math.max(0, Math.min(awayScore, MAX_SCORE));
  const t = Math.min(terms, adaptiveTerms(lambdaC, terms));
  const weights = shockWeights(lambdaC, t);
  const home = ladderValuesAt(lambdaHome, severity, t, hMax, SCRATCH_A, SCRATCH_B);
  const away = ladderValuesAt(lambdaAway, severity, t, aMax, SCRATCH_C, SCRATCH_D);

  let f = 0, dHome = 0, dAway = 0;
  for (let c = 0; c <= t; c++) {
    const w = weights[c];
    if (w < 1e-14) continue;
    const gh = home[c], ga = away[c];
    f += w * gh * ga;
    dHome += w * (home[c + 1] - gh) * ga;
    dAway += w * gh * (away[c + 1] - ga);
  }
  const safe = Math.max(f, PROB_FLOOR);
  return {
    logLik: Math.log(safe),
    // d log f / d log lambda = lambda * (d f / d lambda) / f
    uHome: lambdaHome * dHome / safe,
    uAway: lambdaAway * dAway / safe
  };
}

/* ------------------------------------------------------------ the GAS recursion */

/**
 * The eight static parameters, in the unconstrained space Nelder-Mead searches.
 *
 * Every bounded quantity is carried through a link so the optimiser never has
 * to respect a constraint: rates are exponentials, persistences and the season
 * carryover are logistics.
 */
export const PARAM_NAMES = Object.freeze([
  'mu', 'eta', 'log_lambda_c', 'log_a_attack', 'logit_b_attack',
  'log_a_defence', 'logit_b_defence', 'logit_season_carry'
]);

export function unpackParams(theta) {
  return {
    mu: theta[0],
    eta: theta[1],
    lambdaC: Math.exp(theta[2]),
    aAttack: Math.exp(theta[3]),
    bAttack: logistic(theta[4]),
    aDefence: Math.exp(theta[5]),
    bDefence: logistic(theta[6]),
    seasonCarry: logistic(theta[7])
  };
}

export function packParams({ mu, eta, lambdaC, aAttack, bAttack, aDefence, bDefence, seasonCarry }) {
  return [mu, eta, Math.log(lambdaC), Math.log(aAttack), logit(bAttack),
    Math.log(aDefence), logit(bDefence), logit(seasonCarry)];
}

/**
 * How the raw score is scaled before it moves a state.
 *
 * GAS(1,1) scales the score by a power of the inverse information matrix. The
 * information for a log-rate Poisson is lambda, and the compound version's is
 * proportional to it, so the three options here are the standard
 * gamma = 0, 1/2, 1 family. Which one is right is an empirical question about
 * the data, so `fitJointScoreModel` fits all three and selects on TRAINING
 * log-likelihood — never on the held-out season.
 */
export const SCALINGS = Object.freeze(['unit', 'sqrt-inverse', 'inverse']);

function scaleScore(u, lambda, scaling) {
  if (scaling === 'inverse') return u / Math.max(lambda, 1e-6);
  if (scaling === 'sqrt-inverse') return u / Math.sqrt(Math.max(lambda, 1e-6));
  return u;
}

/**
 * Bound on a single scaled score before it is applied.
 *
 * Not decoration. An unbounded Poisson-family score is linear in the
 * observation, so one 59-7 blowout would jolt a rating by an amount no
 * subsequent game can undo. Harvey's DCS models bound the score by construction
 * through a fat-tailed observation density; the equivalent here, with a
 * light-tailed one, is an explicit clamp. It binds on well under 1% of games at
 * the fitted rates and its only effect is on the ones where it should.
 */
const SCORE_CLAMP = 12;

/**
 * Run the score-driven filter over a chronological list of games.
 *
 * Every game is predicted from the state BEFORE it and then updates that state,
 * which is what makes the whole pass a legitimate out-of-sample sequence rather
 * than a fit: no game contributes to its own forecast. `onPredict`, when given,
 * sees each game's pre-kickoff rates.
 *
 * @param {object[]} games  `{ season, week, home, away, home_score, away_score }`,
 *   chronological.
 * @returns {{ logLik, n, states, perGame }}
 */
export function runFilter(games, theta, severity, {
  scaling = 'unit', onPredict = null, states = null, collect = false
} = {}) {
  const p = unpackParams(theta);
  const attack = states?.attack instanceof Map ? new Map(states.attack) : new Map();
  const defence = states?.defence instanceof Map ? new Map(states.defence) : new Map();
  const played = states?.played instanceof Map ? new Map(states.played) : new Map();
  const get = (m, k) => m.get(k) ?? 0;

  let logLik = 0, n = 0, lastSeason = null;
  const perGame = collect ? [] : null;

  for (const g of games) {
    if (lastSeason != null && g.season !== lastSeason) {
      // Between seasons strengths regress toward the common level. Rosters turn
      // over; a team is not its January self in September. `seasonCarry` is
      // fitted, so the data says how much of a rating survives the offseason.
      for (const [k, v] of attack) attack.set(k, v * p.seasonCarry);
      for (const [k, v] of defence) defence.set(k, v * p.seasonCarry);
    }
    lastSeason = g.season;

    const lambdaHome = Math.exp(p.mu + (g.neutral ? 0 : p.eta) + get(attack, g.home) - get(defence, g.away));
    const lambdaAway = Math.exp(p.mu + get(attack, g.away) - get(defence, g.home));

    if (onPredict) onPredict(g, { lambdaHome, lambdaAway, lambdaC: p.lambdaC, severity });

    if (g.home_score == null || g.away_score == null) continue;

    const { logLik: ll, uHome, uAway } =
      gameGradients(g.home_score, g.away_score, lambdaHome, lambdaAway, p.lambdaC, severity);
    if (!Number.isFinite(ll)) continue;
    logLik += ll;
    n++;
    if (collect) perGame.push({ ...g, lambdaHome, lambdaAway, logLik: ll });

    const sHome = Math.max(-SCORE_CLAMP, Math.min(SCORE_CLAMP, scaleScore(uHome, lambdaHome, scaling)));
    const sAway = Math.max(-SCORE_CLAMP, Math.min(SCORE_CLAMP, scaleScore(uAway, lambdaAway, scaling)));

    // log lambda_home = mu + eta + a_home - d_away, so the home score pushes the
    // home attack up and the away defence down by the same amount, and likewise
    // mirrored. A defence that just conceded more than expected gets worse.
    attack.set(g.home, p.bAttack * get(attack, g.home) + p.aAttack * sHome);
    defence.set(g.away, p.bDefence * get(defence, g.away) - p.aDefence * sHome);
    attack.set(g.away, p.bAttack * get(attack, g.away) + p.aAttack * sAway);
    defence.set(g.home, p.bDefence * get(defence, g.home) - p.aDefence * sAway);
    played.set(g.home, get(played, g.home) + 1);
    played.set(g.away, get(played, g.away) + 1);
  }

  return { logLik, n, states: { attack, defence, played }, perGame };
}

/* ------------------------------------------------------------------ optimiser */

/**
 * Nelder-Mead. Deterministic, derivative-free, no dependency.
 *
 * Chosen over a gradient method deliberately: the analytic gradient of the
 * likelihood with respect to the STATIC parameters has to be propagated through
 * the whole filter recursion (every state at time t depends on every static
 * parameter through every earlier game), which is a far larger and more
 * error-prone piece of code than the eight-dimensional simplex search it would
 * accelerate. The per-game state gradients, which are the ones that matter for
 * the model itself, ARE analytic — see `gameGradients`.
 */
export function nelderMead(objective, start, {
  maxIterations = 1200, tolerance = 1e-7, step = 0.25
} = {}) {
  const n = start.length;
  const simplex = [start.slice()];
  for (let i = 0; i < n; i++) {
    const point = start.slice();
    point[i] += step * (Math.abs(point[i]) > 1e-8 ? Math.abs(point[i]) : 1);
    simplex.push(point);
  }
  let values = simplex.map(objective);
  let evaluations = simplex.length;

  const centroid = exclude => {
    const c = new Array(n).fill(0);
    for (let i = 0; i < simplex.length; i++) {
      if (i === exclude) continue;
      for (let j = 0; j < n; j++) c[j] += simplex[i][j];
    }
    return c.map(v => v / (simplex.length - 1));
  };

  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    const best = order[0], worst = order[n], second = order[n - 1];
    if (Math.abs(values[worst] - values[best]) <
        tolerance * (Math.abs(values[best]) + Math.abs(values[worst]) + tolerance)) break;

    const c = centroid(worst);
    const reflect = c.map((v, j) => v + (v - simplex[worst][j]));
    const fReflect = objective(reflect); evaluations++;

    if (fReflect < values[best]) {
      const expand = c.map((v, j) => v + 2 * (v - simplex[worst][j]));
      const fExpand = objective(expand); evaluations++;
      if (fExpand < fReflect) { simplex[worst] = expand; values[worst] = fExpand; }
      else { simplex[worst] = reflect; values[worst] = fReflect; }
    } else if (fReflect < values[second]) {
      simplex[worst] = reflect; values[worst] = fReflect;
    } else {
      const contract = c.map((v, j) => v + 0.5 * (simplex[worst][j] - v));
      const fContract = objective(contract); evaluations++;
      if (fContract < values[worst]) { simplex[worst] = contract; values[worst] = fContract; }
      else {
        for (let i = 0; i < simplex.length; i++) {
          if (i === best) continue;
          simplex[i] = simplex[i].map((v, j) => simplex[best][j] + 0.5 * (v - simplex[best][j]));
          values[i] = objective(simplex[i]); evaluations++;
        }
      }
    }
  }
  const bestIndex = values.indexOf(Math.min(...values));
  return { x: simplex[bestIndex], value: values[bestIndex], iterations, evaluations };
}

/* ------------------------------------------------------- severity estimation */

/**
 * Fit the scoring-event value distribution and a pooled rate to the marginal
 * distribution of team scores.
 *
 * TWO-STEP, AND THE COST OF THAT IS STATED. A full joint MLE would estimate the
 * severity weights alongside the dynamics, which is five more dimensions in the
 * simplex search and several times the fitting time. Instead the severity is
 * estimated first from the pooled marginal and then held fixed.
 *
 * The bias this introduces is known and one-directional: pooling every team's
 * scores mixes strong and weak offences together, so some BETWEEN-team variance
 * is absorbed into the severity distribution, which comes out slightly more
 * dispersed than the true within-team severity. The dynamic fit that follows
 * re-estimates mu and lambda_c against that fixed severity and recovers part of
 * it. The residual effect is a modestly over-wide score distribution, which
 * makes the model conservative rather than overconfident — the safer direction
 * for a distribution that would price bets.
 */
export function fitSeverity(scores, { maxIterations = 800 } = {}) {
  const usable = scores.filter(s => Number.isFinite(s) && s >= 0 && s <= MAX_SCORE);
  if (usable.length < 50) return { severity: DEFAULT_SEVERITY.slice(), lambda: null, n: usable.length, fitted: false };

  const counts = new Float64Array(MAX_SCORE + 1);
  for (const s of usable) counts[Math.round(s)]++;

  // Free parameters: log lambda, plus |SEVERITY_VALUES| - 1 logits (the first
  // value is the reference category, so the softmax is identified).
  const objective = theta => {
    const lambda = Math.exp(theta[0]);
    if (!Number.isFinite(lambda) || lambda <= 0 || lambda > 40) return 1e12;
    const severity = softmaxSeverity(theta.slice(1));
    const pmf = compoundPoissonPmf(lambda, severity, MAX_SCORE);
    let ll = 0;
    for (let s = 0; s <= MAX_SCORE; s++) {
      if (counts[s] > 0) ll += counts[s] * Math.log(Math.max(pmf[s], PROB_FLOOR));
    }
    return -ll;
  };

  const start = [Math.log(Math.max(mean(usable) / 5.2, 0.5)), ...DEFAULT_SEVERITY_LOGITS];
  const fit = nelderMead(objective, start, { maxIterations, step: 0.3 });
  return {
    severity: softmaxSeverity(fit.x.slice(1)),
    lambda: Math.exp(fit.x[0]),
    n: usable.length,
    negLogLik: fit.value,
    fitted: true
  };
}

/** Softmax over |SEVERITY_VALUES| - 1 free logits with the first value pinned to 0. */
export function softmaxSeverity(logits) {
  const full = [0, ...logits];
  const m = Math.max(...full);
  const e = full.map(v => Math.exp(v - m));
  const total = e.reduce((s, v) => s + v, 0);
  return e.map(v => v / total);
}

/**
 * A starting point for the severity search, and the fallback when there is not
 * enough data to fit one.
 *
 * These are rounded from the published shape of NFL scoring: touchdowns with
 * the kick are about half of all scoring events, field goals a bit over a
 * third, and the rest is small. They are a PRIOR, not a measurement from this
 * repository's data, and `fitSeverity` replaces them whenever it runs.
 */
export const DEFAULT_SEVERITY = Object.freeze([0.001, 0.022, 0.372, 0.041, 0.524, 0.040]);
const DEFAULT_SEVERITY_LOGITS = SEVERITY_VALUES.slice(1).map(
  (_, i) => Math.log(DEFAULT_SEVERITY[i + 1] / DEFAULT_SEVERITY[0]));

/* ----------------------------------------------------------------- the fit */

/** A sensible, data-free starting simplex vertex for the dynamic parameters. */
export function defaultStart() {
  return packParams({
    mu: Math.log(4.3),      // ~4.3 scoring events per team per game
    eta: 0.06,              // home field, on the log-rate scale
    lambdaC: 0.35,          // modest shared pace shock
    aAttack: 0.02, bAttack: 0.97,
    aDefence: 0.02, bDefence: 0.97,
    seasonCarry: 0.7
  });
}

/**
 * Fit the model: severity first, then the dynamics under each candidate
 * scaling, selecting on training log-likelihood.
 *
 * @param {object[]} games  Chronological training games. Every game in this
 *   list is used for fitting, so the CALLER is responsible for the cutoff.
 */
export function fitJointScoreModel(games, {
  scalings = SCALINGS, maxIterations = 900, severity = null, restarts = 1
} = {}) {
  const chronological = [...games].sort((a, b) => a.season - b.season || a.week - b.week);
  const scores = [];
  for (const g of chronological) {
    if (g.home_score != null) scores.push(g.home_score);
    if (g.away_score != null) scores.push(g.away_score);
  }
  const severityFit = severity ? { severity, fitted: false, supplied: true } : fitSeverity(scores);
  const q = severityFit.severity;

  let best = null;
  for (const scaling of scalings) {
    for (let r = 0; r < restarts; r++) {
      const start = defaultStart().map((v, i) => (r === 0 ? v : v + (((i * 7 + r * 13) % 11) - 5) * 0.03));
      const objective = theta => {
        if (theta.some(v => !Number.isFinite(v))) return 1e12;
        const p = unpackParams(theta);
        if (p.lambdaC > 4 || p.aAttack > 2 || p.aDefence > 2) return 1e12;
        if (!Number.isFinite(Math.exp(p.mu)) || Math.exp(p.mu) > 40) return 1e12;
        const { logLik, n } = runFilter(chronological, theta, q, { scaling });
        return n > 0 ? -logLik : 1e12;
      };
      const fit = nelderMead(objective, start, { maxIterations, step: 0.2 });
      if (!best || fit.value < best.negLogLik) {
        best = { theta: fit.x, negLogLik: fit.value, scaling, iterations: fit.iterations, evaluations: fit.evaluations };
      }
    }
  }

  const final = runFilter(chronological, best.theta, q, { scaling: best.scaling });
  return {
    version: JOINT_SCORE_VERSION,
    theta: best.theta,
    params: unpackParams(best.theta),
    scaling: best.scaling,
    severity: q,
    severity_fit: severityFit,
    train_log_lik: -best.negLogLik,
    train_games: final.n,
    train_log_lik_per_game: final.n ? -best.negLogLik / final.n : null,
    states: final.states,
    optimiser: { iterations: best.iterations, evaluations: best.evaluations }
  };
}

/**
 * Forecast one game from a fitted model and a state snapshot.
 *
 * Returns the whole joint object, which is the point of the exercise: the
 * margin, the total, the cover probability and the same-game correlation are
 * all read off one matrix rather than assumed or assembled from separate
 * models.
 */
export function forecastGame(model, home, away, { neutral = false, states = null, maxScore = 60 } = {}) {
  const p = model.params;
  const s = states ?? model.states;
  const a = k => s.attack.get(k) ?? 0;
  const d = k => s.defence.get(k) ?? 0;
  const lambdaHome = Math.exp(p.mu + (neutral ? 0 : p.eta) + a(home) - d(away));
  const lambdaAway = Math.exp(p.mu + a(away) - d(home));
  const joint = jointScorePmf(lambdaHome, lambdaAway, p.lambdaC, model.severity, { maxScore });
  const summary = jointSummary(joint);
  return { home, away, lambdaHome, lambdaAway, lambdaC: p.lambdaC, joint, ...summary };
}

/**
 * The honest reading of stage 3's evidence, in the form the rest of this
 * repository already uses for a model that was built and then not shipped
 * (compare `MARGIN_MODEL_VERDICT` in betting/nfl/strategy/margin-distribution.js).
 *
 * It is here rather than only in the markdown so that anyone who reaches for
 * this module from code meets the gate result before they wire it to anything.
 */
export const JOINT_SCORE_VERDICT = Object.freeze({
  version: JOINT_SCORE_VERSION,
  evidence: 'docs/evidence/2026-09-12/JOINT-SCORING-STAGE-3.md',

  use_as_margin_forecaster: false,
  use_as_joint_score_distribution: 'only on data whose scoreboard is checked first',

  headline:
    'Does NOT clear the stated walk-forward/CRPS gate against the champion. Standalone it loses '
    + 'on CRPS on both fixtures (7.4961 vs 7.4703 football; 6.1387 vs 5.5598 Gaussian). '
    + 'Market-anchored it is better on four of five metrics, two at raw p < 0.05, and Holm '
    + 'correction across the five kills both — the smallest p of 0.0434 does not clear 0.01.',

  the_result_that_holds:
    'Switching the shared scoring-event shock on beats switching it off on the JOINT log score '
    + 'by DM* -5.995, p < 0.0001, on 408 held-out games. Same-game dependence is real and '
    + 'modelling it pays for joint questions (teasers, same-game parlays). The champion cannot '
    + 'be compared on that loss at all, because nothing else in this tree emits a joint score '
    + 'distribution.',

  known_miscalibration:
    'Average implied same-game correlation is +0.178 against +0.097 realised — it OVERSTATES '
    + 'dependence by roughly 1.8x, so a correlated parlay priced off it would over-correlate '
    + 'the legs. Suspected cause is the two-step severity estimator; the fix is a joint MLE '
    + 'over severity and dynamics together.',

  set_lambda_c_to_zero_for_margins:
    'The shared shock widens the margin as well as the total (shared events draw independent '
    + 'values, so unlike the textbook bivariate Poisson it does not cancel). It costs about '
    + '0.005 of margin CRPS at p = 0.066. For margin-only use, turn it off.',

  all_numbers_are_synthetic:
    'Both runs are on a synthetic fixture; the only populated database was out of reach. The '
    + 'football-scoring fixture shares a family with this model, so its results are a control '
    + 'that the machinery works, NOT evidence about football. Run the report without --fixture '
    + 'against real history before treating any of this as a fact about the NFL.'
});
