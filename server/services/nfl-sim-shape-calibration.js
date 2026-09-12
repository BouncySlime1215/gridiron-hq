/**
 * Does the simulator's margin distribution have the right SHAPE?
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 *
 * `nfl-drive-sim.js#calibrationReport()` checks three numbers: mean total,
 * mean margin, and the mean of the per-matchup margin standard deviations.
 * Three moments, all of them tolerant to within three points. Nothing about
 * shape, and nothing about key numbers at all.
 *
 * That is not an abstract gap. Two real faults lived in this engine for weeks
 * and the calibration report said "calibrated" the entire time:
 *
 *   1. Home-field advantage was applied as ONE end-of-game coin flip of a full
 *      touchdown (`if (random() < homeFieldPoints / 7) home += 7`). Its mean
 *      was right, its variance contribution was small, and its dispersion was
 *      inside a 3.5-point tolerance — so all three existing checks passed while
 *      the engine emitted a discrete spike of probability at margin +7 that
 *      real football does not have. A three-moment check cannot see a spike;
 *      that is what "moment" means.
 *   2. The same blindness applies to overtime. A simulator whose overtime is
 *      missing or ineffective piles regulation ties onto margin 0. The mean
 *      margin does not move, the dispersion barely moves, and P(margin = 0)
 *      goes from a real-football fraction of a percent to several percent.
 *
 * Both are distribution-shape faults. Both are invisible to a moment check and
 * loud in a mass check. So this module scores the FULL margin distribution and
 * checks the key-number buckets explicitly.
 *
 * ===========================================================================
 * WHAT IS SCORED, AND AGAINST WHAT
 * ===========================================================================
 *
 * Two scoring modes, deliberately separate, because they answer different
 * questions and have different evidential strength.
 *
 * MODE 1 — HELD-OUT, AGAINST REAL GAMES (`walkForwardShapeCalibration`).
 * The strong one, and the one that needs a populated database. It follows the
 * walk-forward pattern in `server/betting/nfl/strategy/margin-distribution.js`
 * exactly rather than inventing a second one: for each test season, build the
 * predictor from seasons STRICTLY BEFORE it, predict that season, score the
 * real outcomes, pool. There the predictor is `fitMarginModel` on prior
 * seasons; here it is the simulator run off `blendedProfiles({ season: s - 1 })`,
 * which is the same cutoff discipline `nfl-drive-sim.js#backtest()` already
 * uses. The reported statistic is deliberately the same one that module
 * reports — mean log P(observed margin) per game — so the simulator's implied
 * margin distribution and the fitted margin model can be read on one scale.
 * Brier is the multiclass form over the same integer support, and the
 * key-number events are scored with that module's own exported `scoreLeg`.
 *
 * MODE 2 — AGAINST THE DOCUMENTED EMPIRICAL BUCKETS (`documentedBucketScores`).
 * The weaker one, and the one that runs anywhere. `margin-distribution.js`
 * carries a measured table from 6,991 real NFL games, 1999-2024: |margin| 3 at
 * 15.08%, 7 at 9.03%, 6 at 6.08%, 10 at 5.59%, 14 at 4.92%, 4 at 4.81%. Those
 * six buckets plus "everything else" are a genuine seven-outcome distribution
 * over real football, so the cross-entropy of the simulated distribution
 * against it is a real log-loss — the expected surprise of a random real game's
 * bucket under the simulator — computable with no per-game corpus at all.
 *
 * Mode 2 is a floor, not a substitute. It scores six buckets, it cannot see
 * conditioning on the spread, and it cannot see anything the six buckets do not
 * touch. It is reported as `evidence: 'documented-buckets'` and never as a
 * held-out result.
 *
 * ===========================================================================
 * WHY THE CORPUS IS CHECKED BEFORE IT IS TRUSTED
 * ===========================================================================
 *
 * `game_lines` is also where the test fixtures put their synthetic seasons, and
 * a shape check scored against a synthetic corpus is worse than no check: it
 * produces a confident number about nothing. So `corpusRealism()` compares the
 * attached corpus's own 3 and 7 mass against the documented table before any
 * held-out verdict is issued, and a corpus that does not look like NFL football
 * gets `corpus_is_real: false` and every held-out check reports `pass: null`
 * with a disposition sentence rather than a verdict.
 *
 * ===========================================================================
 * THE CHECKS THEMSELVES
 * ===========================================================================
 *
 * KEY-NUMBER MASS, relative to a neighbouring one-point bin. Absolute mass on
 * its own is a weak test because it moves with dispersion: widen the
 * distribution and every bucket falls together. The ratio of a key bucket to
 * its immediate neighbour is scale-free and is what "3 and 7 are special"
 * actually means. Both neighbours used are themselves documented — 3 against 4
 * (15.08 / 4.81 = 3.14) and 7 against 6 (9.03 / 6.08 = 1.49) — so the reference
 * ratios are measured, not assumed.
 *
 * SIGNED SPIKE. The check the +7 bug needed and nobody had. Every mass view in
 * this engine before now reported |margin|, which folds the distribution in
 * half and makes a one-sided spike vanish: a bug adding probability at +7 and
 * none at -7 shows up in |7| as a half-size bump indistinguishable from a
 * slightly strong home field. So each key number is also scored SIGNED, by the
 * second difference of the log MIRROR RATIO n(+k)/n(-k). That statistic is
 * zero for any exponentially tilted version of any symmetric base shape —
 * including one full of key-number spikes, because a real key number raises
 * both signs together and cancels — and non-zero exactly when probability has
 * been added to one side of one bin. The first draft of this check used
 * "bin versus the average of its two neighbours" instead and had to be thrown
 * away: on a tilted, curved distribution that quantity is large for ordinary
 * bins too, by up to ten units on this engine, so grading on it would have
 * been grading on curvature. See `signedSpikeCheck`.
 *
 * TIE MASS. The overtime check. Reported as P(margin = 0) against the average
 * of P(margin = -1) and P(margin = +1), because that ratio is what separates
 * "overtime resolves nearly every tie" from "overtime is not running": real
 * post-overtime football leaves margin 0 far BELOW its neighbours, regulation
 * ties leave it at or above them. The reference for that ratio is measured from
 * the attached corpus when the corpus is real, and reported with `pass: null`
 * when it is not, because `margin-distribution.js` documents no tie constant
 * and guessing one would be inventing a metric.
 */
/*
 * DEPENDENCY DIRECTION. This module never imports the simulator. The two
 * entry points below take the sampler as an argument and `nfl-drive-sim.js`
 * binds its own `simulateMarginSample` to them, so the edge runs one way
 * (engine -> scorer) and `calibrationReport` can call the shape checks without
 * an import cycle. It also means the scorer can be driven by a fixed margin
 * sample in a test, which is how its arithmetic is checked without running
 * eighty thousand simulated games.
 */
import { rows } from '../db/index.js';
import { scoreLeg, MARGIN_SUPPORT } from '../betting/nfl/strategy/margin-distribution.js';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r5 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(5));

/**
 * The measured real-football reference, quoted from `margin-distribution.js`'s
 * own header rather than re-derived, so the two cannot drift apart: 6,991 NFL
 * games, 1999-2024, one row per game.
 *
 * `neighbour` names the adjacent one-point bin each key number is scored
 * against. Both are themselves in the measured table, which is the reason
 * these two were chosen and not, say, 10 against 9.
 */
export const REFERENCE_MARGIN_MASS = Object.freeze({
  source: 'server/betting/nfl/strategy/margin-distribution.js — 6,991 NFL games, 1999-2024, one row per game',
  abs_mass: Object.freeze({ 3: 0.1508, 4: 0.0481, 6: 0.0608, 7: 0.0903, 10: 0.0559, 14: 0.0492 }),
  key_numbers: Object.freeze([
    Object.freeze({ margin: 3, neighbour: 4, reference_ratio: 0.1508 / 0.0481 }),
    Object.freeze({ margin: 7, neighbour: 6, reference_ratio: 0.0903 / 0.0608 })
  ]),
  /** P(|margin| in {3,7}) by era, same source; the pooled figure the harness quotes. */
  key_mass_3_and_7: 0.1508 + 0.0903,
  era: Object.freeze({ '1999-2011': 0.2541, '2012-2024': 0.2283 })
});

/** The buckets mode 2 scores over: the six documented ones, plus everything else. */
const DOCUMENTED_BUCKETS = Object.freeze([3, 4, 6, 7, 10, 14]);

/**
 * Control bins for the signed-spike check: ordinary margins that are not key
 * numbers and are not one step from one, spread either side of the mode so the
 * median is not dominated by one stretch of the curve. They measure the
 * tilt-and-curvature bias the statistic carries on any real margin shape.
 */
const CONTROL_BINS = Object.freeze([5, 9, 11, 12, 15, 18]);

/**
 * How far the attached corpus may sit from the documented 3 and 7 mass before
 * this module refuses to call it real football. Wide on purpose — a genuine
 * single season of ~270 games has a standard error near 2pp on the 3 bucket, so
 * the gate must not reject real data; it only has to reject a corpus that was
 * never NFL margins in the first place, which misses by an order of magnitude.
 */
const REALISM_TOLERANCE = 0.05;

/* ------------------------------------------------------------- histograms */

/** Signed integer margin histogram over the model's own support, as counts. */
function histogram(margins) {
  const counts = new Map();
  let n = 0;
  for (const m of margins) {
    if (!Number.isFinite(m)) continue;
    const k = Math.round(m);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    n++;
  }
  return { counts, n };
}

const massAt = (hist, k) => (hist.n ? (hist.counts.get(k) ?? 0) / hist.n : 0);
const absMassAt = (hist, k) => (k === 0 ? massAt(hist, 0) : massAt(hist, k) + massAt(hist, -k));

/**
 * Additively smoothed pmf over the integer support, for log scoring.
 *
 * A Monte Carlo histogram has exact zeros in its tails, and -log(0) is not a
 * score, it is a crash dressed as infinity. One pseudo-count per support point
 * (Laplace) is the standard fix and is stated rather than tuned: with the
 * sample sizes this harness uses (tens of thousands of simulated games over 181
 * support points) it moves the log-likelihood of a well-populated bin by less
 * than 0.1% and only matters where the alternative is undefined.
 *
 * The support is `MARGIN_SUPPORT` from the fitted margin model, so a simulator
 * log-likelihood and a `fitMarginModel` log-likelihood are computed over the
 * same outcome space and can be compared directly.
 */
export function smoothedPmf(margins, { alpha = 1 } = {}) {
  const hist = histogram(margins);
  const lo = MARGIN_SUPPORT.min, hi = MARGIN_SUPPORT.max;
  const support = hi - lo + 1;
  const denom = hist.n + alpha * support;
  return {
    at: k => {
      const i = Math.round(k);
      if (i < lo || i > hi) return alpha / denom;   // outside support: the floor, never zero
      return ((hist.counts.get(i) ?? 0) + alpha) / denom;
    },
    n: hist.n, support, alpha, histogram: hist
  };
}

/* -------------------------------------------------- the empirical corpus */

/**
 * Real margins from `game_lines`, one row per game (home side only), which is
 * the same corpus and the same one-row-per-game discipline `calibrationReport`
 * and `margin-distribution.js` both use.
 */
export function empiricalMargins({ from = 1999, to = 2100, query = rows } = {}) {
  const games = query(
    `SELECT season, week, spread, team_score, opp_score FROM game_lines
      WHERE home = 1 AND team_score IS NOT NULL AND opp_score IS NOT NULL
        AND season BETWEEN ? AND ?`, from, to);
  return games.map(g => ({ season: g.season, week: g.week, spread: g.spread,
    margin: g.team_score - g.opp_score }));
}

/**
 * Does this corpus look like real NFL margins?
 *
 * The gate exists because `game_lines` is also where synthetic test fixtures
 * live, and a shape verdict computed against a synthetic corpus is a confident
 * statement about nothing. Deliberately crude and deliberately wide: it only
 * has to separate football from not-football.
 */
export function corpusRealism(margins) {
  const hist = histogram(margins);
  const three = absMassAt(hist, 3), seven = absMassAt(hist, 7);
  const gap3 = three - REFERENCE_MARGIN_MASS.abs_mass[3];
  const gap7 = seven - REFERENCE_MARGIN_MASS.abs_mass[7];
  const real = hist.n >= 200 && Math.abs(gap3) <= REALISM_TOLERANCE && Math.abs(gap7) <= REALISM_TOLERANCE;
  return {
    games: hist.n,
    abs_mass_3: r4(three), abs_mass_7: r4(seven),
    reference_abs_mass_3: REFERENCE_MARGIN_MASS.abs_mass[3],
    reference_abs_mass_7: REFERENCE_MARGIN_MASS.abs_mass[7],
    tolerance: REALISM_TOLERANCE,
    corpus_is_real: real,
    disposition: real ? null
      : hist.n < 200
        ? `only ${hist.n} completed games with scores are attached; a shape verdict needs a real corpus, ` +
          'and this module will not issue one against a fixture.'
        : `the attached corpus puts ${(three * 100).toFixed(2)}% of games on |margin| 3 and ` +
          `${(seven * 100).toFixed(2)}% on 7, against ${(REFERENCE_MARGIN_MASS.abs_mass[3] * 100).toFixed(2)}% ` +
          `and ${(REFERENCE_MARGIN_MASS.abs_mass[7] * 100).toFixed(2)}% measured on 6,991 real games. That is ` +
          'not NFL football, so it is almost certainly a synthetic fixture; held-out shape scores against it ' +
          'would be a confident number about nothing and are reported as null.'
  };
}

/* ------------------------------------------------------------ the checks */

/**
 * Key-number mass, absolute and relative to a documented neighbouring bin.
 *
 * `actual` is optional: when a real corpus is attached the reference is
 * measured from it, otherwise the documented 1999-2024 table stands in and the
 * result says which was used.
 */
export function keyNumberCheck(simMargins, { actualMargins = null, tolerance = 0.025, ratioTolerance = 0.6 } = {}) {
  const sim = histogram(simMargins);
  const act = actualMargins ? histogram(actualMargins) : null;
  const useCorpus = act != null && act.n >= 200;

  return REFERENCE_MARGIN_MASS.key_numbers.map(({ margin: k, neighbour, reference_ratio }) => {
    const simMass = absMassAt(sim, k);
    const simNeighbour = absMassAt(sim, neighbour);
    const simRatio = simNeighbour > 0 ? simMass / simNeighbour : null;

    const refMass = useCorpus ? absMassAt(act, k) : REFERENCE_MARGIN_MASS.abs_mass[k];
    const refNeighbourMass = useCorpus ? absMassAt(act, neighbour) : REFERENCE_MARGIN_MASS.abs_mass[neighbour];
    const refRatio = useCorpus
      ? (refNeighbourMass > 0 ? refMass / refNeighbourMass : null)
      : reference_ratio;

    const massGap = simMass - refMass;
    const ratioGap = simRatio != null && refRatio != null ? simRatio - refRatio : null;
    return {
      check: `key number ${k} mass`,
      margin: k, neighbour,
      simulated_mass: r4(simMass), reference_mass: r4(refMass), mass_gap: r4(massGap),
      simulated_neighbour_mass: r4(simNeighbour), reference_neighbour_mass: r4(refNeighbourMass),
      simulated_ratio: r2(simRatio), reference_ratio: r2(refRatio), ratio_gap: r2(ratioGap),
      reference_from: useCorpus ? 'attached corpus' : 'documented 1999-2024 table',
      tolerance, ratio_tolerance: ratioTolerance,
      pass: Math.abs(massGap) <= tolerance && ratioGap != null && Math.abs(ratioGap) <= ratioTolerance
    };
  });
}

/**
 * The signed spike check — the one the home-field bug needed.
 *
 * THE STATISTIC, AND WHY IT IS NOT THE OBVIOUS ONE. The obvious version is
 * "how far does bin k sit above the average of bins k-1 and k+1", and it does
 * not work. A margin curve is tilted and curved, so that quantity is large for
 * perfectly ordinary bins, and it is large by DIFFERENT amounts at +k and -k
 * because they sit at different distances from the mode. Measured on this
 * engine, ordinary non-key bins carry between -8 and +10 units of that bias,
 * which is bigger than the effect being looked for. Grading on it would have
 * been grading on curvature.
 *
 * What actually cancels is the MIRROR RATIO. Write R(k) = n(+k) / n(-k). For
 * any exponentially tilted distribution — which is exactly the form the fitted
 * margin model uses for the effect of a spread, and the form a home-field
 * advantage takes — log R(k) is linear in k, whatever the underlying shape. So
 * its second difference
 *
 *     d(k) = log R(k) - (log R(k-1) + log R(k+1)) / 2
 *
 * is zero for ANY tilted version of ANY symmetric base shape, including one
 * with key-number spikes in it, because a spike at |k| raises n(+k) and n(-k)
 * together and cancels in the ratio. It is non-zero precisely when probability
 * has been added to ONE side of one bin, which is what a mechanical artefact
 * does and what football does not.
 *
 * The standard error is Poisson on the four counts involved (Var(log n) = 1/n),
 * so `z` is in real units and does not drift with the number of trials.
 *
 * The control bins are reported alongside — the same statistic at ordinary
 * non-key margins — so a reader can see the metric's own residual spread on
 * this engine instead of taking the tolerance on trust.
 */
export function signedSpikeCheck(simMargins, { zTolerance = 4, controls = CONTROL_BINS } = {}) {
  const hist = histogram(simMargins);
  const count = k => hist.counts.get(k) ?? 0;

  /** log n(+k) - log n(-k), with its Poisson variance, or null if a bin is empty. */
  const logRatio = k => {
    const up = count(k), down = count(-k);
    if (up < 1 || down < 1) return null;
    return { value: Math.log(up) - Math.log(down), variance: 1 / up + 1 / down };
  };

  const secondDifference = k => {
    const here = logRatio(k), lo = logRatio(k - 1), hi = logRatio(k + 1);
    if (!here || !lo || !hi) return { d: null, z: null };
    const d = here.value - (lo.value + hi.value) / 2;
    const variance = here.variance + (lo.variance + hi.variance) / 4;
    return { d, z: variance > 0 ? d / Math.sqrt(variance) : null,
      plus: count(k), minus: count(-k) };
  };

  const controlValues = controls
    .map(k => ({ margin: k, z: r2(secondDifference(k).z) }))
    .filter(c => c.z != null);
  const controlMax = controlValues.length ? Math.max(...controlValues.map(c => Math.abs(c.z))) : null;

  return REFERENCE_MARGIN_MASS.key_numbers.map(({ margin: k }) => {
    const { d, z, plus, minus } = secondDifference(k);
    return {
      check: `signed spike symmetry at ${k}`,
      margin: k,
      plus_count: plus ?? count(k), minus_count: minus ?? count(-k),
      mirror_log_ratio_second_difference: r4(d),
      z: r2(z),
      control_bins: controlValues,
      largest_control_z: r2(controlMax),
      tolerance: zTolerance,
      pass: z != null && Math.abs(z) <= zTolerance,
      reads: 'A key number is a property of football and appears on BOTH sides of zero, so it cancels ' +
        'out of the mirror ratio n(+k)/n(-k). A positive z means probability has been added to +' + k +
        ' and not to -' + k + ' — a mechanical artefact of the engine rather than a scoring pattern, ' +
        'which is exactly what a one-shot home-field touchdown produced at +7. Compare against ' +
        'largest_control_z, the same statistic at ordinary non-key margins on this same sample.'
    };
  });
}

/**
 * Tie mass, which is the overtime check.
 *
 * Reported against the attached corpus when it is real; otherwise the number is
 * reported with `pass: null`, because there is no committed tie constant to
 * check it against and inventing a threshold would be inventing a metric.
 */
export function tieMassCheck(simMargins, { actualMargins = null, tolerance = 0.15 } = {}) {
  const sim = histogram(simMargins);
  const simTie = massAt(sim, 0);
  const simNeighbour = (massAt(sim, -1) + massAt(sim, 1)) / 2;
  const simRatio = simNeighbour > 0 ? simTie / simNeighbour : null;

  let refRatio = null, refTie = null, games = null;
  if (actualMargins) {
    const act = histogram(actualMargins);
    if (act.n >= 200) {
      games = act.n;
      refTie = massAt(act, 0);
      const refNeighbour = (massAt(act, -1) + massAt(act, 1)) / 2;
      refRatio = refNeighbour > 0 ? refTie / refNeighbour : null;
    }
  }

  const gap = simRatio != null && refRatio != null ? simRatio - refRatio : null;
  return {
    check: 'tie mass (overtime)',
    simulated_tie_rate: r4(simTie),
    simulated_tie_vs_neighbours: r2(simRatio),
    reference_tie_rate: r4(refTie), reference_tie_vs_neighbours: r2(refRatio), reference_games: games,
    gap: r2(gap), tolerance,
    pass: gap == null ? null : Math.abs(gap) <= tolerance,
    disposition: refRatio != null ? null
      : 'No real corpus attached and margin-distribution.js documents no tie constant, so this is reported ' +
        'and not graded. Read it directly: real post-overtime football leaves margin 0 far below its own ' +
        'neighbours at +/-1; a simulator whose overtime is missing leaves it at or above them.'
  };
}

/* --------------------------------------------------- mode 2: bucket score */

/**
 * Cross-entropy and Brier of the simulated distribution against the documented
 * 1999-2024 bucket table.
 *
 * This is a proper score over a real seven-outcome distribution — the six
 * measured |margin| buckets plus "everything else" — and it is the expected
 * surprise, under the simulator, of a random real game's bucket. It needs no
 * per-game corpus, which is the entire reason it exists: it is the one honest
 * number available on a machine with no access to the real history.
 *
 * It is a FLOOR. Six buckets say nothing about conditioning on the spread and
 * nothing about the parts of the distribution they do not touch. It is labelled
 * `evidence: 'documented-buckets'` everywhere it is returned so it cannot be
 * mistaken for the held-out result.
 */
export function documentedBucketScores(simMargins) {
  const sim = histogram(simMargins);
  const ref = REFERENCE_MARGIN_MASS.abs_mass;
  const refOther = 1 - DOCUMENTED_BUCKETS.reduce((s, k) => s + ref[k], 0);

  const buckets = DOCUMENTED_BUCKETS.map(k => {
    const p = absMassAt(sim, k);
    return { bucket: `|margin| = ${k}`, simulated: r4(p), reference: r4(ref[k]), gap: r4(p - ref[k]), raw: p, refP: ref[k] };
  });
  const simOther = 1 - buckets.reduce((s, b) => s + b.raw, 0);
  buckets.push({ bucket: 'everything else', simulated: r4(simOther), reference: r4(refOther),
    gap: r4(simOther - refOther), raw: simOther, refP: refOther });

  // Cross-entropy H(ref, sim) and its excess over the reference's own entropy,
  // which is the part attributable to the simulator rather than to football's
  // own irreducible spread.
  let crossEntropy = 0, entropy = 0, brier = 0, totalVariation = 0;
  for (const b of buckets) {
    const p = Math.max(b.raw, 1e-9);
    crossEntropy += -b.refP * Math.log(p);
    entropy += -b.refP * Math.log(Math.max(b.refP, 1e-9));
    brier += (b.raw - b.refP) ** 2;
    totalVariation += Math.abs(b.raw - b.refP);
  }
  totalVariation /= 2;

  return {
    evidence: 'documented-buckets',
    source: REFERENCE_MARGIN_MASS.source,
    simulated_games: sim.n,
    buckets: buckets.map(({ raw, refP, ...rest }) => rest),
    log_loss: r5(crossEntropy),
    reference_entropy: r5(entropy),
    excess_log_loss: r5(crossEntropy - entropy),
    brier: r5(brier),
    total_variation_distance: r4(totalVariation),
    key_mass_3_and_7: r4(absMassAt(sim, 3) + absMassAt(sim, 7)),
    reference_key_mass_3_and_7: r4(REFERENCE_MARGIN_MASS.key_mass_3_and_7),
    note: 'A FLOOR, not a held-out result: seven buckets of real football, no conditioning on the line. ' +
      'excess_log_loss is the part of the surprise attributable to the simulator rather than to the ' +
      'irreducible spread of real margins, so it is zero for a perfect match and only grows.'
  };
}

/* --------------------------------------------- mode 1: held-out scoring */

/**
 * Score a simulated distribution against a set of real margins.
 *
 * `margin_pmf_log_likelihood_per_game` is deliberately the same statistic
 * `margin-distribution.js#walkForwardCalibration` returns under that exact
 * name, computed over the same integer support, so the simulator and the fitted
 * margin model can be compared on one scale instead of two.
 */
export function scoreAgainstMargins(simMargins, actualMargins, { alpha = 1 } = {}) {
  const pmf = smoothedPmf(simMargins, { alpha });
  const lo = MARGIN_SUPPORT.min, hi = MARGIN_SUPPORT.max;

  // Multiclass Brier needs the pmf's own squared mass, which is fixed across
  // games, so it is accumulated once rather than per game.
  let sumSquares = 0;
  for (let k = lo; k <= hi; k++) sumSquares += pmf.at(k) ** 2;

  let logLik = 0, brier = 0, n = 0;
  const keyAcc = new Map(REFERENCE_MARGIN_MASS.key_numbers.map(({ margin }) =>
    [margin, { logLoss: 0, brier: 0, hits: 0, predicted: 0 }]));
  const keyProb = new Map(REFERENCE_MARGIN_MASS.key_numbers.map(({ margin }) =>
    [margin, pmf.at(margin) + pmf.at(-margin)]));

  for (const m of actualMargins) {
    if (!Number.isFinite(m)) continue;
    const k = Math.round(m);
    const p = pmf.at(k);
    logLik += Math.log(p);
    brier += sumSquares - 2 * p + 1;
    n++;
    for (const [key, acc] of keyAcc) {
      const q = keyProb.get(key);
      const won = Math.abs(k) === key;
      const s = scoreLeg(q, won);
      acc.logLoss += s.logLoss; acc.brier += s.brier; acc.predicted += q;
      if (won) acc.hits++;
    }
  }

  return {
    games: n,
    margin_pmf_log_likelihood_per_game: n ? r5(logLik / n) : null,
    margin_brier_per_game: n ? r5(brier / n) : null,
    smoothing_alpha: alpha,
    support: { min: lo, max: hi },
    key_number_events: [...keyAcc].map(([key, acc]) => ({
      margin: key,
      predicted_rate: n ? r4(acc.predicted / n) : null,
      observed_rate: n ? r4(acc.hits / n) : null,
      calibration_error: n ? r4(acc.hits / n - acc.predicted / n) : null,
      log_loss: n ? r5(acc.logLoss / n) : null,
      brier: n ? r5(acc.brier / n) : null
    }))
  };
}

/**
 * The held-out harness: refit the simulator's inputs on prior seasons only,
 * predict the next one, score the real margins, pool.
 *
 * Identical in structure to `margin-distribution.js#walkForwardCalibration`,
 * which is the point — the walk-forward loop, the strictly-prior training
 * window, the pooled accumulator and the per-season table are that function's,
 * reused rather than re-derived, with `blendedProfiles({ season: s - 1 })`
 * standing in for `fitMarginModel` on the prefix.
 */
export function walkForwardShapeCalibration({
  sampler, from = 2022, to = null, trials = 400, games = 40, homeFieldPoints = 1.6, query = rows
} = {}) {
  if (typeof sampler !== 'function') return { error: 'walkForwardShapeCalibration needs a margin sampler' };
  const actual = empiricalMargins({ query });
  if (!actual.length) return { error: 'no completed games with scores in game_lines' };
  const realism = corpusRealism(actual.map(g => g.margin));
  const lastSeason = to ?? Math.max(...actual.map(g => g.season));

  const seasons = [];
  const pooledSim = [], pooledActual = [];
  for (let season = from; season <= lastSeason; season++) {
    const target = actual.filter(g => g.season === season);
    if (!target.length) continue;
    const sample = sampler({
      trials, games, season: season - 1, homeFieldPoints, seed: 100000 + season * 97
    });
    if (sample.error || !sample.margins.length) {
      seasons.push({ season, skipped: sample.error ?? 'no simulated margins' });
      continue;
    }
    const scored = scoreAgainstMargins(sample.margins, target.map(g => g.margin));
    seasons.push({
      season, profiles_from_season: sample.profile_season, profile_cutoff: sample.profile_cutoff,
      simulated_games: sample.margins.length, real_games: target.length,
      margin_pmf_log_likelihood_per_game: scored.margin_pmf_log_likelihood_per_game,
      margin_brier_per_game: scored.margin_brier_per_game
    });
    pooledSim.push(...sample.margins);
    pooledActual.push(...target.map(g => g.margin));
  }

  if (!pooledActual.length) {
    return { error: 'no test season could be simulated from strictly-prior profiles',
      corpus: realism, seasons };
  }

  const pooledScore = scoreAgainstMargins(pooledSim, pooledActual);
  const keyChecks = keyNumberCheck(pooledSim, { actualMargins: pooledActual });
  const spikeChecks = signedSpikeCheck(pooledSim);
  const tie = tieMassCheck(pooledSim, { actualMargins: pooledActual });
  const graded = [...keyChecks, ...spikeChecks, tie];

  return {
    evidence: realism.corpus_is_real ? 'held-out' : 'held-out-against-unverified-corpus',
    test_seasons: { from, to: lastSeason },
    trials_each: trials, matchups_each: games,
    corpus: realism,
    pooled: pooledScore,
    documented_buckets: documentedBucketScores(pooledSim),
    checks: realism.corpus_is_real ? graded
      : graded.map(c => ({ ...c, pass: null, disposition: realism.disposition })),
    calibrated: realism.corpus_is_real ? graded.every(c => c.pass !== false) : null,
    failing: realism.corpus_is_real ? graded.filter(c => c.pass === false).map(c => c.check) : null,
    seasons,
    note: 'Walk-forward and cutoff-safe: the team profiles behind every simulated season come from ' +
      'seasons strictly before it, the same discipline nfl-drive-sim.js#backtest() uses. The statistic ' +
      'is the one margin-distribution.js#walkForwardCalibration reports under the same name, over the ' +
      'same integer support, so the two are directly comparable.'
  };
}

/**
 * The shape half of `calibrationReport` — runs anywhere, grades what it can.
 *
 * When a real corpus is attached this measures its references from it and
 * grades; when it is not, the key-number and bucket checks fall back to the
 * documented 1999-2024 table and the tie check reports without grading. Either
 * way the signed-spike check grades, because it needs no reference at all: it
 * compares the engine against its own neighbouring bins.
 */
export function simulatorShapeReport({
  sampler, trials = 400, games = 40, season = null, homeFieldPoints = 1.6, query = rows
} = {}) {
  if (typeof sampler !== 'function') return { error: 'simulatorShapeReport needs a margin sampler' };
  const sample = sampler({ trials, games, season, homeFieldPoints, seed: 424242 });
  if (sample.error) return { error: sample.error };

  const actual = empiricalMargins({ query }).map(g => g.margin);
  const realism = corpusRealism(actual);
  const actualForReference = realism.corpus_is_real ? actual : null;

  const keyChecks = keyNumberCheck(sample.margins, { actualMargins: actualForReference });
  const spikeChecks = signedSpikeCheck(sample.margins);
  const tie = tieMassCheck(sample.margins, { actualMargins: actualForReference });
  const checks = [...keyChecks, ...spikeChecks, tie];
  const graded = checks.filter(c => c.pass != null);

  return {
    simulated_matchups: sample.matchups, trials_each: sample.trials_each,
    simulated_games: sample.margins.length,
    profile_season: sample.profile_season, profile_cutoff: sample.profile_cutoff,
    home_field_points: sample.home_field_points,
    corpus: realism,
    checks,
    documented_buckets: documentedBucketScores(sample.margins),
    shape_calibrated: graded.length ? graded.every(c => c.pass) : null,
    failing: graded.filter(c => !c.pass).map(c => c.check),
    ungraded: checks.filter(c => c.pass == null).map(c => c.check),
    note: 'Shape, not moments. The three moment checks in calibrationReport passed throughout the ' +
      'period when the engine was emitting a discrete probability spike at margin +7 and nothing at -7; ' +
      'these are the checks that see that. For the strong version, which scores against real games ' +
      'season by season, run walkForwardShapeCalibration on a populated database.'
  };
}
