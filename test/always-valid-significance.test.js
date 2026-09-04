import test from 'node:test';
import assert from 'node:assert/strict';
import { alwaysValidPValue, alwaysValidPath } from '../server/services/backtest-significance.js';
import { withRandomSeed, randn } from '../server/services/stats-util.js';

// The defining property of an always-valid / mSPRT p-value (Johari, Pekelis
// & Walsh, "Always Valid Inference," Operations Research 2022) is that its
// false-positive rate stays controlled EVEN WHEN CHECKED AT MANY SAMPLE
// SIZES ALONG THE SAME GROWING SEQUENCE — unlike a fixed-N p-value, whose
// 0.05 guarantee only holds at the one N it was computed for. Checking a
// fixed-N test repeatedly as data arrives and stopping the first time it
// clears 0.05 is a random walk crossing a boundary; it happens far more
// than 5% of the time. This test builds that exact scenario under a KNOWN
// true null (mean 0) and confirms: the naive fixed-N test's "ever rejected
// somewhere along the path" rate is well above 0.05, while the always-valid
// path's rate stays close to (and does not blow past) the nominal alpha.

const SIGMA = 1; // known, so the naive z-test and the mSPRT are both exact
const ALPHA = 0.05;
const CHECK_NS = [];
for (let n = 30; n <= 300; n += 10) CHECK_NS.push(n);

function normalCdf(z) {
  // Abramowitz-Stegun approximation, good to ~1e-7 — plenty for this test.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}
const twoSidedZP = (mean, n, sigma) => 2 * normalCdf(-Math.abs(mean) / (sigma / Math.sqrt(n)));

function simulateOnce(seed, trueMean) {
  const xs = [];
  withRandomSeed(seed, () => { for (let i = 0; i < 300; i++) xs.push(trueMean + SIGMA * randn()); });
  let naiveRejected = false, alwaysValidRejected = false;
  for (const n of CHECK_NS) {
    const prefix = xs.slice(0, n);
    const m = prefix.reduce((s, x) => s + x, 0) / n;
    if (twoSidedZP(m, n, SIGMA) < ALPHA) naiveRejected = true;
    const av = alwaysValidPValue(prefix, { sigma: SIGMA, tau: SIGMA });
    if (!av.error && av.p_always_valid < ALPHA) alwaysValidRejected = true;
  }
  return { naiveRejected, alwaysValidRejected };
}

test('under a true null, continuous peeking inflates a fixed-N test far past its nominal alpha', () => {
  const REPS = 400;
  let naiveHits = 0, alwaysValidHits = 0;
  for (let rep = 0; rep < REPS; rep++) {
    const { naiveRejected, alwaysValidRejected } = simulateOnce(1000 + rep, 0);
    if (naiveRejected) naiveHits++;
    if (alwaysValidRejected) alwaysValidHits++;
  }
  const naiveRate = naiveHits / REPS, alwaysValidRate = alwaysValidHits / REPS;

  // The naive fixed-N test, checked at ~28 sample sizes per run, rejects a
  // TRUE null far more than 5% of the time — this is the well-known
  // "peeking inflates false positives" failure the always-valid method
  // exists to fix.
  assert.ok(naiveRate > 0.15, `expected continuous peeking to inflate the naive false-positive rate well above 0.05, got ${naiveRate}`);
  // The always-valid check, examined at exactly the same sample sizes on
  // the exact same data, stays close to the nominal alpha.
  assert.ok(alwaysValidRate <= 0.09, `expected the always-valid check to control the false-positive rate near alpha=0.05 even under continuous peeking, got ${alwaysValidRate}`);
  assert.ok(alwaysValidRate < naiveRate, 'the always-valid check must reject the true null less often than the naive test does under continuous monitoring');
});

test('with a real, known effect, the always-valid check detects it with a large enough sequence', () => {
  const xs = [];
  withRandomSeed(42, () => { for (let i = 0; i < 500; i++) xs.push(0.3 + SIGMA * randn()); });
  const result = alwaysValidPValue(xs, { sigma: SIGMA, tau: SIGMA });
  assert.equal(result.error, undefined);
  assert.ok(result.p_always_valid < 0.01, `expected a clearly detectable known effect (theta=0.3, n=500) to produce a small always-valid p-value, got ${result.p_always_valid}`);
  assert.equal(result.n, 500);
});

test('the always-valid p-value is honest to check at ANY point along the same growing sequence, not just the end', () => {
  // Once the true effect is large enough to detect, further growth of the
  // sequence should only make the always-valid p-value more (or comparably)
  // extreme, not spuriously reverse the finding — path values late in a
  // clearly-detected run should not un-detect.
  const xs = [];
  withRandomSeed(7, () => { for (let i = 0; i < 400; i++) xs.push(0.5 + SIGMA * randn()); });
  const path = alwaysValidPath(xs, { sigma: SIGMA, tau: SIGMA });
  const tail = path.slice(-20).filter(p => p != null);
  assert.ok(tail.every(p => p < 0.05), 'a clearly detected true effect should stay detected across the tail of a long sequence');
});

test('refuses to compute on too short a sequence', () => {
  const result = alwaysValidPValue([1, 2, 3]);
  assert.ok(result.error);
});

test('a degenerate/empty-after-filtering sequence does not throw', () => {
  const result = alwaysValidPValue([NaN, null, undefined, Infinity]);
  assert.ok(result.error);
});

test('output stays within [0, 1] and reports the inputs used', () => {
  const xs = [];
  withRandomSeed(99, () => { for (let i = 0; i < 40; i++) xs.push(SIGMA * randn()); });
  const result = alwaysValidPValue(xs);
  assert.equal(result.error, undefined);
  assert.ok(result.p_always_valid >= 0 && result.p_always_valid <= 1);
  assert.equal(result.n, 40);
  assert.ok(Number.isFinite(result.sigma));
  assert.ok(Number.isFinite(result.tau));
});
