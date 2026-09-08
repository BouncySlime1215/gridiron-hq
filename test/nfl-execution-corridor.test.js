import test from 'node:test';
import assert from 'node:assert/strict';

const {
  deriveCorridorThreshold, marketLineCorridorCheck, CORRIDOR_TARGET_FLAG_RATE,
  MARKET_LINE_CORRIDOR_POINTS, CORRIDOR_DERIVATION
} = await import('../server/services/nfl-execution-corridor.js');

/*
 * WHAT THIS FILE CAN AND CANNOT PROVE — read this before extending it.
 *
 * `CORRIDOR_DERIVATION`'s three out-of-fold rows (11.684 / 11.781 / 11.514,
 * fit on 2718/5838/8958 real audit-run-17 rows) and the alpha-test's 2.647x
 * MSE ratio were measured once, via a read-only connection, against
 * `nfl_weekly_expert_examples` in the live database. This worktree — like
 * every agent worktree, by the project's own no-concurrent-writers rule — has
 * no live database and no extracted copy of that table, so those specific
 * numbers cannot be independently re-derived from here. Faking a 12,318-row
 * substrate shaped to reproduce them would be worse than not testing them at
 * all: it would dress up a coincidence as a re-verification.
 *
 * So this suite does two honest things instead: (1) proves the DERIVATION
 * FUNCTION and the CHECK FUNCTION are correct on data whose right answer can
 * be computed by hand, with no dependency on any live table; (2) checks that
 * the frozen CORRIDOR_DERIVATION record is internally self-consistent — the
 * kind of arithmetic/documentation slip a hand-edit could introduce without
 * ever touching the underlying (unavailable-here) evidence.
 */

test('deriveCorridorThreshold: quantile matches a value computable by hand', () => {
  // 1..101, ascending. The 99.5th percentile by linear interpolation is
  // index (101-1)*0.995 = 99.5 -> halfway between values[99]=100 and
  // values[100]=101 -> 100.5.
  const residuals = Array.from({ length: 101 }, (_, i) => i + 1);
  const result = deriveCorridorThreshold(residuals, { targetFlagRate: 0.005 });
  assert.equal(result.corridor_points, 100.5);
  assert.equal(result.sample_size, 101);
  assert.equal(result.target_flag_rate, 0.005);
});

test('deriveCorridorThreshold only uses magnitude — sign never changes the threshold', () => {
  const signed = [-10, -5, -1, 1, 5, 10, -20, 20, -3, 3];
  const unsigned = signed.map(Math.abs);
  assert.deepEqual(
    deriveCorridorThreshold(signed).corridor_points,
    deriveCorridorThreshold(unsigned).corridor_points
  );
});

test('deriveCorridorThreshold reports a realized in-sample flag rate close to a uniform population\'s target', () => {
  // A large, evenly spaced population: the in-sample flag rate at the fitted
  // quantile should sit close to the requested target by construction.
  const residuals = Array.from({ length: 20000 }, (_, i) => (i + 1) / 20000);
  const result = deriveCorridorThreshold(residuals, { targetFlagRate: 0.005 });
  assert.ok(Math.abs(result.realized_in_sample_flag_rate - 0.005) < 0.001);
});

test('deriveCorridorThreshold rejects malformed input rather than silently coercing it', () => {
  assert.throws(() => deriveCorridorThreshold('not an array'), /residuals must be an array/);
  assert.throws(() => deriveCorridorThreshold([1, 2, 3], { targetFlagRate: 0 }), /targetFlagRate/);
  assert.throws(() => deriveCorridorThreshold([1, 2, 3], { targetFlagRate: 1 }), /targetFlagRate/);
  assert.throws(() => deriveCorridorThreshold([1, 2, 3], { targetFlagRate: -0.1 }), /targetFlagRate/);
});

test('deriveCorridorThreshold on an empty or all-non-finite sample reports zero usable rows rather than throwing', () => {
  assert.equal(deriveCorridorThreshold([]).sample_size, 0);
  assert.equal(deriveCorridorThreshold([]).corridor_points, null);
  assert.equal(deriveCorridorThreshold([NaN, undefined, 'x']).sample_size, 0);
});

test('marketLineCorridorCheck: a divergence past the corridor is needs_review, with the right sign-agnostic magnitude', () => {
  const outside = marketLineCorridorCheck({ modelLine: -3.5, marketLine: -20, corridorPoints: 11.5 });
  assert.equal(outside.verdict, 'needs_review');
  assert.equal(outside.divergence_points, 16.5);
  assert.equal(outside.percentile_of_project_history, '>99.5th');
  assert.match(outside.reason, /16\.5 points/);

  // Same magnitude, opposite sign, should verdict identically.
  const oppositeSign = marketLineCorridorCheck({ modelLine: -20, marketLine: -3.5, corridorPoints: 11.5 });
  assert.equal(oppositeSign.verdict, 'needs_review');
  assert.equal(oppositeSign.divergence_points, -16.5);
});

test('marketLineCorridorCheck: a divergence inside the corridor passes with no reason attached', () => {
  const inside = marketLineCorridorCheck({ modelLine: -3.5, marketLine: -4, corridorPoints: 11.5 });
  assert.equal(inside.verdict, 'inside_corridor');
  assert.equal(inside.divergence_points, 0.5);
  assert.equal(inside.reason, null);
  assert.equal(inside.percentile_of_project_history, null);
});

test('marketLineCorridorCheck: exactly at the boundary is inside, not outside — the check is strictly greater-than', () => {
  const atBoundary = marketLineCorridorCheck({ modelLine: 0, marketLine: -11.5, corridorPoints: 11.5 });
  assert.equal(atBoundary.verdict, 'inside_corridor');
  const justPast = marketLineCorridorCheck({ modelLine: 0, marketLine: -11.500001, corridorPoints: 11.5 });
  assert.equal(justPast.verdict, 'needs_review');
});

test('marketLineCorridorCheck: a missing line is not_evaluated, never a silent pass', () => {
  assert.equal(marketLineCorridorCheck({ modelLine: null, marketLine: -4 }).verdict, 'not_evaluated');
  assert.equal(marketLineCorridorCheck({ modelLine: -3.5, marketLine: undefined }).verdict, 'not_evaluated');
  assert.equal(marketLineCorridorCheck({ modelLine: NaN, marketLine: -4 }).verdict, 'not_evaluated');
  assert.equal(marketLineCorridorCheck({}).verdict, 'not_evaluated');
});

test('marketLineCorridorCheck rejects a non-positive corridor width rather than silently disabling the check', () => {
  assert.throws(() => marketLineCorridorCheck({ modelLine: -3.5, marketLine: -4, corridorPoints: 0 }));
  assert.throws(() => marketLineCorridorCheck({ modelLine: -3.5, marketLine: -4, corridorPoints: -5 }));
});

test('marketLineCorridorCheck defaults to the shipped MARKET_LINE_CORRIDOR_POINTS when none is supplied', () => {
  const result = marketLineCorridorCheck({ modelLine: 0, marketLine: -MARKET_LINE_CORRIDOR_POINTS - 1 });
  assert.equal(result.corridor_points, MARKET_LINE_CORRIDOR_POINTS);
  assert.equal(result.verdict, 'needs_review');
});

/* ---------------------------------------- self-consistency of the frozen record */

test('the review budget and the shipped corridor width are the stated, unaltered constants', () => {
  assert.equal(CORRIDOR_TARGET_FLAG_RATE, 0.005);
  assert.equal(MARKET_LINE_CORRIDOR_POINTS, 11.5);
});

test('CORRIDOR_DERIVATION is frozen at every level a future edit might accidentally mutate', () => {
  assert.ok(Object.isFrozen(CORRIDOR_DERIVATION));
  assert.ok(Object.isFrozen(CORRIDOR_DERIVATION.out_of_fold));
  assert.ok(Object.isFrozen(CORRIDOR_DERIVATION.out_of_fold[0]));
  assert.ok(Object.isFrozen(CORRIDOR_DERIVATION.alpha_test));
  assert.ok(Object.isFrozen(CORRIDOR_DERIVATION.rejected_forms));
});

test('the shipped 11.5 sits below every fold\'s own fitted threshold — "rounded down" actually means down', () => {
  const fitted = CORRIDOR_DERIVATION.out_of_fold.map(f => f.fitted_threshold_points);
  assert.ok(MARKET_LINE_CORRIDOR_POINTS < Math.min(...fitted),
    'a corridor claimed to be a conservative rounding-down of every fold\'s fit must not exceed the smallest of them');
});

test('every fold\'s realized out-of-fold flag rate is within an order of magnitude of the 0.5% target', () => {
  // Not a re-derivation (the raw rows aren't available here) — a sanity bound
  // on the recorded numbers: a threshold that actually targets 0.5% should
  // not realize a flag rate of, say, 5% or 0.005% on held-out data.
  for (const fold of CORRIDOR_DERIVATION.out_of_fold) {
    assert.ok(fold.realized_flag_rate > 0.001 && fold.realized_flag_rate < 0.02,
      `season ${fold.test_season}: realized_flag_rate ${fold.realized_flag_rate} is implausibly far from the 0.5% target`);
  }
});

test('the fitted threshold is stable across training blocks, as the derivation\'s own rationale claims', () => {
  const fitted = CORRIDOR_DERIVATION.out_of_fold.map(f => f.fitted_threshold_points);
  const spread = Math.max(...fitted) - Math.min(...fitted);
  assert.ok(spread < 1, `a form claimed stable across seasons should not spread more than ~1 point; got ${spread}`);
});

test('the alpha test\'s premise holds on its own recorded numbers: flagged outputs are worse, and the interval excludes zero', () => {
  const { inside_corridor, flagged, difference_week_clustered_95 } = CORRIDOR_DERIVATION.alpha_test;
  assert.ok(flagged.model_over_market_mse_ratio > inside_corridor.model_over_market_mse_ratio,
    'a divergence past the corridor should be recorded as worse relative to the market than one inside it');
  assert.ok(difference_week_clustered_95[0] > 0,
    'the premise ("past the corridor is error, not edge") is only measured, not assumed, if the interval excludes zero');
});

test('every rejected form is recorded with a reason, not silently dropped', () => {
  assert.ok(CORRIDOR_DERIVATION.rejected_forms.length >= 2);
  for (const form of CORRIDOR_DERIVATION.rejected_forms) {
    assert.ok(form.form && form.reason, 'a rejected form kept without its reason is indistinguishable from one never tried');
  }
});

test('the training population sizes grow monotonically across expanding chronological folds', () => {
  const rows = CORRIDOR_DERIVATION.out_of_fold.map(f => f.train_rows);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i] > rows[i - 1], 'an expanding-window fold protocol must never shrink the training set across folds');
  }
});
