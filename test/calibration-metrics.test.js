/**
 * The two numbers a calibration report is read from (2026-09-20).
 *
 * `scripts/calibrate-playoff-odds.mjs` publishes a Brier score and a worst-bin gap
 * across 184,959 team-weeks, and a conclusion is drawn from them: that the
 * simulation's week-2 odds are worse than the league's own base rate. A reader has
 * no way to check that unless the two functions behind it can be shown to compute
 * what they claim, on inputs whose answers are known by hand.
 *
 * Both are pinned against hand-computed values, not against themselves, and the
 * bin rule is pinned on the case that actually matters: equal-COUNT bins, so a
 * bin holding four rows cannot be outvoted by one holding four hundred. Equal-width
 * bins would have hidden exactly the overconfidence the report found, because
 * almost every probability the simulator produces sits in the top and bottom bins.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { brierScore, reliabilityBins } from '../server/services/calibration-metrics.js';

const rows = ps => ps.map(([p, y]) => ({ p, y }));

/**
 * Hand-computed decimals are compared with a tolerance, and only where floating-point
 * associativity is the only difference. `0.04 + 0.04 + 0.25` summed left to right is not
 * bit-identical to the same value written as `0.33`, and pinning the implementation to one
 * summation order would be pinning an accident rather than the arithmetic. Exact equality
 * is kept below wherever the answer is representable: 0, 1, 0.25, and the bin counts.
 */
const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, message ?? `${actual} is not ${expected}`);

test('the Brier score is the mean squared error of a probability', () => {
  // (0.2-0)^2 + (0.8-1)^2 + (0.5-1)^2 = 0.04 + 0.04 + 0.25 = 0.33, over 3.
  close(brierScore(rows([[0.2, 0], [0.8, 1], [0.5, 1]])), 0.33 / 3);
  assert.equal(brierScore(rows([[1, 1], [0, 0]])), 0, 'a perfect predictor scores zero');
  assert.equal(brierScore(rows([[1, 0], [0, 1]])), 1, 'and a perfectly wrong one scores one');
  assert.equal(brierScore(rows([[0.5, 1], [0.5, 0]])), 0.25, 'a coin flip scores a quarter');
});

test('an alternative predictor is graded on the same rows, through `pick`', () => {
  // This is how the report compares the simulation against the base rate and the
  // fitted model without re-deriving the outcome column three times.
  const data = [{ p: 0.9, y: 1, base: 0.5 }, { p: 0.1, y: 0, base: 0.5 }];
  close(brierScore(data), 0.01);
  assert.equal(brierScore(data, r => r.base), 0.25);
});

test('bins hold equal COUNTS, not equal widths', () => {
  // Nine rows, three bins: three rows each, whatever their probabilities are. With
  // equal-width bins the first bin here would hold seven rows and the last one, and
  // the last bin's disagreement -- which is the overconfidence -- would be diluted
  // to nothing.
  const bins = reliabilityBins(rows([
    [0.01, 0], [0.02, 0], [0.03, 1],
    [0.04, 0], [0.05, 1], [0.06, 0],
    [0.90, 1], [0.95, 0], [1.00, 1]
  ]), 3);
  assert.equal(bins.length, 3);
  assert.deepEqual(bins.map(b => b.n), [3, 3, 3]);
  assert.equal(bins[0].observed, 1 / 3);
  assert.equal(bins[2].predicted, +((0.9 + 0.95 + 1) / 3).toFixed(4));
  assert.equal(bins[2].observed, 2 / 3);
});

test('the last bin takes the remainder, so no row is silently dropped', () => {
  // 10 rows into 3 bins is 3, 3, 4 -- not 3, 3, 3 with one row discarded, which
  // would quietly change the number the report prints.
  const bins = reliabilityBins(rows(
    Array.from({ length: 10 }, (_, i) => [i / 10, i % 2])), 3);
  assert.deepEqual(bins.map(b => b.n), [3, 3, 4]);
  assert.equal(bins.reduce((s, b) => s + b.n, 0), 10);
});

test('bins are ordered by probability regardless of input order', () => {
  const shuffled = reliabilityBins(rows([[0.9, 1], [0.1, 0], [0.5, 1], [0.2, 0]]), 2);
  assert.ok(shuffled[0].predicted < shuffled[1].predicted);
});

test('a perfectly calibrated set has no bin gap, and an overconfident one does', () => {
  // Two bins of ten: the low bin predicts 0.2 and 2 of 10 qualify; the high bin
  // predicts 0.8 and 8 of 10 do. Nothing to report.
  const calibrated = rows([
    ...Array.from({ length: 10 }, (_, i) => [0.2, i < 2 ? 1 : 0]),
    ...Array.from({ length: 10 }, (_, i) => [0.8, i < 8 ? 1 : 0])
  ]);
  const gap = bins => Math.max(...bins.map(b => Math.abs(b.predicted - b.observed)));
  assert.equal(gap(reliabilityBins(calibrated, 2)), 0);

  // The shape the report actually found: certainty at both ends, reality nearer the middle.
  const overconfident = rows([
    ...Array.from({ length: 10 }, (_, i) => [0, i < 1 ? 1 : 0]),
    ...Array.from({ length: 10 }, (_, i) => [1, i < 9 ? 1 : 0])
  ]);
  assert.equal(gap(reliabilityBins(overconfident, 2)), 0.1);
});

test('an empty set has no bins and no score to report', () => {
  assert.deepEqual(reliabilityBins([], 10), []);
  assert.equal(brierScore([]), null, 'a mean of nothing is not zero');
});
