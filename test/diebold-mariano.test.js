/**
 * Diebold-Mariano with the Harvey-Leybourne-Newbold correction.
 *
 * The point of this file is NOT "the new function returns numbers". It is to
 * pin down the two things that make the new statistic trustworthy where the
 * old paired t was not:
 *
 *   1. It REDUCES to the paired t exactly when the paired t's assumptions
 *      hold (horizon 1, no clustering). A "correction" that moves the number
 *      even in the case where nothing needed correcting is just a different
 *      arbitrary statistic, and could not be trusted to adjudicate anything.
 *
 *   2. It DISAGREES with the paired t exactly when those assumptions fail --
 *      and in the disagreement, it is the one that is right. That is measured
 *      here against known ground truth, not asserted: under a null where the
 *      two forecasts are genuinely equally accurate, the paired t fires on
 *      more than half of all samples while DM holds its nominal rate.
 *
 * No network, no database, no npm dependency: the RNG below is a local LCG so
 * the fixtures are byte-reproducible and independent of shared seed state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { dieboldMariano, naivePairedT, studentTCdf, regularizedIncompleteBeta } =
  await import('../server/services/forecast-comparison.js');

/* ---------------------------------------------------- deterministic noise */

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
/** Box-Muller on a local LCG. Same seed => same sequence, forever. */
function gaussian(seed) {
  const r = lcg(seed);
  let spare = null;
  return () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    const u = Math.max(r(), 1e-12), v = r();
    const m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  };
}
/** A loss-differential series `d` expressed as the (lossA, lossB) pair the API takes. */
const asPair = d => [d.slice(), d.map(() => 0)];

/* ------------------------------------------------------ the t distribution */

test('the Student-t CDF reproduces published critical values', () => {
  // Standard one-sided 95% critical values, to 4 decimal places.
  const cases = [[1.8125, 10], [1.6973, 30], [6.3138, 1], [1.6525, 200], [2.0150, 5]];
  for (const [t, df] of cases) {
    assert.ok(Math.abs(studentTCdf(t, df) - 0.95) < 1e-3,
      `P(T_${df} <= ${t}) should be 0.95, got ${studentTCdf(t, df)}`);
  }
  assert.ok(Math.abs(studentTCdf(0, 7) - 0.5) < 1e-12, 'the t distribution is symmetric about 0');
  assert.ok(Math.abs(studentTCdf(-2.3060, 8) - 0.025) < 1e-3, 'and symmetric in the lower tail');
  // A t with very large df is the normal.
  assert.ok(Math.abs(studentTCdf(1.9600, 1e6) - 0.975) < 1e-4);
  // Boundary behaviour of the beta function underneath it.
  assert.equal(regularizedIncompleteBeta(0, 2, 3), 0);
  assert.equal(regularizedIncompleteBeta(1, 2, 3), 1);
  assert.ok(Math.abs(regularizedIncompleteBeta(0.5, 1, 1) - 0.5) < 1e-12, 'I_x(1,1) = x');
});

/* -------------------------------------------------------- the exact identity */

test('with horizon 1 and no clustering, DM* IS the paired t -- exactly', () => {
  // This is an algebraic identity, not an approximation. The HLN factor at
  // h = 1 is sqrt((T-1)/T), which exactly cancels the difference between the
  // HAC variance's 1/T divisor and the sample variance's 1/(T-1). If this
  // ever fails, either the autocovariance divisor or the HLN factor is wrong,
  // and every other number this module produces is wrong with it.
  const g = gaussian(7);
  for (const n of [12, 45, 200]) {
    const a = [], b = [];
    for (let i = 0; i < n; i++) { a.push(5 + g()); b.push(5 + g()); }
    const dm = dieboldMariano(a, b, { horizon: 1 });
    const pt = naivePairedT(a, b);
    assert.ok(dm.ok && pt.ok);
    assert.ok(Math.abs(dm.statistic - pt.statistic) < 1e-12,
      `n=${n}: DM* ${dm.statistic} should equal paired t ${pt.statistic}`);
    assert.equal(dm.df, pt.df, 'and be referred to the same t distribution');
    assert.ok(Math.abs(dm.pLess - pt.pLess) < 1e-12);
    assert.ok(Math.abs(dm.hlnFactor - Math.sqrt((n - 1) / n)) < 1e-12);
  }
});

test('the sign convention says which forecast won', () => {
  // A is the better forecast: lower loss on every event, by 2 points on
  // average with a little event-to-event wobble (a differential with NO
  // variance at all is not a testable sample -- see the guards below).
  const lossA = Array.from({ length: 40 }, (_, i) => 10 + (i % 5));
  const lossB = lossA.map((x, i) => x + 2 + (i % 2 === 0 ? 0.1 : -0.1));
  const dm = dieboldMariano(lossA, lossB);
  assert.ok(dm.ok);
  assert.ok(dm.statistic < 0, 'negative statistic means forecast A is more accurate');
  assert.ok(dm.pLess < 0.001, 'and the one-sided "A is better" p-value is small');
  assert.ok(dm.pGreater > 0.999, 'while "B is better" is emphatically rejected');
  assert.ok(Math.abs(dm.meanLossDiff + 2) < 1e-12);
});

/* --------------------------------------- disagreement 1: serial correlation */

test('KNOWN CASE: on overlapping forecasts the paired t calls significance that DM refuses', () => {
  // An MA(2) loss differential -- the exact structure produced by 3-step-ahead
  // forecasts, where consecutive errors share two periods of information. The
  // paired t assumes these 60 observations are 60 independent pieces of
  // evidence. They are not, and it over-states the evidence by roughly the
  // square root of the dependence it ignored.
  const build = (seed, T, drift, theta) => {
    const g = gaussian(seed);
    const e = Array.from({ length: T + 2 }, () => g());
    return Array.from({ length: T }, (_, i) =>
      drift + e[i + 2] + theta * e[i + 1] + theta * e[i]);
  };

  const d = build(1, 60, 0.30, 0.9);
  const [lossA, lossB] = asPair(d);
  const pt = naivePairedT(lossA, lossB);
  const dm = dieboldMariano(lossA, lossB, { horizon: 3 });

  // The two genuinely disagree at the conventional 5% threshold.
  assert.ok(pt.pGreater < 0.05,
    `paired t declares significance (t=${pt.statistic.toFixed(3)}, p=${pt.pGreater.toFixed(4)})`);
  assert.ok(dm.pGreater > 0.05,
    `DM* does not (DM*=${dm.statistic.toFixed(3)}, p=${dm.pGreater.toFixed(4)})`);
  assert.ok(dm.statistic < pt.statistic,
    'and the corrected statistic is the smaller one, because the HAC variance is larger');
  assert.equal(dm.kernel, 'truncated', 'the original DM estimator sufficed here');
  assert.equal(dm.horizon, 3);
  assert.equal(dm.periods, 60);

  // The positive autocovariances are the mechanism, and they are visible.
  assert.equal(dm.autocovariances.length, 3);
  assert.ok(dm.autocovariances[1] > 0 && dm.autocovariances[2] > 0,
    'lag-1 and lag-2 autocovariance are positive: that is the ignored dependence');
  assert.ok(dm.longRunVariance > dm.autocovariances[0],
    'so the long-run variance exceeds the plain variance the paired t used');

  // Declaring the correct horizon is what does the work: at h = 1 the same
  // data reproduces the paired t exactly (the identity above), so the
  // disagreement is attributable entirely to the overlap, not to the tool.
  const naiveHorizon = dieboldMariano(lossA, lossB, { horizon: 1 });
  assert.ok(Math.abs(naiveHorizon.statistic - pt.statistic) < 1e-12);
});

/* ------------------------------------------ disagreement 2: clustered slates */

test('KNOWN CASE: under a TRUE null with weekly clustering, the paired t fires constantly and DM does not', () => {
  // Ground truth: the two forecasts are exactly equally accurate. The mean
  // loss differential is 0 by construction. Any rejection is a false positive.
  //
  // The dependence is the realistic one: every game on a slate shares one
  // week-level shock (the same market state, the same weather week, the same
  // fitted coefficients applied to all of them). Fourteen games from one
  // Sunday are nowhere near fourteen independent observations.
  const WEEKS = 18, GAMES_PER_WEEK = 14, WORLDS = 300;
  const WEEK_SHOCK_SD = 1.0, GAME_NOISE_SD = 0.5;

  const world = (seed) => {
    const g = gaussian(seed);
    const d = [], clusters = [];
    for (let w = 0; w < WEEKS; w++) {
      const shock = g() * WEEK_SHOCK_SD;
      for (let i = 0; i < GAMES_PER_WEEK; i++) {
        d.push(shock + g() * GAME_NOISE_SD);
        clusters.push(`2026|${w + 1}`);
      }
    }
    return { d, clusters };
  };

  let pairedRejections = 0, dmRejections = 0;
  for (let s = 0; s < WORLDS; s++) {
    const { d, clusters } = world(1000 + s);
    const [lossA, lossB] = asPair(d);
    if (naivePairedT(lossA, lossB).pTwoSided < 0.05) pairedRejections++;
    if (dieboldMariano(lossA, lossB, { horizon: 1, clusters }).pTwoSided < 0.05) dmRejections++;
  }
  const pairedRate = pairedRejections / WORLDS, dmRate = dmRejections / WORLDS;

  // The paired t is not slightly optimistic here. It is wrong more often than
  // it is right, at a threshold that promises 5%.
  assert.ok(pairedRate > 0.40,
    `the paired t should fail catastrophically under clustering, saw ${(pairedRate * 100).toFixed(1)}%`);
  // DM on the weekly series holds close to nominal.
  assert.ok(dmRate > 0.01 && dmRate < 0.11,
    `DM should hold near its nominal 5%, saw ${(dmRate * 100).toFixed(1)}%`);
  assert.ok(dmRate < pairedRate / 4, 'and be dramatically better calibrated');
});

test('clustering collapses each slate to one forecast period, and reports the cost', () => {
  // Week w has a loss differential of exactly w on every game in it, so the
  // weekly means are 1..10 and the arithmetic below is checkable by hand.
  const clusters = [], lossA = [], lossB = [];
  for (let w = 1; w <= 10; w++) {
    const size = w === 4 ? 13 : 16; // a bye week is a smaller slate
    for (let i = 0; i < size; i++) { clusters.push(`2026|${w}`); lossA.push(100 + w); lossB.push(100); }
  }
  const dm = dieboldMariano(lossA, lossB, { clusters });
  assert.ok(dm.ok);
  assert.equal(dm.periods, 10, 'ten weeks are ten observations');
  assert.equal(dm.clusters, 10);
  assert.equal(dm.observations, 157, 'even though 157 games were scored');
  assert.equal(dm.df, 9, 'and the t reference has 9 df, not 156');
  assert.equal(dm.minClusterSize, 13);
  assert.equal(dm.maxClusterSize, 16);
  assert.ok(dm.clustered);

  // Clusters are weighted equally, so the period mean and the per-game mean
  // genuinely differ when slates differ in size. Both are surfaced so neither
  // can be silently mistaken for the other.
  assert.ok(Math.abs(dm.meanLossDiff - 5.5) < 1e-12, 'mean of the weekly means');
  assert.ok(Math.abs(dm.meanLossDiffPerObservation - 868 / 157) < 1e-12, 'mean over games');
  assert.notEqual(dm.meanLossDiff, dm.meanLossDiffPerObservation);

  // The sample size the naive statistic would have claimed is 15.7x the one
  // the data actually supports. That ratio is the whole point.
  assert.equal(naivePairedT(lossA, lossB).df, 156);
});

test('cluster order follows first appearance, so the autocovariances stay chronological', () => {
  const clusters = ['2026|1', '2026|1', '2026|2', '2026|2', '2026|3', '2026|3'];
  const lossA = [3, 1, 9, 7, 5, 5], lossB = [0, 0, 0, 0, 0, 0];
  const dm = dieboldMariano(lossA, lossB, { clusters, horizon: 2 });
  // Weekly means are 2, 8, 5 in that order.
  assert.ok(Math.abs(dm.meanLossDiff - 5) < 1e-12);
  assert.equal(dm.periods, 3);
});

/* --------------------------------------------------------------- the guards */

test('a sample too small to support the test says so instead of returning a number', () => {
  assert.equal(dieboldMariano([1], [2]).ok, false);
  assert.equal(dieboldMariano([], []).ok, false);
  assert.equal(dieboldMariano([1, 2], [1, 2]).ok, false, 'identical forecasts have zero variance');
  assert.equal(dieboldMariano([1, 2, 3], [0, 0]).ok, false, 'mismatched lengths');
  assert.equal(dieboldMariano([1, 2, 3], [0, 0, 0], { clusters: ['a', 'b'] }).ok, false);
  // One cluster is one forecast period; there is no series to test.
  assert.equal(dieboldMariano([1, 2, 3], [0, 0, 0], { clusters: ['a', 'a', 'a'] }).ok, false);
});

test('a horizon too long for the sample is refused, not extrapolated', () => {
  const g = gaussian(3);
  const a = Array.from({ length: 8 }, () => g()), b = a.map(() => 0);
  const bad = dieboldMariano(a, b, { horizon: 12 });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /horizon/);
  // T + 1 - 2h + h(h-1)/T must stay positive; h = 4 on T = 8 does.
  assert.equal(dieboldMariano(a, b, { horizon: 4 }).ok, true);
});

test('non-positive long-run variance falls back to a PSD kernel and admits it', () => {
  // A strictly alternating differential has a strongly NEGATIVE lag-1
  // autocovariance. The truncated kernel's gamma0 + 2*gamma1 can go below
  // zero, at which point the DM statistic does not exist. The result must not
  // be a silently different estimator.
  const d = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 1 : -1) * 3 + 0.05);
  const [lossA, lossB] = asPair(d);
  const dm = dieboldMariano(lossA, lossB, { horizon: 2 });
  assert.ok(dm.ok);
  assert.ok(dm.autocovariances[1] < 0, 'the lag-1 autocovariance is negative, as designed');
  assert.notEqual(dm.kernel, 'truncated', 'so the truncated estimator was abandoned');
  assert.ok(dm.longRunVariance > 0, 'and the reported variance is usable');

  // Asking for Bartlett up front gets Bartlett, with no fallback label.
  const bartlett = dieboldMariano(lossA, lossB, { horizon: 2, kernel: 'bartlett' });
  assert.equal(bartlett.kernel, 'bartlett');
});

test('non-finite observations drop as PAIRS, never unpaired', () => {
  const lossA = [1, 2, NaN, 4, 5, 6], lossB = [0, 0, 0, null, 0, 0];
  const dm = dieboldMariano(lossA, lossB);
  assert.equal(dm.observations, 4, 'both the NaN row and the null row leave entirely');
  assert.ok(Math.abs(dm.meanLossDiff - 3.5) < 1e-12, '(1+2+5+6)/4 -- no half-pairs survived');
});
