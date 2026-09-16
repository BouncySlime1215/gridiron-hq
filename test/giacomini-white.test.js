import test from 'node:test';
import assert from 'node:assert/strict';
import { giacominiWhite, dieboldMariano } from '../server/services/forecast-comparison.js';
import { holm } from '../server/services/stats-util.js';

/*
 * FINAL ORDER #4 (2026-09-16, RUNBOOK §10.4).
 *
 * Two instruments, one purpose: stop the promotion gate from believing things
 * that thirty simultaneous tests and an unconditional average would let
 * through.
 *
 *   giacominiWhite  conditional equal predictive ability. DM asks "was A
 *                   better on average"; GW asks "given what was knowable at
 *                   the time, could you tell WHEN A would be better". The
 *                   latter is the right question when the models are refit at
 *                   every walk-forward cutoff, which ours are.
 *   holm            the multiplicity correction now applied across the
 *                   residual gate's declared family.
 *
 * Deterministic fixtures throughout -- a seeded generator, no database.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normal = (rand, sd = 1) => {
  let s = 0;
  for (let i = 0; i < 12; i++) s += rand();
  return (s - 6) * sd;
};

test('GW reduces to DM when the conditioning vector is the constant alone', () => {
  // This is the recipe's own exit test. With h = [1] the GW Wald statistic is
  // the SQUARE of an unconditional t on the loss differential, so the two
  // tests must agree about whether there is anything there.
  const rand = mulberry32(11);
  const n = 240;
  const lossA = [], lossB = [];
  for (let i = 0; i < n; i++) {
    // A is better ON AVERAGE but the differential must VARY -- a constant
    // differential has no variance to test, which both GW and DM correctly
    // refuse (DM's t explodes to ~1e15 on a zero-variance denominator).
    const base = 10 + normal(rand, 2);
    lossA.push(base - 0.6 + normal(rand, 1.2));
    lossB.push(base + normal(rand, 1.2));
  }
  const gw = giacominiWhite(lossA, lossB, { h: lossA.map(() => [1]) });
  const dm = dieboldMariano(lossA, lossB, { horizon: 1 });
  assert.equal(gw.ok, true, JSON.stringify(gw));
  assert.equal(gw.df, 1);
  assert.equal(dm.ok, true);
  // Both must see the same real effect and agree on direction.
  assert.ok(gw.p < 0.01, `GW should detect a real constant edge, got p=${gw.p}`);
  assert.ok(dm.pLess < 0.01, `DM should detect it too, got p=${dm.pLess}`);
  assert.equal(gw.favours, 'A');
  // And the Wald statistic should be in the neighbourhood of the squared t.
  const ratio = gw.statistic / (dm.statistic ** 2);
  assert.ok(ratio > 0.5 && ratio < 2.0,
    `Wald should be ~ the squared t (ratio ${ratio.toFixed(2)}); they use different variance estimators, so this is a sanity band, not an identity`);
});

test('GW finds a PREDICTABLE edge that DM averages away — the whole reason it exists', () => {
  // Construct a method that is better in exactly half the periods and worse in
  // the other half, alternating, so its AVERAGE edge is zero (DM sees nothing)
  // but the edge is perfectly predictable from the previous period (GW should
  // see it).
  const rand = mulberry32(99);
  const n = 400;
  const lossA = [], lossB = [];
  for (let i = 0; i < n; i++) {
    // Alternating sign so the AVERAGE edge is ~0, plus noise so the
    // conditioning terms are not perfectly deterministic (a deterministic
    // alternation makes Z's second component constant, i.e. singular).
    const swing = i % 2 === 0 ? -1.5 : 1.5;
    lossA.push(10 + swing + normal(rand, 0.6));
    lossB.push(10 + normal(rand, 0.6));
  }
  const dm = dieboldMariano(lossA, lossB, { horizon: 1 });
  const gw = giacominiWhite(lossA, lossB);   // default h = [1, lagged dL]
  assert.equal(gw.ok, true, JSON.stringify(gw));
  // DM's mean differential is ~0: no unconditional edge to find.
  assert.ok(Math.abs(gw.mean_loss_differential) < 0.35,
    `average edge should be ~0, got ${gw.mean_loss_differential}`);
  if (dm.ok) assert.ok(dm.pLess > 0.1, `DM should see no average edge, got ${dm.pLess}`);
  // GW conditions on the lag, which here predicts the sign perfectly.
  assert.ok(gw.p < 0.01, `GW should detect the predictable alternation, got p=${gw.p}`);
});

test('GW finds nothing in pure noise', () => {
  const rand = mulberry32(4242);
  const n = 300;
  const lossA = [], lossB = [];
  for (let i = 0; i < n; i++) {
    const base = 10 + normal(rand, 2);
    lossA.push(base + normal(rand, 0.5));
    lossB.push(base + normal(rand, 0.5));
  }
  const gw = giacominiWhite(lossA, lossB);
  assert.equal(gw.ok, true, JSON.stringify(gw));
  assert.ok(gw.p > 0.05, `expected no conditional predictability in noise, got p=${gw.p}`);
});

test('GW refuses rather than manufacturing a number from too little data', () => {
  assert.equal(giacominiWhite([1, 2, 3], [1, 2, 3]).ok, false);
  assert.equal(giacominiWhite([1, 2], [1]).ok, false);
  assert.equal(giacominiWhite([1, 2, NaN], [1, 2, 3]).ok, false);
  // A constant differential has no variance to condition on.
  const flat = giacominiWhite(new Array(200).fill(5), new Array(200).fill(5));
  assert.equal(flat.ok, false);
  assert.match(flat.reason, /collinear|no variance|not finite/);
});

test('GW p-values are in [0,1] across a range of effect sizes', () => {
  for (const edge of [0, 0.1, 0.5, 2, 10]) {
    const rand = mulberry32(7 + Math.round(edge * 10));
    const n = 200, lossA = [], lossB = [];
    for (let i = 0; i < n; i++) {
      const base = 10 + normal(rand, 2);
      lossA.push(base - edge + normal(rand, 1)); lossB.push(base + normal(rand, 1));
    }
    const gw = giacominiWhite(lossA, lossB);
    assert.equal(gw.ok, true);
    assert.ok(gw.p >= 0 && gw.p <= 1, `p out of range for edge ${edge}: ${gw.p}`);
    assert.ok(gw.statistic >= 0);
  }
});

/* ------------------------------------------- the multiplicity half of #4 */

test('Holm on a family of 31 p-values promotes only what survives correction', () => {
  // One genuinely strong result and thirty pieces of noise -- the exact shape
  // of the residual gate asking thirty components the same question.
  const family = [0.001, ...Array.from({ length: 30 }, (_, i) => 0.04 + i * 0.03)];
  const adjusted = holm(family);
  assert.equal(adjusted.length, 31);
  assert.ok(adjusted[0] <= 0.05, 'a p of 0.001 against 31 tests should still survive (0.001*31 = 0.031)');
  // Every raw 0.04 "pass" must die: 0.04 * 30 = 1.2, far above any threshold.
  for (let i = 1; i < adjusted.length; i++) {
    assert.ok(adjusted[i] > 0.05, `entry ${i} (raw ${family[i]}) must not survive correction`);
  }
  const rawPasses = family.filter(p => p <= 0.05).length;
  const holmPasses = adjusted.filter(p => p <= 0.05).length;
  assert.ok(rawPasses > holmPasses, `raw ${rawPasses} vs corrected ${holmPasses} — the gap is the multiplicity`);
});

test('Holm is monotone and never reports a corrected p below the raw one', () => {
  const family = [0.002, 0.01, 0.03, 0.2, 0.5, 0.9];
  const adjusted = holm(family);
  for (let i = 0; i < family.length; i++) {
    assert.ok(adjusted[i] >= family[i] - 1e-12,
      `correction must never make a p-value smaller (${adjusted[i]} < ${family[i]})`);
    assert.ok(adjusted[i] <= 1);
  }
  const sortedRaw = [...family].sort((a, b) => a - b);
  const sortedAdj = sortedRaw.map(p => adjusted[family.indexOf(p)]);
  for (let i = 1; i < sortedAdj.length; i++) {
    assert.ok(sortedAdj[i] >= sortedAdj[i - 1] - 1e-12, 'step-down monotonicity must hold');
  }
});

test('a family of one is uncorrected — correcting a single test would be superstition', () => {
  assert.deepEqual(holm([0.03]), [0.03]);
});
