/**
 * The conformal half-width in model-intelligence.js must be the finite-sample
 * split-conformal order statistic, not a plain empirical quantile.
 *
 * Why this test exists rather than a comment: the function was originally a
 * linear-interpolated empirical quantile while the surrounding method string
 * advertised "conformal residual intervals". That version has no coverage
 * guarantee, and the difference is invisible by inspection — it shows up only
 * as intervals a few percent too narrow, worst at the 95% level and worst on
 * small calibration sets, which is exactly where an under-wide interval reads
 * as a confident model instead of a thin sample.
 *
 * The defect was found by an independent second opinion: MAPIE, a reviewed
 * conformal-prediction library, run on the identical rows by
 * research/conformal/mapie_crosscheck.py. MAPIE's half-width reproduced the
 * order statistic below exactly on every fold and level. This test pins that
 * agreement in the Node suite so the correction cannot regress silently, and
 * so the guard does not depend on anyone re-running Python.
 *
 * research/ is NOT a runtime dependency of the app; nothing here imports it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { conformalHalfWidth } from '../server/services/model-intelligence.js';

/** The definition, written out independently of the implementation. */
function orderStatistic(values, p) {
  const a = [...values].sort((x, y) => x - y);
  const k = Math.min(Math.ceil((a.length + 1) * p), a.length);
  return a[k - 1];
}

/** The version that shipped before the cross-check, kept only to prove the gap is real. */
function empiricalQuantile(values, p) {
  const a = [...values].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

test('the half-width is the ceil((n+1)p)-th order statistic across sizes and levels', () => {
  for (const n of [5, 20, 103, 206, 309, 1000]) {
    // A deterministic, non-uniform spread: an interpolated quantile and an
    // order statistic coincide on evenly spaced data, which would make this
    // test pass against the buggy version.
    const values = Array.from({ length: n }, (_, i) => ((i * 37) % n) ** 1.4 / 10);
    for (const p of [0.5, 0.8, 0.9, 0.95, 0.99]) {
      assert.equal(conformalHalfWidth(values, p), orderStatistic(values, p),
        `n=${n} p=${p}`);
    }
  }
});

test('the correction is never narrower than the empirical quantile it replaced', () => {
  // The whole safety argument: the old formula was anti-conservative. If a
  // future edit ever makes the shipped half-width smaller than the plain
  // quantile, the coverage guarantee is gone again.
  for (const n of [20, 103, 309]) {
    const values = Array.from({ length: n }, (_, i) => ((i * 53) % n) ** 1.3 / 7);
    for (const p of [0.8, 0.95]) {
      assert.ok(conformalHalfWidth(values, p) >= empiricalQuantile(values, p),
        `n=${n} p=${p}: correction must not shrink the interval`);
    }
  }
});

test('the two formulas genuinely differ at the sizes this codebase calibrates on', () => {
  // Guards against a vacuous version of the test above. The outer folds
  // calibrate on roughly 100-300 games, so the gap must be visible there.
  const n = 103;
  const values = Array.from({ length: n }, (_, i) => ((i * 37) % n) ** 1.4 / 10);
  const corrected = conformalHalfWidth(values, 0.95);
  const old = empiricalQuantile(values, 0.95);
  assert.ok(corrected > old, 'at n=103, p=.95 the finite-sample term must bite');
});

test('degenerate inputs stay null rather than becoming a zero-width interval', () => {
  // A zero-width interval would be reported as 100%-confident, which is the
  // worst possible way for an empty calibration set to fail.
  assert.equal(conformalHalfWidth([], 0.95), null);
});

test('p = 1 clamps to the largest score instead of reading past the array', () => {
  // ceil((n+1)*1) = n+1, which is one past the end without the clamp.
  assert.equal(conformalHalfWidth([3, 1, 2], 1), 3);
});
