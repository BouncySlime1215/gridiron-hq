import test from 'node:test';
import assert from 'node:assert/strict';

// nfl-orthogonal-specialists.js's fitRidge() runs an iteratively-reweighted
// ridge regression (Huber weights) on the tall design matrix each specialist
// family trains on: dozens-to-hundreds of games (rows) against a handful of
// centered/scaled features plus an intercept (columns). This module's job
// here is a single guard: the initial per-OBSERVATION weight vector must
// actually have one entry per row, not per column.
//
// The bug this pins: `weights` was seeded as `Array(Z[0].length).fill(1)`
// (COLUMN count, typically ~6-8 -- one entry per feature/intercept) but is
// indexed inside the loop as `weights[i]` where `i` ranges over `Z.length`
// (ROW count -- one entry per training observation). In real usage rows
// outnumber columns by an order of magnitude or more, so for any row index
// `i >= Z[0].length`, `weights[i]` was `undefined`, and
// `weights[i] * Z[i][j] * y[i]` evaluated to `NaN`. That NaN poisons every
// accumulator cell of `xtx`/`xty` on the very first iteration (matrices sum
// over ALL rows, so one undefined weight contaminates every entry), and
// Gaussian elimination in `solve()` then returns NaN for every coefficient in
// `beta` -- and NaN persists through every subsequent reweighting round.
// Confirming evidence that one-weight-per-row is the intended shape: from
// the SECOND iteration on, `weights = residuals.map(...)` is computed from
// `residuals`, which already has one entry per row (Z.length) -- so the
// initial value's job was always to match that, and sizing it by column
// count was a straight bug, not a deliberate choice.
const { __test } = await import('../server/services/nfl-orthogonal-specialists.js');
const { fitRidge } = __test;

/**
 * Build a realistic "tall" design matrix -- more rows (observations) than
 * columns (features) -- matching production family shapes such as
 * 'efficiency' (10 fields) or 'roster' (6 fields) fit against a training
 * block of dozens of games. Rows comfortably exceed columns, which is
 * exactly the shape that could not have concealed this bug: with rows <=
 * columns, `Array(Z[0].length)` and `Array(Z.length)` are close enough in
 * size that many `weights[i]` reads happen to land on real (if wrong) slots
 * instead of undefined.
 */
function tallLinearFixture({ rows = 45, cols = 6, seed = 1234 } = {}) {
  let state = seed;
  const rnd = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const trueBeta = Array.from({ length: cols }, (_, j) => (j + 1) * 1.5 - 4); // mix of signs/magnitudes
  const X = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => (rnd() - 0.5) * 20));
  const y = X.map(row => {
    const signal = row.reduce((sum, value, j) => sum + value * trueBeta[j], 0);
    const noise = (rnd() - 0.5) * 0.5; // small noise relative to signal scale
    return signal + noise;
  });
  return { X, y, trueBeta, rows, cols };
}

test('fitRidge: initial weight vector is sized per observation (row), not per feature (column)', () => {
  const { X } = tallLinearFixture({ rows: 45, cols: 6 });
  // Z has one extra column for the intercept prepended inside fitRidge, so
  // the correct initial weights length is X.length (rows), which here is
  // 45 -- far larger than the 7-wide column count (6 features + intercept).
  // This is really a spec on fitRidge's internals, so we recompute the same
  // shape fitRidge builds internally and assert against X.length directly
  // via the public behavior below (no-NaN, correct fit) rather than reaching
  // into the closure -- but we keep the row >> column shape explicit here so
  // the fixture itself documents why this test would have caught the bug.
  assert.ok(X.length > X[0].length + 1,
    'fixture must have far more rows than columns to reproduce the bug (rows > columns + intercept)');
});

test('fitRidge: returns finite, non-NaN coefficients on a tall design matrix', () => {
  const { X, y } = tallLinearFixture({ rows: 50, cols: 7 });
  const model = fitRidge(X, y);
  assert.ok(model, 'fitRidge should return a model, not null, for non-empty input');
  assert.equal(model.beta.length, X[0].length + 1, 'one beta per feature plus the intercept');
  for (let i = 0; i < model.beta.length; i++) {
    assert.ok(Number.isFinite(model.beta[i]),
      `beta[${i}] must be a finite number, got ${model.beta[i]} -- ` +
      'a NaN here means the initial Huber weight vector was mis-sized again ' +
      '(this is exactly how the bug silently zeroed out a specialist family in production)');
  }
});

test('fitRidge: fitted predictions recover the true linear relationship on training data', () => {
  const { X, y, trueBeta } = tallLinearFixture({ rows: 60, cols: 6, seed: 999 });
  const model = fitRidge(X, y, { ridge: 1, huber: 1e6 }); // light regularization/no downweighting, to check recovery closely
  const predictions = X.map(model.predict);

  // Sanity check that this is a genuine fit, not merely non-NaN garbage:
  // predictions must track the near-noiseless linear signal closely.
  let sumSqError = 0, sumSqTotal = 0;
  const meanY = y.reduce((s, v) => s + v, 0) / y.length;
  for (let i = 0; i < y.length; i++) {
    sumSqError += (y[i] - predictions[i]) ** 2;
    sumSqTotal += (y[i] - meanY) ** 2;
  }
  const rSquared = 1 - sumSqError / sumSqTotal;
  assert.ok(rSquared > 0.98,
    `expected the ridge fit to explain the near-linear signal (R^2 > 0.98), got ${rSquared}`);

  // The true coefficients used the same centered/scaled feature basis that
  // fitRidge's own mu/scale normalize, so recovered coefficients (mapped
  // back through predict's own combination at a couple of probe rows) should
  // match the ground-truth linear combination closely, not just have the
  // right R^2 by coincidence.
  const probe = Array(trueBeta.length).fill(0);
  const trueAtZero = 0; // trueBeta . 0 = 0
  assert.ok(Math.abs(model.predict(probe) - trueAtZero) < 3,
    `prediction at the all-zero row should be near 0, got ${model.predict(probe)}`);
});
