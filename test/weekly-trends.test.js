/**
 * The statistics behind every trend claim.
 *
 * The p-value is the load-bearing number in this whole feature: it is what
 * separates "this offence changed" from "this offence played two games". A
 * wrong tail here would not produce an obvious bug, it would produce confident
 * findings every week forever, which is much worse. So it is checked against
 * published t-table values rather than against itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { welch, twoSidedP, TRACKED } from '../server/services/weekly-trends.js';

test('two-sided p matches published t-table values', () => {
  // [t, df, p] from standard tables.
  const cases = [
    [2.228, 10, 0.0500], [3.169, 10, 0.0100], [1.812, 10, 0.1000],
    [2.086, 20, 0.0500], [2.845, 20, 0.0100], [1.725, 20, 0.1000],
    [4.303, 2, 0.0500], [2.776, 4, 0.0500], [2.571, 5, 0.0500],
    [1.000, 10, 0.3409], [2.000, 30, 0.0546]
  ];
  for (const [t, df, expected] of cases) {
    const got = twoSidedP(t, df);
    assert.ok(Math.abs(got - expected) < 0.002,
      `t=${t} df=${df}: expected ~${expected}, got ${got}`);
  }
});

test('p is symmetric in the sign of t', () => {
  for (const [t, df] of [[2.5, 8], [1.1, 15], [0.3, 4]]) {
    assert.ok(Math.abs(twoSidedP(t, df) - twoSidedP(-t, df)) < 1e-9,
      `asymmetric at t=${t}, df=${df}`);
  }
});

test('p is 1 at t=0 and approaches 0 for extreme t', () => {
  assert.equal(twoSidedP(0, 5), 1);
  assert.ok(twoSidedP(50, 10) < 1e-6, 'an enormous t should have a vanishing p');
});

test('a degenerate t or df never produces a p outside [0,1]', () => {
  for (const [t, df] of [[NaN, 5], [1, NaN], [1, 0], [1, -3], [Infinity, 5]]) {
    const p = twoSidedP(t, df);
    assert.ok(Number.isFinite(p) && p >= 0 && p <= 1, `t=${t} df=${df} produced ${p}`);
  }
});

test('welch refuses a sample too small to have a variance', () => {
  assert.equal(welch([1], [1, 2, 3]), null);
  assert.equal(welch([1, 2, 3], [1]), null);
});

test('identical samples produce no difference and no significance', () => {
  const w = welch([3, 4, 5, 6], [3, 4, 5, 6]);
  assert.equal(w.t, 0);
  assert.equal(w.p, 1);
  assert.equal(w.effect, 0);
});

test('welch survives zero variance in one arm without dividing by zero', () => {
  // A team that ran exactly 60 plays three weeks running is real, and a naive
  // pooled-variance test divides by zero on it.
  const w = welch([60, 60, 60], [50, 55, 45, 52]);
  assert.ok(w && Number.isFinite(w.t) && Number.isFinite(w.p), `produced ${JSON.stringify(w)}`);
  assert.ok(w.p < 0.05, 'a ten-play jump against a tight baseline should be significant');
});

test('both arms constant and equal does not claim a change', () => {
  const w = welch([60, 60, 60], [60, 60, 60]);
  // Zero variance both sides: there is no test to run, and the honest answer is
  // "no evidence of a difference" rather than infinite confidence in one.
  assert.ok(w === null || w.p === 1 || w.t === 0,
    `constant-equal arms claimed something: ${JSON.stringify(w)}`);
});

test('a large real shift is detected', () => {
  const w = welch([30, 32, 31], [10, 12, 11, 9, 13]);
  assert.ok(w.p < 0.001, `clear shift reported p=${w.p}`);
  assert.ok(w.effect > 3, `clear shift reported a small effect size ${w.effect}`);
});

test('noise around the same mean is not detected', () => {
  const w = welch([10, 14, 8], [12, 9, 13, 11, 10, 12]);
  assert.ok(w.p > 0.2, `noise reported as significant at p=${w.p}`);
});

test('every tracked metric declares a fantasy consequence in both directions', () => {
  // A trend without a consequence is trivia, and the UI reads these fields
  // directly — a missing one renders as "undefined" in a sentence.
  for (const t of TRACKED) {
    assert.ok(t.key && t.label, `metric missing key or label: ${JSON.stringify(t)}`);
    assert.ok(t.up && t.down, `${t.key} does not explain both directions`);
    assert.ok(t.helps, `${t.key} does not say who it helps`);
    assert.ok(t.direction === 'up' || t.direction === 'down',
      `${t.key} has no valid favourable direction`);
  }
});

test('the tracked list is pre-specified and small enough to correct across', () => {
  // The whole design rests on testing a fixed shortlist rather than scanning
  // 178 metrics and reporting whatever moved. If this list grows large, the
  // Šidák correction gets punishing and the premise needs revisiting.
  assert.ok(TRACKED.length >= 10 && TRACKED.length <= 25,
    `tracked list is ${TRACKED.length}; the correction assumes a curated shortlist`);
  const keys = new Set(TRACKED.map(t => t.key));
  assert.equal(keys.size, TRACKED.length, 'duplicate metric in the tracked list');
});
