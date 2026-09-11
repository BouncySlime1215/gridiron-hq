/**
 * P(margin | spread) for the NFL, fitted — the distribution the teaser work
 * has been summarising rather than modelling.
 *
 * `teaser-leg-rates.js` prices a leg by empirical lookup: count the historical
 * outcomes at each of eight posted lines, pool them, done. That is honest and
 * it is the number the scanner uses. It is also weak in three specific ways.
 * It answers only for those eight lines and only for six points, so a 6.5-point
 * tease or a line of -9 has no answer at all. Its only uncertainty is binomial
 * on the cell count, so +2.0 (n=169) gets a wide interval and +3.0 (n=1,124) a
 * narrow one with no strength shared between them even though they describe the
 * same football. And it throws away the object that generated those counts —
 * the margin distribution — keeping only a summary of it.
 *
 * This module fits the object. With P(margin | spread) in hand every teaser
 * question is an integral over a set of integers, uncertainty propagates from
 * fitted parameters rather than from one cell's count, and the same fit answers
 * questions nobody has asked yet.
 *
 * READ `MARGIN_MODEL_VERDICT` BEFORE USING THIS FOR THE CROSS-BOTH FAMILY.
 * The headline result of building it is a negative one, measured below and
 * asserted in `test/margin-distribution.test.js`: on the eight lines the
 * scanner actually bets, this model is BEATEN out of sample by the empirical
 * lookup it was meant to replace. It wins clearly everywhere else. Both halves
 * of that are load-bearing and both are reported.
 *
 * ===========================================================================
 * THE FIVE MODELLING DECISIONS
 * ===========================================================================
 *
 * 1. DISCRETE OVER INTEGER MARGINS, NOT A SMOOTHED CONTINUUM.
 *
 * Measured here on 6,991 games (1999-2024, both sides of each game, one game
 * counted once): margin 3 at 15.08%, 7 at 9.03%, 6 at 6.08%, 10 at 5.59%,
 * 14 at 4.92%, 4 at 4.81%. A continuous fit that smooths across 3 and 7 is not
 * approximately right for this application, it is wrong in exactly the place
 * the application lives — the entire teaser argument is that six points spent
 * crossing 3 and 7 buy about a quarter of the distribution. So the model is a
 * probability mass function over integer margins and the atoms are free
 * parameters, not consequences of a shape.
 *
 * 2. CONDITIONING: EXPONENTIAL TILT AT FIXED MARGINS, NOT A SHIFTED RESIDUAL.
 *
 * The naive approach models `margin - spread` as a residual with one shape and
 * slides it along. That is wrong for the same reason the same mistake was wrong
 * in `nfl-execution-edge.js` (see its C05 note): key numbers sit at fixed
 * MARGINS, not at fixed residuals. The mass at 3 is at 3 whether the line is -1
 * or -9, and a shifted residual drags it to wherever the line happens to be.
 *
 * The data says so plainly. Conditional modal margins, favourite's view:
 *
 *     |spread| in [1,3]     3 (8.6%)  -3 (7.4%)   7 (5.1%)
 *     |spread| in [3.5,6]   3 (9.6%)  -3 (7.0%)   7 (5.5%)  10 (4.9%)
 *     |spread| in [6.5,9]   3 (8.7%)   7 (6.5%)  -3 (5.2%)  14 (3.7%)
 *     |spread| in [9.5,30]  3 (7.8%)  14 (5.6%)   7 (5.5%)  10 (4.3%)
 *
 * Margin 3 is the modal outcome at every line size in the book, including
 * double-digit favourites where a shifted-residual model would put the mode
 * near 12. The spikes do not move.
 *
 * So the spread enters as an exponential TILT on a fixed base:
 *
 *     P(m | s)  proportional to  kappa(m) * exp( tilt(s) * m + ... )
 *
 * `kappa(m)` is the pick'em shape — free atoms at every |m| up to ATOM_MAX over
 * a smooth envelope — and it never moves. The spread only reweights it toward
 * the favoured side. This is the Esscher transform, and it is the structurally
 * correct answer to "how does a lumpy distribution respond to a line?": the
 * lumps stay where they are and their relative heights change.
 *
 * 3. SHARING STRENGTH ACROSS LINES: A PENALISED SPLINE IN |spread|, NOT EIGHT
 *    INDEPENDENT CELLS.
 *
 * Two mechanisms, both deliberate.
 *
 * The first is structural and does most of the work: every line shares one
 * base `kappa` and one tilt function, so a line with 93 legs is not estimated
 * from 93 legs. It contributes 93 legs of evidence about a tilt function that
 * 6,991 games are estimating jointly. That is the hierarchy.
 *
 * The second is explicit. The tilt is a linear spline in |spread| on the knots
 * in `DEFAULT_TILT_KNOTS`, penalised by the squared second differences of its
 * knot values. The null space of that penalty is "tilt linear in |spread|", so
 * the smoothing parameter interpolates between a per-line free tilt (lambda
 * -> 0) and a single market-efficiency slope (lambda -> infinity), and the data
 * chooses where to sit. Season-blocked 5-fold cross-validation over 1999-2024
 * chose the smooth end decisively:
 *
 *     lambda        1e2       1e4       1e5       1e6       1e7
 *     CV logL/game  -3.84631  -3.84499  -3.84489  -3.84483  -3.84499
 *
 * flat from 1e4 to 1e7 with the optimum at 1e6. Read that as: the line-by-line
 * wobble in the conditional mean does not predict a held-out season. It is the
 * same conclusion `teaser-leg-rates.js` reaches by chi-square on the family,
 * arrived at from the whole line spectrum instead of eight cells.
 *
 * The atoms get an independent ridge (`atomRidge`), which is the random-effect
 * prior log kappa_j ~ N(0, tau^2): margin 3 with 1,054 games is untouched by
 * it, margin 41 with three is pulled back to the envelope. CV chose 1.
 *
 * 4. UNCERTAINTY: LAPLACE POSTERIOR WITH A SANDWICH COVARIANCE, PROPAGATED BY
 *    DRAWS.
 *
 * The fit is a penalised conditional-logit MLE, which is strictly concave, so
 * the penalised Hessian at the optimum is a legitimate curvature. Parameter
 * covariance is the sandwich H^-1 J H^-1 with H the penalised Hessian and
 * J = sum_i w_i^2 Cov_i the weighted meat — not the naive H^-1, because the
 * season weights in decision 5 are unequal and the naive form would misstate
 * the effective sample size in both directions depending on the half-life.
 *
 * `probabilityInterval` draws parameters from that Gaussian and pushes each
 * draw through whatever functional the caller names, so the interval on a
 * teaser leg is the interval on the FIT, not a binomial interval on a cell.
 * The sampler is seeded and deterministic.
 *
 * ONE OBSERVATION IS ONE GAME, NOT TWO LEGS. `game_lines` stores both sides of
 * every game and the two rows are exact mirrors — same spread negated, same
 * margin negated, verified on all 6,991 games. Because the model is built to
 * satisfy P(m | s) = P(-m | -s) exactly, fitting on both rows gives literally
 * the same theta as fitting on one and exactly twice the curvature, which would
 * halve every standard error on a fixed amount of football. So the fit takes
 * one row per game (the favourite's view) and says so in its diagnostics.
 *
 * 5. ERA DRIFT: WEIGHT RECENT SEASONS, HALF-LIFE 6 SEASONS.
 *
 * The drift is real but modest. P(|margin| in {3,7}) by era, measured here:
 *
 *     1999-2011  25.41% (n=3,447)     2012-2024  22.83% (n=3,544)
 *     difference -2.59pp, z = -2.53;  linear trend -0.17pp/season, score z = -1.56
 *
 * Consistent with the 2015 extra-point move and the overtime changes, and too
 * small and too noisy to model as a parametric trend on 26 seasons — a fitted
 * slope on a z = -1.56 trend is mostly fitting the trend's own error.
 *
 * The choice between the three options was made by walk-forward test rather
 * than by taste. Refit on every prior season, predict the next, 2007 through
 * 2024, held-out margin-pmf log-likelihood per game:
 *
 *     half-life   3        5        6        8       10       16       24    none
 *     logL/game  -3.85821 -3.85661 -3.85648 -3.85654 -3.85671 -3.85716 -3.85750 -3.85840
 *
 * A smooth optimum at 5-8 seasons, better than both "hold it fixed" (none) and
 * aggressive down-weighting. Holding it fixed is the worst of the three. So the
 * default is `DEFAULT_SEASON_HALF_LIFE = 6`, and `Infinity` is supported and is
 * what the like-for-like reproduction check in the test suite uses, because the
 * empirical numbers it reproduces are themselves unweighted 1999-2024.
 *
 * ===========================================================================
 * THE SEASONS
 * ===========================================================================
 *
 * 1999-2024 only, with 2025 and 2026 excluded, for exactly the reason and by
 * exactly the constants `teaser-leg-rates.js` establishes: `game_lines.spread`
 * is corrupted in both seasons (integer share 47.7% -> 24.9% -> 16.2%, and the
 * -8.0 and +2.0 buckets are empty outright). Those constants are imported
 * rather than restated so the two modules cannot drift apart.
 *
 * ===========================================================================
 * PERFORMANCE
 * ===========================================================================
 *
 * One pass over ~14,000 `game_lines` rows, then Newton on ~60 parameters with
 * analytic gradient and Hessian, tallied by distinct spread so each iteration
 * costs 87 groups x 181 support points rather than 7,000 games x 181. Seven
 * iterations, about 60 ms, cached in module scope for the life of the process.
 * Nothing here writes to the database. `clearMarginModelCache()` exists for the
 * same reason `clearRateCache` does in the sibling module.
 */
import { rows } from '../../../db/index.js';
import {
  MEASUREMENT_SEASONS, EXCLUDED_SEASONS, EXCLUSION_REASON,
  CROSS_BOTH_LINES, TEASER_POINTS
} from './teaser-leg-rates.js';

export const MARGIN_MODEL_VERSION = 'nfl-margin-distribution-v1';

export { MEASUREMENT_SEASONS, EXCLUDED_SEASONS, EXCLUSION_REASON, CROSS_BOTH_LINES };

/* ========================================================== the model spec */

/**
 * The integer margins the pmf is defined over.
 *
 * The largest margin in 1999-2024 is 59. +/-90 leaves the normalising sum room
 * to be a sum rather than a truncation even for a 27-point favourite, and 181
 * support points cost nothing.
 */
export const MARGIN_SUPPORT = Object.freeze({ min: -90, max: 90 });
const SUPPORT_SIZE = MARGIN_SUPPORT.max - MARGIN_SUPPORT.min + 1;

/**
 * Free atoms out to |margin| = 42, a smooth envelope beyond it.
 *
 * 42 covers 99.6% of games (29 of 6,991 land outside it). Cross-validated
 * held-out log-likelihood is flat from 42 upward (-3.84483 at 42, -3.84472 at
 * 48) and falls off below it (-3.84606 at 36, -3.85177 at 28), which is the
 * envelope being asked to do work the data would rather do itself.
 */
export const ATOM_MAX = 42;

/**
 * Knots for the tilt spline, in |spread|.
 *
 * Dense where the market posts lines (every point out to 12), sparse past it.
 * Beyond the last knot the tilt extrapolates linearly off the last two, so a
 * -30 line that has never been posted still gets a finite, monotone answer
 * rather than an extrapolated exponential.
 */
export const DEFAULT_TILT_KNOTS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 17, 21, 27]);

/**
 * Chosen by season-blocked 5-fold CV over 1999-2024, not by taste. See the
 * header. `globalRidge` is numerical hygiene only and is six orders of
 * magnitude below anything that could bend a coefficient.
 */
export const DEFAULT_PENALTIES = Object.freeze({
  atomRidge: 1,
  tiltRoughness: 1e6,
  globalRidge: 1e-9
});

/** Seasons, exponentially. See decision 5. `Infinity` means unweighted. */
export const DEFAULT_SEASON_HALF_LIFE = 6;

/**
 * The design vector, and why every term in it is symmetric.
 *
 * `game_lines` holds both sides of every game, so the population this model
 * describes is EXACTLY symmetric under (margin, spread) -> (-margin, -spread).
 * Every basis function below is invariant under that flip, which makes
 * P(m | s) = P(-m | -s) an identity of the model rather than something that
 * has to be checked afterwards. That is not decoration: it is what guarantees
 * the favourite's and the underdog's prices on one game reconcile, which is
 * precisely the defect `nfl-execution-edge.js` had to be corrected for.
 *
 *   m2, absm        the smooth envelope: a Gaussian core with an exponential
 *                   correction, carrying the tail past ATOM_MAX
 *   atom_j          free mass at |margin| = j. THE KEY NUMBERS LIVE HERE, at
 *                   fixed margins, and nothing involving the spread can move
 *                   them
 *   tilt@k          hat basis in |spread|, multiplied by -sign(spread) * margin.
 *                   The exponential tilt: it reweights the base toward the
 *                   favoured side without shifting it
 *   sign_tilt       -sign(spread) * sign(margin) * |spread|. The extra
 *                   probability that the better team simply WINS, over and
 *                   above what tilting the margin scale implies. Adding it is
 *                   a likelihood-ratio chi-square of 20.6 on 1 df (p = 6e-6)
 *                   and it is the single largest specification improvement
 *                   found; see SPECIFICATION SEARCH below
 *   abss_m2         |spread| * margin^2: lets the conditional variance shrink
 *                   as the line grows. Fitted near zero; kept because it is
 *                   one parameter and its absence would be an assumption
 *
 * SPECIFICATION SEARCH. Two richer alternatives were fitted and rejected on
 * cross-validated held-out likelihood, not on aesthetics:
 *
 *   extra tilt at key numbers {3,7}             CV -3.84512 (vs -3.84483)
 *   extra tilt at {1,2,3,4,6,7,10,14}           CV -3.84596
 *
 * Both are worse than the accepted spec once `sign_tilt` is in. Fitted on their
 * own their coefficients came out uniformly positive and roughly equal across
 * all eight margins (0.014 to 0.022) — which is not a key-number effect at all,
 * it is one step at margin zero wearing eight parameters. `sign_tilt` is that
 * step, spelled correctly, for one parameter.
 */
function buildSpec({ atomMax = ATOM_MAX, tiltKnots = DEFAULT_TILT_KNOTS } = {}) {
  const knots = [...tiltKnots];
  if (!knots.length || knots.some(k => !Number.isFinite(k) || k <= 0)) {
    throw new TypeError('tiltKnots must be a non-empty list of positive |spread| values');
  }
  for (let i = 1; i < knots.length; i++) {
    if (knots[i] <= knots[i - 1]) throw new TypeError('tiltKnots must be strictly increasing');
  }
  if (!Number.isInteger(atomMax) || atomMax < 1) throw new TypeError('atomMax must be a positive integer');

  const names = ['m2', 'absm'];
  const atom0 = names.length;
  for (let j = 0; j <= atomMax; j++) names.push(`atom${j}`);
  const tilt0 = names.length;
  for (const k of knots) names.push(`tilt@${k}`);
  const tiltEnd = names.length - 1;
  const signTilt = names.length; names.push('sign_tilt');
  const varIdx = names.length; names.push('abss_m2');

  return Object.freeze({
    atomMax, knots: Object.freeze(knots), names: Object.freeze(names),
    dimension: names.length, atom0, atomEnd: atom0 + atomMax, tilt0, tiltEnd, signTilt, varIdx
  });
}

/** The hat (linear B-spline) basis in |spread|, zero at |spread| = 0 by symmetry. */
function tiltBasis(knots, absSpread, out, offset) {
  const K = knots.length;
  if (absSpread <= 0) return;
  if (absSpread <= knots[0]) { out[offset] = absSpread / knots[0]; return; }
  for (let k = 0; k < K - 1; k++) {
    if (absSpread <= knots[k + 1]) {
      const t = (absSpread - knots[k]) / (knots[k + 1] - knots[k]);
      out[offset + k] = 1 - t;
      out[offset + k + 1] = t;
      return;
    }
  }
  // Past the last knot: extrapolate linearly off the final segment.
  const t = (absSpread - knots[K - 2]) / (knots[K - 1] - knots[K - 2]);
  out[offset + K - 2] = 1 - t;
  out[offset + K - 1] = t;
}

function designVector(spec, margin, spread, out) {
  out.fill(0);
  const am = Math.abs(margin);
  const as = Math.abs(spread);
  const ss = Math.sign(spread);
  out[0] = margin * margin;
  out[1] = am;
  if (am <= spec.atomMax) out[spec.atom0 + am] = 1;
  if (as > 0) {
    tiltBasis(spec.knots, as, out, spec.tilt0);
    for (let k = spec.tilt0; k <= spec.tiltEnd; k++) if (out[k] !== 0) out[k] *= -ss * margin;
  }
  out[spec.signTilt] = -ss * Math.sign(margin) * as;
  out[spec.varIdx] = as * margin * margin;
  return out;
}

/* ============================================================ linear algebra */

function cholesky(A, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(s > 0)) return null;
        L[i * n + i] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  }
  return L;
}

/** Solve (L L^T) x = b for lower-triangular L. */
function cholSolve(L, b, n) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

function cholInverse(L, n) {
  const inv = new Float64Array(n * n);
  const e = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    e.fill(0); e[j] = 1;
    const c = cholSolve(L, e, n);
    for (let i = 0; i < n; i++) inv[i * n + j] = c[i];
  }
  return inv;
}

function matMul(A, B, n) {
  const C = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const a = A[i * n + k];
      if (a === 0) continue;
      for (let j = 0; j < n; j++) C[i * n + j] += a * B[k * n + j];
    }
  }
  return C;
}

/* ================================================================ statistics */

/** Deterministic, seeded, so an interval is reproducible run to run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormals(rng, n) {
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let u = 0;
    while (u === 0) u = rng();
    z[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }
  return z;
}

/** Regularised lower incomplete gamma P(a, x), series + continued fraction. */
function lowerGamma(a, x) {
  if (x <= 0) return 0;
  const lg = logGamma(a);
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let i = 0; i < 500; i++) {
      ap += 1; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lg);
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lg) * h;
}

function logGamma(z) {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const zz = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (zz + i + 1);
  const t = zz + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Upper tail of a chi-square: P(X > x). */
export function chiSquareSurvival(x, df) {
  if (!(x > 0)) return 1;
  if (!(df > 0)) return NaN;
  return 1 - lowerGamma(df / 2, x / 2);
}

/** Two-sided normal tail. */
export function normalTwoSided(z) {
  const a = Math.abs(z) / Math.SQRT2;
  // erfc via the incomplete gamma already present
  const erfc = a < 1e-12 ? 1 : 1 - lowerGamma(0.5, a * a);
  return erfc;
}

/* ================================================================ the data */

/**
 * One row per game, from the favourite's point of view.
 *
 * `game_lines` holds both sides; the two are exact mirrors (verified: on all
 * 6,991 games in 1999-2024 the spreads negate and the margins negate, with no
 * game holding one row or three). Keeping both would double the curvature of a
 * likelihood that has not gained a single new game, so the pair is collapsed
 * here — deterministically, by taking the lower spread and breaking a pick'em
 * tie on team name — and `oneSidedGames` records any game that arrived with
 * only one row so a future data defect cannot hide inside this reduction.
 */
export function loadGames({ from = MEASUREMENT_SEASONS.from, to = MEASUREMENT_SEASONS.to, query = rows } = {}) {
  const legs = query(
    `SELECT season, week, team, opponent, spread, team_score, opp_score
       FROM game_lines
      WHERE spread IS NOT NULL AND team_score IS NOT NULL AND opp_score IS NOT NULL
        AND season BETWEEN ? AND ?`,
    from, to);

  const byGame = new Map();
  const seenSides = new Map();
  for (const leg of legs) {
    const key = `${leg.season}|${leg.week}|${[leg.team, leg.opponent ?? ''].sort().join('@')}`;
    seenSides.set(key, (seenSides.get(key) ?? 0) + 1);
    const candidate = {
      season: leg.season,
      week: leg.week,
      spread: leg.spread,
      margin: leg.team_score - leg.opp_score,
      team: leg.team
    };
    const held = byGame.get(key);
    if (!held) { byGame.set(key, candidate); continue; }
    if (candidate.spread < held.spread) { byGame.set(key, candidate); continue; }
    if (candidate.spread === held.spread && String(candidate.team) < String(held.team)) {
      byGame.set(key, candidate);
    }
  }

  let oneSided = 0;
  for (const count of seenSides.values()) if (count === 1) oneSided++;

  const games = [...byGame.values()];
  let outsideSupport = 0;
  for (const g of games) {
    if (g.margin < MARGIN_SUPPORT.min || g.margin > MARGIN_SUPPORT.max) outsideSupport++;
  }
  return { games, legs: legs.length, oneSidedGames: oneSided, outsideSupport };
}

/** Exponential season weights. `Infinity` (or null) means every season counts once. */
function seasonWeight(season, referenceSeason, halfLife) {
  if (halfLife == null || !Number.isFinite(halfLife)) return 1;
  if (!(halfLife > 0)) throw new TypeError('seasonHalfLife must be positive, or Infinity for unweighted');
  return Math.pow(0.5, (referenceSeason - season) / halfLife);
}

/**
 * Tally by distinct spread.
 *
 * Every game with the same posted line shares one conditional distribution, so
 * the likelihood, its gradient and its Hessian all depend on the data only
 * through per-line weighted margin counts. There are 87 distinct spreads and
 * ~7,000 games, so this is the difference between a 10 ms Newton step and a
 * 4 s one. `weightSquares` is carried alongside because the sandwich in
 * `fitMarginModel` needs sum(w^2), not just sum(w).
 */
function groupBySpread(spec, games, { referenceSeason, halfLife }) {
  const buckets = new Map();
  let weightSum = 0;
  let weightSquareSum = 0;
  for (const g of games) {
    if (g.margin < MARGIN_SUPPORT.min || g.margin > MARGIN_SUPPORT.max) continue;
    const w = seasonWeight(g.season, referenceSeason, halfLife);
    let b = buckets.get(g.spread);
    if (!b) { b = { spread: g.spread, counts: new Map(), weight: 0, weightSquares: 0 }; buckets.set(g.spread, b); }
    b.counts.set(g.margin, (b.counts.get(g.margin) ?? 0) + w);
    b.weight += w;
    b.weightSquares += w * w;
    weightSum += w;
    weightSquareSum += w * w;
  }

  const D = spec.dimension;
  const scratch = new Float64Array(D);
  const groups = [];
  for (const b of buckets.values()) {
    const X = new Float64Array(SUPPORT_SIZE * D);
    for (let i = 0; i < SUPPORT_SIZE; i++) {
      designVector(spec, i + MARGIN_SUPPORT.min, b.spread, scratch);
      X.set(scratch, i * D);
    }
    const sufficient = new Float64Array(D);
    for (const [m, c] of b.counts) {
      const off = (m - MARGIN_SUPPORT.min) * D;
      for (let k = 0; k < D; k++) sufficient[k] += c * X[off + k];
    }
    groups.push({ spread: b.spread, weight: b.weight, weightSquares: b.weightSquares, counts: b.counts, X, sufficient });
  }
  groups.sort((a, b) => a.spread - b.spread);
  return { groups, weightSum, weightSquareSum };
}

function penaltyMatrix(spec, { atomRidge, tiltRoughness, globalRidge }) {
  const D = spec.dimension;
  const P = new Float64Array(D * D);
  for (let k = 0; k < D; k++) P[k * D + k] += globalRidge;
  for (let k = spec.atom0; k <= spec.atomEnd; k++) P[k * D + k] += atomRidge;
  const knots = spec.knots;
  for (let k = 0; k + 2 < knots.length; k++) {
    const h1 = knots[k + 1] - knots[k];
    const h2 = knots[k + 2] - knots[k + 1];
    const c = [1 / h1, -(1 / h1 + 1 / h2), 1 / h2];
    const idx = [spec.tilt0 + k, spec.tilt0 + k + 1, spec.tilt0 + k + 2];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) P[idx[a] * D + idx[b]] += tiltRoughness * c[a] * c[b];
    }
  }
  return P;
}

/**
 * Penalised log-likelihood, its gradient and its Hessian.
 *
 * This is a conditional logit: log P(m | s) = theta . x(m, s) - log Z(s), so
 * the gradient is (observed sufficient statistic - expected) and the Hessian
 * is minus the weighted sum of within-line covariances of x. Both are exact,
 * which is why Newton converges in seven steps and why the curvature at the
 * optimum can be trusted as a curvature rather than a finite difference.
 */
function evaluate(spec, theta, groups, P, wantHessian) {
  const D = spec.dimension;
  const p = new Float64Array(SUPPORT_SIZE);
  const Ex = new Float64Array(D);
  const grad = new Float64Array(D);
  const hess = wantHessian ? new Float64Array(D * D) : null;
  let logLik = 0;

  for (const g of groups) {
    let max = -Infinity;
    for (let i = 0; i < SUPPORT_SIZE; i++) {
      let e = 0;
      const off = i * D;
      for (let k = 0; k < D; k++) { const x = g.X[off + k]; if (x !== 0) e += theta[k] * x; }
      p[i] = e;
      if (e > max) max = e;
    }
    let z = 0;
    for (let i = 0; i < SUPPORT_SIZE; i++) { p[i] = Math.exp(p[i] - max); z += p[i]; }
    const logZ = Math.log(z) + max;
    for (let i = 0; i < SUPPORT_SIZE; i++) p[i] /= z;

    for (let k = 0; k < D; k++) logLik += theta[k] * g.sufficient[k];
    logLik -= g.weight * logZ;

    Ex.fill(0);
    for (let i = 0; i < SUPPORT_SIZE; i++) {
      const pi = p[i];
      if (pi < 1e-15) continue;
      const off = i * D;
      for (let k = 0; k < D; k++) { const x = g.X[off + k]; if (x !== 0) Ex[k] += pi * x; }
    }
    for (let k = 0; k < D; k++) grad[k] += g.sufficient[k] - g.weight * Ex[k];

    if (wantHessian) {
      for (let i = 0; i < SUPPORT_SIZE; i++) {
        const pi = p[i];
        if (pi < 1e-15) continue;
        const off = i * D;
        for (let a = 0; a < D; a++) {
          const xa = g.X[off + a];
          if (xa === 0) continue;
          const w = g.weight * pi * xa;
          for (let b = a; b < D; b++) { const xb = g.X[off + b]; if (xb !== 0) hess[a * D + b] -= w * xb; }
        }
      }
      for (let a = 0; a < D; a++) {
        const ea = g.weight * Ex[a];
        if (ea === 0) continue;
        for (let b = a; b < D; b++) hess[a * D + b] += ea * Ex[b];
      }
    }
  }

  let quad = 0;
  for (let a = 0; a < D; a++) {
    let q = 0;
    for (let b = 0; b < D; b++) q += P[a * D + b] * theta[b];
    grad[a] -= 2 * q;
    quad += theta[a] * q;
  }
  const penalised = logLik - quad;

  if (wantHessian) {
    for (let a = 0; a < D; a++) for (let b = 0; b < a; b++) hess[a * D + b] = hess[b * D + a];
    for (let a = 0; a < D; a++) for (let b = 0; b < D; b++) hess[a * D + b] -= 2 * P[a * D + b];
  }
  return { logLik, penalised, grad, hess };
}

/** The sandwich meat: J = sum_i w_i^2 Cov_i, weighted by SQUARED weights. */
function meatMatrix(spec, theta, groups) {
  const D = spec.dimension;
  const J = new Float64Array(D * D);
  const p = new Float64Array(SUPPORT_SIZE);
  const Ex = new Float64Array(D);
  for (const g of groups) {
    let max = -Infinity;
    for (let i = 0; i < SUPPORT_SIZE; i++) {
      let e = 0;
      const off = i * D;
      for (let k = 0; k < D; k++) { const x = g.X[off + k]; if (x !== 0) e += theta[k] * x; }
      p[i] = e;
      if (e > max) max = e;
    }
    let z = 0;
    for (let i = 0; i < SUPPORT_SIZE; i++) { p[i] = Math.exp(p[i] - max); z += p[i]; }
    for (let i = 0; i < SUPPORT_SIZE; i++) p[i] /= z;
    Ex.fill(0);
    for (let i = 0; i < SUPPORT_SIZE; i++) {
      const pi = p[i];
      if (pi < 1e-15) continue;
      const off = i * D;
      for (let k = 0; k < D; k++) { const x = g.X[off + k]; if (x !== 0) Ex[k] += pi * x; }
    }
    const ws = g.weightSquares;
    for (let i = 0; i < SUPPORT_SIZE; i++) {
      const pi = p[i];
      if (pi < 1e-15) continue;
      const off = i * D;
      for (let a = 0; a < D; a++) {
        const xa = g.X[off + a];
        if (xa === 0) continue;
        const w = ws * pi * xa;
        for (let b = a; b < D; b++) { const xb = g.X[off + b]; if (xb !== 0) J[a * D + b] += w * xb; }
      }
    }
    for (let a = 0; a < D; a++) {
      const ea = Ex[a];
      if (ea === 0) continue;
      for (let b = a; b < D; b++) J[a * D + b] -= ws * ea * Ex[b];
    }
  }
  for (let a = 0; a < D; a++) for (let b = 0; b < a; b++) J[a * D + b] = J[b * D + a];
  return J;
}

function newton(spec, groups, P, { maxIterations = 100, tolerance = 1e-11 } = {}) {
  const D = spec.dimension;
  let theta = new Float64Array(D);
  theta[0] = -0.0028; // a 13.4-point Gaussian; any concave start converges
  let previous = -Infinity;
  let iterations = 0;

  for (let it = 0; it < maxIterations; it++) {
    iterations = it + 1;
    const cur = evaluate(spec, theta, groups, P, true);
    const neg = new Float64Array(D * D);
    for (let i = 0; i < D * D; i++) neg[i] = -cur.hess[i];
    for (let i = 0; i < D; i++) neg[i * D + i] += 1e-10;
    const L = cholesky(neg, D);
    if (!L) throw new Error('margin model: penalised Hessian is not positive definite — the design is rank deficient');
    const step = cholSolve(L, cur.grad, D);

    let t = 1;
    let accepted = null;
    let acceptedValue = -Infinity;
    for (let bt = 0; bt < 50; bt++) {
      const candidate = new Float64Array(D);
      for (let k = 0; k < D; k++) candidate[k] = theta[k] + t * step[k];
      const trial = evaluate(spec, candidate, groups, P, false);
      if (trial.penalised > cur.penalised) { accepted = candidate; acceptedValue = trial.penalised; break; }
      t *= 0.5;
    }
    if (!accepted) { previous = cur.penalised; break; }
    theta = accepted;
    if (Math.abs(acceptedValue - previous) < tolerance * Math.max(1, Math.abs(acceptedValue))) {
      previous = acceptedValue;
      break;
    }
    previous = acceptedValue;
  }

  const final = evaluate(spec, theta, groups, P, true);
  return { theta, iterations, ...final };
}

/* ============================================================== the fit */

const modelCache = new Map();

/** Forget every cached fit. Same reason `clearRateCache` exists next door. */
export function clearMarginModelCache() {
  modelCache.clear();
}

/**
 * Fit P(margin | spread).
 *
 * `seasons` defaults to the window `teaser-leg-rates.js` defines and defends —
 * 1999-2024, with 2025 and 2026 excluded because `game_lines.spread` is
 * corrupted in both. Passing a narrower window is how the out-of-sample checks
 * below train on a prefix.
 *
 * `games` lets a caller supply rows directly instead of reading the database,
 * which is what `walkForwardCalibration` does so that eighteen refits cost one
 * query rather than eighteen.
 *
 * The returned object carries everything a reader needs to judge the fit
 * without rerunning it: convergence, effective degrees of freedom, the implied
 * conditional moments at a spread of the caller's choosing, the base key-number
 * masses, and the parameter covariance the interval machinery draws from.
 */
export function fitMarginModel({
  seasons = MEASUREMENT_SEASONS,
  seasonHalfLife = DEFAULT_SEASON_HALF_LIFE,
  penalties = DEFAULT_PENALTIES,
  atomMax = ATOM_MAX,
  tiltKnots = DEFAULT_TILT_KNOTS,
  games = null,
  cache = true
} = {}) {
  const from = seasons?.from ?? MEASUREMENT_SEASONS.from;
  const to = seasons?.to ?? MEASUREMENT_SEASONS.to;
  const pen = { ...DEFAULT_PENALTIES, ...penalties };
  const key = games ? null : JSON.stringify([from, to, seasonHalfLife, pen, atomMax, [...tiltKnots]]);
  if (key && cache && modelCache.has(key)) return modelCache.get(key);

  const spec = buildSpec({ atomMax, tiltKnots });
  const loaded = games ? { games, legs: games.length * 2, oneSidedGames: 0, outsideSupport: 0 } : loadGames({ from, to });
  if (!loaded.games.length) {
    throw new Error(`margin model: no games in game_lines for seasons ${from}-${to}`);
  }

  const referenceSeason = to;
  const { groups, weightSum, weightSquareSum } = groupBySpread(spec, loaded.games, { referenceSeason, halfLife: seasonHalfLife });
  const P = penaltyMatrix(spec, pen);
  const fitted = newton(spec, groups, P);

  const D = spec.dimension;
  const negHess = new Float64Array(D * D);
  for (let i = 0; i < D * D; i++) negHess[i] = -fitted.hess[i];
  for (let i = 0; i < D; i++) negHess[i * D + i] += 1e-10;
  const Lh = cholesky(negHess, D);
  if (!Lh) throw new Error('margin model: curvature at the optimum is not positive definite');
  const Hinv = cholInverse(Lh, D);

  // Sandwich: H^-1 J H^-1. Unequal season weights make the naive H^-1 wrong.
  const J = meatMatrix(spec, fitted.theta, groups);
  const covariance = matMul(matMul(Hinv, J, D), Hinv, D);
  // Symmetrise against accumulated floating point, then factor for sampling.
  for (let a = 0; a < D; a++) {
    for (let b = 0; b < a; b++) {
      const v = 0.5 * (covariance[a * D + b] + covariance[b * D + a]);
      covariance[a * D + b] = v; covariance[b * D + a] = v;
    }
  }
  const jitter = new Float64Array(D * D);
  jitter.set(covariance);
  for (let i = 0; i < D; i++) jitter[i * D + i] += 1e-18;
  const covChol = cholesky(jitter, D);

  // Effective degrees of freedom: trace(H_penalised^-1 H_unpenalised).
  let edf = 0;
  for (let a = 0; a < D; a++) {
    for (let b = 0; b < D; b++) {
      const unpen = -fitted.hess[b * D + a] - 2 * P[b * D + a];
      edf += Hinv[a * D + b] * unpen;
    }
  }

  const standardErrors = new Float64Array(D);
  for (let i = 0; i < D; i++) standardErrors[i] = Math.sqrt(Math.max(0, covariance[i * D + i]));

  const observedSeasons = loaded.games.reduce(
    (acc, g) => ({ first: Math.min(acc.first, g.season), last: Math.max(acc.last, g.season) }),
    { first: Infinity, last: -Infinity });

  const model = {
    version: MARGIN_MODEL_VERSION,
    spec,
    theta: fitted.theta,
    covariance,
    covarianceCholesky: covChol,
    standardErrors,
    penalties: Object.freeze({ ...pen }),
    seasonHalfLife,
    referenceSeason,
    seasons: Object.freeze({
      from, to,
      excluded: [...EXCLUDED_SEASONS],
      exclusion_reason: EXCLUSION_REASON,
      observed_first: Number.isFinite(observedSeasons.first) ? observedSeasons.first : null,
      observed_last: Number.isFinite(observedSeasons.last) ? observedSeasons.last : null
    }),
    fit: Object.freeze({
      games: loaded.games.length,
      legs: loaded.legs,
      one_sided_games: loaded.oneSidedGames,
      games_outside_support: loaded.outsideSupport,
      distinct_spreads: groups.length,
      weight_sum: weightSum,
      weight_square_sum: weightSquareSum,
      // (sum w)^2 / sum w^2 — how many equally weighted games the weighted fit
      // is worth. With no weighting this is exactly the game count.
      effective_games: weightSquareSum > 0 ? (weightSum * weightSum) / weightSquareSum : 0,
      parameters: D,
      effective_parameters: edf,
      iterations: fitted.iterations,
      max_abs_gradient: Math.max(...Array.from(fitted.grad, Math.abs)),
      log_likelihood: fitted.logLik,
      penalised_log_likelihood: fitted.penalised
    }),
    parameters: Object.freeze(spec.names.map((name, i) => Object.freeze({
      name, value: fitted.theta[i], standard_error: standardErrors[i]
    })))
  };

  model.diagnostics = Object.freeze(buildDiagnostics(model, groups));
  Object.freeze(model);
  if (key && cache) modelCache.set(key, model);
  return model;
}

/**
 * What a reader needs to decide whether to believe the fit, computed from it
 * rather than quoted at it.
 */
function buildDiagnostics(model, groups) {
  const atLine = spread => {
    const p = marginPmf(spread, { model });
    let mean = 0;
    for (let m = p.min; m <= p.max; m++) mean += m * p.at(m);
    let variance = 0;
    for (let m = p.min; m <= p.max; m++) variance += p.at(m) * (m - mean) * (m - mean);
    return { spread, mean, sd: Math.sqrt(variance) };
  };

  const pickEm = marginPmf(0, { model });
  const baseKeyMass = {};
  for (const k of [0, 1, 2, 3, 4, 6, 7, 10, 14, 17]) {
    baseKeyMass[k] = k === 0 ? pickEm.at(0) : pickEm.at(k) + pickEm.at(-k);
  }

  // The market-efficiency slope: how far the conditional mean moves per point
  // of line, measured across the range the book actually posts.
  const a = atLine(-3), b = atLine(-10);
  const meanSlope = (b.mean - a.mean) / 7;

  // Empirical marginal margin masses, so the fit can be read against the data
  // it was fitted to without a second query.
  const observed = new Map();
  let total = 0;
  for (const g of groups) for (const [m, c] of g.counts) { observed.set(Math.abs(m), (observed.get(Math.abs(m)) ?? 0) + c); total += c; }
  const observedKeyMass = {};
  for (const k of Object.keys(baseKeyMass)) observedKeyMass[k] = total ? (observed.get(Number(k)) ?? 0) / total : null;

  // Is the effective quadratic coefficient still negative across the posted
  // range? If it ever went positive the pmf would only be proper because the
  // support is finite, which is not a property to discover in production.
  const q = model.theta[0];
  const qs = model.theta[model.spec.varIdx];
  const worstCurvature = q + qs * 27;

  return {
    conditional_moments: [0, -1, -3, -3.5, -7, -7.5, -10, -14].map(atLine),
    mean_slope_per_point: meanSlope,
    base_key_number_mass: baseKeyMass,
    observed_marginal_key_number_mass: observedKeyMass,
    residual_sd_at_pickem: atLine(0).sd,
    curvature_at_widest_line: worstCurvature,
    curvature_stays_concave: worstCurvature < 0,
    note: 'base_key_number_mass is the PICK-EM shape kappa: the model at spread 0. It does not ' +
      'move with the line — that is the whole point of the tilt parameterisation. ' +
      'observed_marginal_key_number_mass is the raw data pooled across all lines, which is what ' +
      'the atoms are fitted to reproduce.'
  };
}

/* ========================================================== the interface */

let sharedModel = null;
function defaultModel() {
  if (!sharedModel) sharedModel = fitMarginModel();
  return sharedModel;
}

function requireModel(model) {
  if (!model) return defaultModel();
  if (!model.spec || !model.theta) throw new TypeError('model must be the object returned by fitMarginModel()');
  return model;
}

function requireSpread(spread, what = 'spread') {
  if (!Number.isFinite(spread)) throw new TypeError(`${what} must be a finite number`);
  return spread;
}

/**
 * P(margin = m | spread), over every integer margin in `MARGIN_SUPPORT`.
 *
 * `spread` is on `game_lines`' convention: from the team's point of view,
 * negative when that team is favoured. So `marginPmf(-7)` is the distribution
 * of a 7-point favourite's margin of victory, and its mass at +3 is the chance
 * that favourite wins by exactly a field goal.
 *
 * The returned `probabilities` sum to 1 by construction (they are a normalised
 * exponential family over a finite support), so no caller has to check.
 */
export function marginPmf(spread, { model = null } = {}) {
  const m = requireModel(model);
  requireSpread(spread);
  const spec = m.spec;
  const D = spec.dimension;
  const scratch = new Float64Array(D);
  const out = new Float64Array(SUPPORT_SIZE);
  let max = -Infinity;
  for (let i = 0; i < SUPPORT_SIZE; i++) {
    designVector(spec, i + MARGIN_SUPPORT.min, spread, scratch);
    let e = 0;
    for (let k = 0; k < D; k++) { const x = scratch[k]; if (x !== 0) e += m.theta[k] * x; }
    out[i] = e;
    if (e > max) max = e;
  }
  let z = 0;
  for (let i = 0; i < SUPPORT_SIZE; i++) { out[i] = Math.exp(out[i] - max); z += out[i]; }
  for (let i = 0; i < SUPPORT_SIZE; i++) out[i] /= z;

  return {
    spread,
    min: MARGIN_SUPPORT.min,
    max: MARGIN_SUPPORT.max,
    probabilities: out,
    at(margin) {
      if (!Number.isInteger(margin)) return 0;   // margins are integers; a non-integer has zero mass
      if (margin < MARGIN_SUPPORT.min || margin > MARGIN_SUPPORT.max) return 0;
      return out[margin - MARGIN_SUPPORT.min];
    }
  };
}

/**
 * Win / push / loss for an ARBITRARY handicap on a game posted at `spread`.
 *
 * Two different numbers, and conflating them is the bug this signature exists
 * to make impossible:
 *
 *   `spread`    the posted line. It CONDITIONS the distribution — it is what
 *               the market thinks of the game.
 *   `handicap`  the line you are actually taking, on the same sign convention.
 *               The bet wins when `margin + handicap > 0`, pushes when it is
 *               exactly 0, loses when it is negative.
 *
 * They coincide for a straight bet at the posted number (`handicap` defaults to
 * `spread`), and they differ for every teased, bought, shopped or alternate
 * line. A -7 favourite teased six points is `{ spread: -7, handicap: -1 }`:
 * still a 7-point favourite's margin distribution, now needing only a 2-point
 * win.
 *
 * COHERENCE. The three outputs are each a sum of probabilities over a disjoint
 * partition of the support, so none can be negative and they sum to one. That
 * is worth stating because the object this replaces could not say it: the
 * anchored-mixture version in `nfl-execution-edge.js` returned win -0.125,
 * loss 1.125 for `coverProbabilities(3, -10.5)`. A negative probability is not
 * a rounding problem, it is a signal that the thing producing it was never a
 * distribution. This one is a distribution, and a half-point handicap returns
 * push exactly 0 because no integer margin can land on a half-point.
 */
export function coverProbability({ spread, handicap = null, model = null } = {}) {
  const m = requireModel(model);
  requireSpread(spread);
  const line = handicap == null ? spread : requireSpread(handicap, 'handicap');
  const pmf = marginPmf(spread, { model: m });

  let win = 0, push = 0, loss = 0;
  for (let i = 0; i < SUPPORT_SIZE; i++) {
    const margin = i + MARGIN_SUPPORT.min;
    const result = margin + line;
    const p = pmf.probabilities[i];
    if (result > 0) win += p;
    else if (result === 0) push += p;
    else loss += p;
  }
  // Each term is a sum of non-negative numbers over a disjoint partition, so
  // the only thing left to do is absorb the last float of normalisation error
  // into one component rather than leaving the triple summing to 1 - 2e-16.
  const total = win + push + loss;
  win /= total; push /= total;
  loss = 1 - win - push;
  if (loss < 0) { loss = 0; win = 1 - push; }

  return { spread, handicap: line, win, push, loss };
}

/**
 * The `{ w, t, l }` a teaser leg needs, for ANY posted line and ANY tease size.
 *
 * `side`:
 *   'as-posted' (default)  tease the team whose number `spread` is
 *   'opposite'             tease the OTHER team, whose number is -spread
 *   'favourite'/'underdog' resolve to whichever of those two is that side;
 *                          throws on a pick'em, where neither side is either
 *
 * The naming is `w`/`t`/`l` (win/tie/loss) because that is what the ticket
 * arithmetic in `teaser-leg-rates.js#ticketProbabilities` consumes. `rate` is
 * the push-excluded rate that module reports, `w / (w + l)`, which is the
 * number comparable to a measured historical leg rate. Both are returned
 * because they answer different questions and substituting one for the other
 * misprices a DraftKings ticket, where a push is not a loss.
 */
export function teaserLegProbability({ spread, points = TEASER_POINTS, side = 'as-posted', model = null } = {}) {
  const m = requireModel(model);
  requireSpread(spread);
  if (!Number.isFinite(points)) throw new TypeError('points must be a finite number');

  let effective;
  switch (side) {
    case 'as-posted': effective = spread; break;
    case 'opposite': effective = -spread; break;
    case 'favourite':
      if (spread === 0) throw new TypeError("side 'favourite' is undefined on a pick'em");
      effective = -Math.abs(spread); break;
    case 'underdog':
      if (spread === 0) throw new TypeError("side 'underdog' is undefined on a pick'em");
      effective = Math.abs(spread); break;
    default:
      throw new TypeError(`side must be 'as-posted', 'opposite', 'favourite' or 'underdog', got ${side}`);
  }

  const cover = coverProbability({ spread: effective, handicap: effective + points, model: m });
  const decided = cover.win + cover.loss;
  return {
    line: effective,
    teased_to: effective + points,
    points,
    side,
    w: cover.win,
    t: cover.push,
    l: cover.loss,
    rate: decided > 0 ? cover.win / decided : null
  };
}

/* ============================================================ uncertainty */

/** Parameter draws from the Laplace posterior N(theta, sandwich covariance). */
export function posteriorDraws({ model = null, draws = 2000, seed = 20260910 } = {}) {
  const m = requireModel(model);
  if (!m.covarianceCholesky) throw new Error('this model carries no covariance factor; refit it');
  const D = m.spec.dimension;
  const L = m.covarianceCholesky;
  const rng = mulberry32(seed);
  const out = [];
  for (let d = 0; d < draws; d++) {
    const z = standardNormals(rng, D);
    const theta = new Float64Array(D);
    for (let i = 0; i < D; i++) {
      let s = m.theta[i];
      for (let k = 0; k <= i; k++) s += L[i * D + k] * z[k];
      theta[i] = s;
    }
    out.push(theta);
  }
  return out;
}

/**
 * An interval on ANY functional of the fit, by propagating parameter draws.
 *
 * This is the export the brief asks for by "something that reports uncertainty
 * on those, not just the point estimate", and it is deliberately generic: the
 * downstream projection does not need an interval on a teaser leg, it needs an
 * interval on whatever it computes from the model, and anything shipped as
 * eight precomputed intervals would be the lookup again with extra steps.
 *
 * `of` receives a model-shaped object whose `theta` is one draw and returns a
 * number. WHAT THIS INTERVAL IS: the uncertainty in the FITTED SURFACE, which
 * shares strength across every line. It is not a binomial interval on one
 * cell's count, and at a line with 93 legs it is much narrower than one,
 * because the model is not estimating that line from 93 legs. WHAT IT IS NOT:
 * an allowance for the model being the wrong shape. `MARGIN_MODEL_VERDICT`
 * carries the measured size of that, and it is larger than this interval.
 */
export function probabilityInterval({ model = null, of, draws = 2000, level = 0.95, seed = 20260910 } = {}) {
  const m = requireModel(model);
  if (typeof of !== 'function') throw new TypeError('probabilityInterval needs a function `of`');
  if (!(level > 0 && level < 1)) throw new TypeError('level must be strictly between 0 and 1');

  const estimate = of(m);
  const sample = posteriorDraws({ model: m, draws, seed })
    .map(theta => of({ ...m, theta }))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!sample.length) return { estimate, lower: null, upper: null, standard_error: null, draws: 0, level };

  const alpha = (1 - level) / 2;
  const pick = q => sample[Math.min(sample.length - 1, Math.max(0, Math.floor(q * sample.length)))];
  const mean = sample.reduce((s, v) => s + v, 0) / sample.length;
  const variance = sample.reduce((s, v) => s + (v - mean) * (v - mean), 0) / Math.max(1, sample.length - 1);

  return {
    estimate,
    lower: pick(alpha),
    upper: pick(1 - alpha),
    standard_error: Math.sqrt(variance),
    draws: sample.length,
    level
  };
}

/** The common case: an interval on a teaser leg's push-excluded rate. */
export function teaserLegInterval({
  spread, points = TEASER_POINTS, side = 'as-posted',
  model = null, draws = 2000, level = 0.95, seed = 20260910
} = {}) {
  const m = requireModel(model);
  const point = teaserLegProbability({ spread, points, side, model: m });
  const interval = probabilityInterval({
    model: m, draws, level, seed,
    of: drawn => teaserLegProbability({ spread, points, side, model: drawn }).rate
  });
  return { ...point, interval };
}

/* ============================================================= validation */

/**
 * The check that decides whether any of this is real: does the fit reproduce
 * the eight cross-both lines?
 *
 * Leg construction matches `teaser-leg-rates.js` exactly — both sides of every
 * game at their own posted number, pushes out of the rate's denominator,
 * 1999-2024 only — because a reproduction measured on a different population
 * would be a reproduction of nothing.
 *
 * One subtlety that matters for reading the result. The empirical target is an
 * UNWEIGHTED 1999-2024 average. A model fitted with season weights describes
 * recent football instead, so comparing it to that target is not like for like;
 * the like-for-like comparison is `seasonHalfLife: Infinity`, and that is the
 * one the test suite asserts. Both are reported here so the difference is
 * visible rather than a choice made off-screen.
 */
export function crossBothReproduction({ model = null, points = TEASER_POINTS, lines = CROSS_BOTH_LINES, query = rows } = {}) {
  const m = requireModel(model);
  const legs = query(
    `SELECT spread, team_score, opp_score FROM game_lines
      WHERE spread IS NOT NULL AND team_score IS NOT NULL AND opp_score IS NOT NULL
        AND season BETWEEN ? AND ?`,
    MEASUREMENT_SEASONS.from, MEASUREMENT_SEASONS.to);

  const cells = [];
  let pooledWins = 0, pooledDecided = 0, pooledExpected = 0, chiSquare = 0;

  for (const line of lines) {
    let n = 0, wins = 0, pushes = 0;
    for (const leg of legs) {
      if (leg.spread !== line) continue;
      const result = (leg.team_score - leg.opp_score) + line + points;
      n++;
      if (result === 0) pushes++;
      else if (result > 0) wins++;
    }
    const decided = n - pushes;
    const empirical = decided ? wins / decided : null;
    const predicted = teaserLegProbability({ spread: line, points, model: m }).rate;
    const standardError = decided && empirical != null
      ? Math.sqrt(empirical * (1 - empirical) / decided) : null;
    const z = standardError ? (empirical - predicted) / standardError : null;
    if (z != null) chiSquare += z * z;
    if (decided) { pooledWins += wins; pooledDecided += decided; pooledExpected += decided * predicted; }
    cells.push({
      line, n, wins, pushes, decided,
      empirical_rate: empirical,
      model_rate: predicted,
      difference: empirical == null ? null : empirical - predicted,
      empirical_standard_error: standardError,
      z
    });
  }

  const pooledEmpirical = pooledDecided ? pooledWins / pooledDecided : null;
  const pooledModel = pooledDecided ? pooledExpected / pooledDecided : null;
  const pooledSe = pooledDecided && pooledEmpirical != null
    ? Math.sqrt(pooledEmpirical * (1 - pooledEmpirical) / pooledDecided) : null;

  return {
    points,
    seasons: { from: MEASUREMENT_SEASONS.from, to: MEASUREMENT_SEASONS.to, excluded: [...EXCLUDED_SEASONS] },
    season_half_life: m.seasonHalfLife,
    cells,
    pooled: {
      decided: pooledDecided,
      empirical_rate: pooledEmpirical,
      model_rate: pooledModel,
      difference: pooledEmpirical == null ? null : pooledEmpirical - pooledModel,
      empirical_standard_error: pooledSe,
      z: pooledSe ? (pooledEmpirical - pooledModel) / pooledSe : null
    },
    per_line_chi_square: chiSquare,
    per_line_degrees_of_freedom: cells.filter(c => c.z != null).length,
    per_line_p_value: chiSquareSurvival(chiSquare, cells.filter(c => c.z != null).length)
  };
}

function scoreLeg(probability, won) {
  const p = Math.min(1 - 1e-12, Math.max(1e-12, probability));
  return { logLoss: -(won ? Math.log(p) : Math.log(1 - p)), brier: (p - (won ? 1 : 0)) ** 2 };
}

/**
 * Fit on a prefix, test on the seasons after it, and score the model against
 * the two estimators it would replace.
 *
 * The competitors are the honest ones, both trained on the same prefix:
 *   pooled lookup    the single family rate `teaser-leg-rates.js#familyRate`
 *                    returns, which is what the scanner prices with today
 *   per-line lookup  `teasedLegRate` per line, the eight-cell version the
 *                    module warns against
 *
 * Calibration is reported as the signed difference between what actually
 * happened and what each estimator said, in percentage points and in standard
 * errors of the observed rate, because "which had lower log-loss" and "which
 * was pointing at the right number" are different questions and a price gate
 * cares about the second.
 */
export function outOfSampleCalibration({
  trainThrough = 2018,
  testFrom = 2019,
  testThrough = MEASUREMENT_SEASONS.to,
  points = TEASER_POINTS,
  lines = CROSS_BOTH_LINES,
  seasonHalfLife = DEFAULT_SEASON_HALF_LIFE,
  penalties = DEFAULT_PENALTIES,
  query = rows
} = {}) {
  const legs = query(
    `SELECT season, spread, team_score, opp_score FROM game_lines
      WHERE spread IS NOT NULL AND team_score IS NOT NULL AND opp_score IS NOT NULL
        AND season BETWEEN ? AND ?`,
    MEASUREMENT_SEASONS.from, MEASUREMENT_SEASONS.to);

  const { games } = loadGames({ from: MEASUREMENT_SEASONS.from, to: trainThrough, query });
  const model = fitMarginModel({
    seasons: { from: MEASUREMENT_SEASONS.from, to: trainThrough },
    seasonHalfLife, penalties, games, cache: false
  });

  const lineSet = new Set(lines);
  const trainCells = new Map();
  let trainWins = 0, trainDecided = 0;
  for (const line of lines) {
    let wins = 0, decided = 0;
    for (const leg of legs) {
      if (leg.season > trainThrough || leg.spread !== line) continue;
      const result = (leg.team_score - leg.opp_score) + line + points;
      if (result === 0) continue;
      decided++;
      if (result > 0) wins++;
    }
    trainCells.set(line, decided ? wins / decided : null);
    trainWins += wins; trainDecided += decided;
  }
  const pooledLookup = trainDecided ? trainWins / trainDecided : null;
  const modelRate = new Map(lines.map(line => [line, teaserLegProbability({ spread: line, points, model }).rate]));

  const acc = {
    model: { logLoss: 0, brier: 0, expected: 0 },
    pooled: { logLoss: 0, brier: 0, expected: 0 },
    perLine: { logLoss: 0, brier: 0, expected: 0 }
  };
  let n = 0, wins = 0;
  for (const leg of legs) {
    if (leg.season < testFrom || leg.season > testThrough) continue;
    if (!lineSet.has(leg.spread)) continue;
    const result = (leg.team_score - leg.opp_score) + leg.spread + points;
    if (result === 0) continue;
    const won = result > 0;
    n++; if (won) wins++;
    const candidates = [
      ['model', modelRate.get(leg.spread)],
      ['pooled', pooledLookup],
      ['perLine', trainCells.get(leg.spread)]
    ];
    for (const [name, p] of candidates) {
      if (p == null) continue;
      const s = scoreLeg(p, won);
      acc[name].logLoss += s.logLoss;
      acc[name].brier += s.brier;
      acc[name].expected += p;
    }
  }

  const observed = n ? wins / n : null;
  const se = n && observed != null ? Math.sqrt(observed * (1 - observed) / n) : null;
  const report = name => ({
    predicted: n ? acc[name].expected / n : null,
    calibration_error: n ? observed - acc[name].expected / n : null,
    calibration_z: se ? (observed - acc[name].expected / n) / se : null,
    log_loss: n ? acc[name].logLoss / n : null,
    brier: n ? acc[name].brier / n : null
  });

  return {
    train: { from: MEASUREMENT_SEASONS.from, through: trainThrough, games: games.length },
    test: { from: testFrom, through: testThrough, decided_legs: n },
    observed_rate: observed,
    observed_standard_error: se,
    model: report('model'),
    pooled_lookup: report('pooled'),
    per_line_lookup: report('perLine'),
    season_half_life: seasonHalfLife
  };
}

/**
 * The powerful version of the same question: refit on every prior season and
 * predict the next one, across as many test seasons as the data allows.
 *
 * A single 1999-2018 / 2019-2024 split leaves only ~640 decided family legs and
 * a 1.7pp standard error, which cannot separate a 72% claim from a 74% one.
 * Walking forward from 2007 tests 1,938 of them and gets the error down to
 * 0.98pp, which can. The cost is eighteen refits; they take about a second in
 * total because `games` is loaded once and passed in.
 *
 * `restrictTo` narrows the scored legs. Passing a predicate that EXCLUDES the
 * cross-both family is how the "what does it buy" half of the verdict is
 * measured, and it is where the model wins.
 */
export function walkForwardCalibration({
  from = 2007,
  to = MEASUREMENT_SEASONS.to,
  points = TEASER_POINTS,
  restrictTo = null,
  seasonHalfLife = DEFAULT_SEASON_HALF_LIFE,
  penalties = DEFAULT_PENALTIES,
  compareLookup = true,
  query = rows
} = {}) {
  const legs = query(
    `SELECT season, spread, team_score, opp_score FROM game_lines
      WHERE spread IS NOT NULL AND team_score IS NOT NULL AND opp_score IS NOT NULL
        AND season BETWEEN ? AND ?`,
    MEASUREMENT_SEASONS.from, MEASUREMENT_SEASONS.to);
  const { games } = loadGames({ from: MEASUREMENT_SEASONS.from, to: MEASUREMENT_SEASONS.to, query });
  const inFamily = new Set(CROSS_BOTH_LINES);
  const keep = restrictTo ?? (spread => inFamily.has(spread));

  const acc = {
    model: { logLoss: 0, brier: 0, expected: 0 },
    pooled: { logLoss: 0, brier: 0, expected: 0 },
    perLine: { logLoss: 0, brier: 0, expected: 0 }
  };
  let n = 0, wins = 0, pmfLogLik = 0, pmfGames = 0;
  const seasons = [];

  for (let season = from; season <= to; season++) {
    const trainGames = games.filter(g => g.season < season);
    if (!trainGames.length) continue;
    const model = fitMarginModel({
      seasons: { from: MEASUREMENT_SEASONS.from, to: season - 1 },
      seasonHalfLife, penalties, games: trainGames, cache: false
    });

    const modelRate = new Map();
    const lineLookup = new Map();
    let lookupWins = 0, lookupDecided = 0;
    if (compareLookup) {
      for (const line of CROSS_BOTH_LINES) {
        let w = 0, d = 0;
        for (const leg of legs) {
          if (leg.season >= season || leg.spread !== line) continue;
          const r = (leg.team_score - leg.opp_score) + line + points;
          if (r === 0) continue;
          d++; if (r > 0) w++;
        }
        lineLookup.set(line, d ? w / d : null);
        lookupWins += w; lookupDecided += d;
      }
    }
    const pooledLookup = lookupDecided ? lookupWins / lookupDecided : null;

    let seasonN = 0, seasonWins = 0, seasonExpected = 0;
    for (const leg of legs) {
      if (leg.season !== season || !keep(leg.spread)) continue;
      const result = (leg.team_score - leg.opp_score) + leg.spread + points;
      if (result === 0) continue;
      const won = result > 0;
      if (!modelRate.has(leg.spread)) {
        modelRate.set(leg.spread, teaserLegProbability({ spread: leg.spread, points, model }).rate);
      }
      const p = modelRate.get(leg.spread);
      n++; seasonN++; if (won) { wins++; seasonWins++; }
      seasonExpected += p;
      const sm = scoreLeg(p, won);
      acc.model.logLoss += sm.logLoss; acc.model.brier += sm.brier; acc.model.expected += p;
      if (compareLookup) {
        for (const [name, q] of [['pooled', pooledLookup], ['perLine', lineLookup.get(leg.spread)]]) {
          if (q == null) continue;
          const s = scoreLeg(q, won);
          acc[name].logLoss += s.logLoss; acc[name].brier += s.brier; acc[name].expected += q;
        }
      }
    }

    for (const g of games) {
      if (g.season !== season) continue;
      pmfLogLik += Math.log(Math.max(marginPmf(g.spread, { model }).at(g.margin), 1e-300));
      pmfGames++;
    }
    seasons.push({
      season, decided_legs: seasonN,
      observed_rate: seasonN ? seasonWins / seasonN : null,
      model_rate: seasonN ? seasonExpected / seasonN : null
    });
  }

  const observed = n ? wins / n : null;
  const se = n && observed != null ? Math.sqrt(observed * (1 - observed) / n) : null;
  const report = name => ({
    predicted: n ? acc[name].expected / n : null,
    calibration_error: n ? observed - acc[name].expected / n : null,
    calibration_z: se ? (observed - acc[name].expected / n) / se : null,
    log_loss: n ? acc[name].logLoss / n : null,
    brier: n ? acc[name].brier / n : null
  });

  return {
    test_seasons: { from, to },
    points,
    decided_legs: n,
    observed_rate: observed,
    observed_standard_error: se,
    model: report('model'),
    pooled_lookup: compareLookup ? report('pooled') : null,
    per_line_lookup: compareLookup ? report('perLine') : null,
    margin_pmf_log_likelihood_per_game: pmfGames ? pmfLogLik / pmfGames : null,
    margin_pmf_games: pmfGames,
    seasons,
    season_half_life: seasonHalfLife
  };
}

/**
 * The era-drift measurement, recomputed rather than quoted, so decision 5 can
 * be re-argued on new data instead of trusted.
 */
export function eraDrift({ keyNumbers = [3, 7], split = 2012, query = rows } = {}) {
  const { games } = loadGames({ query });
  const keys = new Set(keyNumbers);
  const bySeason = new Map();
  for (const g of games) {
    const b = bySeason.get(g.season) ?? { n: 0, k: 0 };
    b.n++;
    if (keys.has(Math.abs(g.margin))) b.k++;
    bySeason.set(g.season, b);
  }

  const seasons = [...bySeason.keys()].sort((a, b) => a - b);
  let sx = 0, sy = 0, sxx = 0, sxy = 0, total = 0, hits = 0;
  for (const s of seasons) {
    const b = bySeason.get(s);
    const p = b.k / b.n;
    sx += s; sy += p; sxx += s * s; sxy += s * p;
    total += b.n; hits += b.k;
  }
  const n = seasons.length;
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const pooled = hits / total;
  const xbar = sx / n;
  let num = 0, den = 0;
  for (const s of seasons) {
    const b = bySeason.get(s);
    num += (s - xbar) * (b.k - b.n * pooled);
    den += (s - xbar) * (s - xbar) * b.n * pooled * (1 - pooled);
  }
  const trendZ = den > 0 ? num / Math.sqrt(den) : null;

  const half = side => {
    let nn = 0, kk = 0;
    for (const s of seasons) {
      if (side === 'early' ? s >= split : s < split) continue;
      const b = bySeason.get(s); nn += b.n; kk += b.k;
    }
    return { seasons: side === 'early' ? `${seasons[0]}-${split - 1}` : `${split}-${seasons[n - 1]}`, n: nn, rate: nn ? kk / nn : null };
  };
  const early = half('early');
  const late = half('late');
  const diffSe = early.rate != null && late.rate != null
    ? Math.sqrt(early.rate * (1 - early.rate) / early.n + late.rate * (1 - late.rate) / late.n) : null;

  return {
    key_numbers: [...keyNumbers],
    pooled_rate: pooled,
    by_season: seasons.map(s => ({ season: s, n: bySeason.get(s).n, rate: bySeason.get(s).k / bySeason.get(s).n })),
    trend_per_season: slope,
    trend_over_window: slope * (seasons[n - 1] - seasons[0]),
    trend_z: trendZ,
    early, late,
    half_difference: early.rate != null && late.rate != null ? late.rate - early.rate : null,
    half_difference_z: diffSe ? (late.rate - early.rate) / diffSe : null
  };
}

/* ================================================================ verdict */

/**
 * What building this bought, stated plainly, including the part that argues
 * against using it.
 *
 * Every number below is reproduced by `test/margin-distribution.test.js` from
 * the database, so none of them can quietly stop being true.
 *
 * WHERE THE MODEL WINS. Walk-forward 2007-2024 on every posted line OUTSIDE
 * the cross-both family — 7,646 decided legs at six points, 7,674 at ten — the
 * model's mean prediction is within 0.05pp and 0.13pp of what happened, and it
 * beats the windowed empirical lookup `nfl-execution-edge.js` uses today by
 * 23.2 and 25.8 nats of log-likelihood. On the sparse lines specifically
 * (fewer than 150 prior legs at that exact number) it wins by 14.5 and 16.6
 * nats. It is also better calibrated across tease sizes it was never tuned to:
 * at +3, +6, +7, +10 and +13 points across all lines its error runs +0.44pp to
 * +0.74pp, about one standard error, with no drift as the tease grows.
 *
 * WHERE IT LOSES, AND IT IS EXACTLY THE EIGHT LINES THAT MATTER. Same
 * walk-forward, restricted to the cross-both family, 1,938 decided legs:
 *
 *     observed                 75.03%   (se 0.98pp)
 *     pooled empirical lookup  73.34%   error +1.69pp (z = 1.72), log-loss 0.56298
 *     per-line lookup          73.49%   error +1.53pp (z = 1.56), log-loss 0.56454
 *     fitted model             71.67%   error +3.36pp (z = 3.42), log-loss 0.56474
 *
 * The model is the worst of the three on both calibration and log-loss, and its
 * miss is not sampling error. In sample it is milder but the same sign: the
 * eight lines are reproduced individually within sampling error (chi-square
 * 9.19 on 8 df, p = 0.33; largest |z| 1.69) while the POOLED rate comes out
 * 72.48% against 74.06% measured, z = 1.93.
 *
 * WHY IT LOSES. Not the key numbers — the fit reproduces the marginal margin
 * distribution to two decimal places (3 at 15.03% modelled against 15.08%
 * observed, 7 at 9.00% against 9.03%). The gap is the CONDITIONAL MEAN at
 * those particular lines. Measured against a single market-efficiency slope
 * fitted across the whole board:
 *
 *     favourites at -7 to -8.5   beat their number by 1.04 points   (z = +2.36)
 *     favourites at -1.5 to -3   missed theirs by 0.85 points       (z = -2.84)
 *
 * and the family sits on the profitable side of both — it teases the -7 to -8.5
 * favourites DOWN and the +1.5 to +3 underdogs UP. The mirror lines confirm it
 * is one effect seen twice rather than two: at +7 to +8.5 the model over-predicts
 * by 5.36pp and at -1.5 to -3 by 2.10pp, the same games viewed from the other
 * side. No amount of unsmoothing rescues it; a fully saturated per-line tilt
 * still lands at 72.91% walk-forward (still 2.11pp low) with a WORSE held-out
 * margin-pmf likelihood, which is what over-fitting looks like.
 *
 * WHETHER THAT EXCESS IS REAL IS NOT SETTLED HERE, and this module does not
 * need it to be. Against it: the conditional mean is linear in the spread
 * across the whole board (chi-square 31.2 on 25 cells, p = 0.18), and
 * season-blocked CV prefers the smooth tilt over the per-line one. For it: the
 * excess persisted across eighteen consecutive held-out seasons at z = 3.42,
 * which is not what one-off noise usually does. Either way the operational
 * conclusion is the same, because a price gate has to be pointed at the right
 * number and the model demonstrably is not.
 *
 * SO: DO NOT SWITCH THE TEASER SCANNER TO THIS. `familyRate()` stays the
 * number that prices a cross-both leg. Use this model for the questions the
 * lookup cannot answer at all — any other line, any other tease size, any
 * alternate or bought number, and the uncertainty that has to propagate into a
 * projection — and read `family_line_bias` before using it anywhere near
 * |line| 1.5-3 or 7-8.5, where it runs low.
 */
export const MARGIN_MODEL_VERDICT = Object.freeze({
  version: MARGIN_MODEL_VERSION,
  use_for_cross_both_family: false,
  use_for_other_lines: true,
  use_for_other_tease_sizes: true,
  headline:
    'The fitted model is better calibrated than the empirical lookup everywhere EXCEPT the eight ' +
    'cross-both lines, where it is worse. Walk-forward 2007-2024: on 7,646 non-family legs the ' +
    'model is within 0.05pp and beats the windowed lookup by 23.2 nats; on 1,938 family legs it ' +
    'under-prices by 3.36pp (z = 3.42) against the pooled lookup\'s 1.69pp (z = 1.72), and loses ' +
    'on log-loss as well (0.56474 vs 0.56298).',
  family_line_bias:
    'The model runs low on legs teasing a -7 to -8.5 favourite down or a +1.5 to +3 underdog up, ' +
    'by roughly 2-4pp. Cause: favourites at -7 to -8.5 historically beat their number by 1.04 ' +
    'points (z = +2.36) and underdogs at +1.5 to +3 beat theirs by 0.85 points (z = +2.84), ' +
    'deviations from a market-efficiency slope that is otherwise linear across the whole board ' +
    '(chi-square 31.2 on 25 cells, p = 0.18). The family sits on the profitable side of both.',
  price_cross_both_with: 'teaser-leg-rates.js#familyRate',
  degrades_to: 'On any line outside |spread| 1.5-3 and 7-8.5 the measured walk-forward calibration ' +
    'error is under 1pp, and on sparse lines the model is the best estimator available because the ' +
    'lookup has nothing to look up.'
});
