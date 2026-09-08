import test from 'node:test';
import assert from 'node:assert/strict';

const {
  weekClusteredMeanCi, evaluateClvWindow, replayClvDownsizeLadder, currentClvDownsizeMultiplier,
  applyClvDownsize, CLV_DOWNSIZE_LEVELS, CLV_DOWNSIZE_POLICY, CLV_DOWNSIZE_DERIVATION
} = await import('../server/services/nfl-execution-clv-downsize.js');

/* ------------------------------------------------------- CI machinery */

test('weekClusteredMeanCi treats each week as one observation regardless of how many bets it holds', () => {
  // Two weeks, wildly different bet counts, both centered on the same mean —
  // the CI should reflect two clusters of evidence, not eleven individual bets.
  const observations = [
    ...Array.from({ length: 10 }, () => ({ week: 1, clv: 0.02 })),
    { week: 2, clv: -0.02 }
  ];
  const ci = weekClusteredMeanCi(observations, { width: 0.90 });
  assert.equal(ci.n_weeks, 2);
  assert.equal(ci.n_observations, 11);
  assert.ok(Math.abs(ci.mean) < 1e-9); // (0.02 + -0.02) / 2 as week-level means, not bet-weighted
});

test('weekClusteredMeanCi returns null with fewer than two distinct weeks', () => {
  assert.equal(weekClusteredMeanCi([{ week: 1, clv: 0.01 }]), null);
  assert.equal(weekClusteredMeanCi([]), null);
});

test('weekClusteredMeanCi: a wider requested width never produces a narrower interval', () => {
  const observations = Array.from({ length: 8 }, (_, w) => ({ week: w + 1, clv: (w % 2 === 0 ? 1 : -1) * 0.03 }));
  const narrow = weekClusteredMeanCi(observations, { width: 0.80 });
  const wide = weekClusteredMeanCi(observations, { width: 0.99 });
  assert.ok(wide.upper - wide.lower > narrow.upper - narrow.lower);
});

/* --------------------------------------------------------- single window */

test('evaluateClvWindow refuses to evaluate below the evidence floor, and says so', () => {
  const tooFew = evaluateClvWindow(
    Array.from({ length: 5 }, (_, i) => ({ week: i + 1, clv: -0.05 })), CLV_DOWNSIZE_POLICY
  );
  assert.equal(tooFew.evaluated, false);
  assert.equal(tooFew.action, 'hold');
});

test('evaluateClvWindow downsizes only when the CI is entirely below the expectation, not on a point estimate alone', () => {
  // Six weeks, consistently and materially negative CLV -> confident miss.
  const clearMiss = Array.from({ length: 6 }, (_, w) =>
    Array.from({ length: 6 }, () => ({ week: w + 1, clv: -0.08 }))).flat();
  const result = evaluateClvWindow(clearMiss, CLV_DOWNSIZE_POLICY);
  assert.equal(result.evaluated, true);
  assert.equal(result.action, 'downsize');
  assert.ok(result.ci.upper < 0);
});

test('evaluateClvWindow recovers only when the CI is entirely above the expectation', () => {
  const clearRecovery = Array.from({ length: 6 }, (_, w) =>
    Array.from({ length: 6 }, () => ({ week: w + 1, clv: 0.08 }))).flat();
  const result = evaluateClvWindow(clearRecovery, CLV_DOWNSIZE_POLICY);
  assert.equal(result.action, 'recover');
  assert.ok(result.ci.lower > 0);
});

test('evaluateClvWindow holds when the CI straddles the expectation', () => {
  // Alternating weeks: some clearly positive, some clearly negative -> high
  // variance across weeks, CI should straddle zero.
  const straddling = [1, 2, 3, 4, 5, 6].flatMap(w =>
    Array.from({ length: 6 }, () => ({ week: w, clv: w % 2 === 0 ? 0.15 : -0.15 })));
  const result = evaluateClvWindow(straddling, CLV_DOWNSIZE_POLICY);
  assert.equal(result.action, 'hold');
});

/* -------------------------------------------------------------- ladder */

test('replayClvDownsizeLadder never moves more than one rung per non-overlapping block', () => {
  // Every week catastrophically negative — even so, the ladder can only step
  // once per completed 6-week block, never straight to the floor.
  const history = Array.from({ length: 24 }, (_, w) =>
    Array.from({ length: 6 }, () => ({ week: w + 1, clv: -0.2 }))).flat();
  const trace = replayClvDownsizeLadder(history, CLV_DOWNSIZE_POLICY);
  for (let i = 1; i < trace.length; i++) {
    assert.ok(Math.abs(trace[i].level - trace[i - 1].level) <= 1, 'the ladder moved more than one rung in one step');
  }
  // By the end of four full blocks of unambiguous misses, it should have
  // reached the floor.
  assert.equal(trace[trace.length - 1].level, CLV_DOWNSIZE_LEVELS.length - 1);
  assert.equal(trace[trace.length - 1].multiplier, 0);
});

test('replayClvDownsizeLadder never downsizes on a consistently positive CLV stream', () => {
  const history = Array.from({ length: 24 }, (_, w) =>
    Array.from({ length: 6 }, () => ({ week: w + 1, clv: 0.05 }))).flat();
  const trace = replayClvDownsizeLadder(history, CLV_DOWNSIZE_POLICY);
  assert.ok(trace.every(t => t.level === 0));
});

test('replayClvDownsizeLadder is a pure function — the same history and policy always produce the same trace', () => {
  const history = Array.from({ length: 12 }, (_, w) =>
    Array.from({ length: 6 }, (_, i) => ({ week: w + 1, clv: (i % 2 ? 1 : -1) * 0.03 }))).flat();
  const first = replayClvDownsizeLadder(history, CLV_DOWNSIZE_POLICY);
  const second = replayClvDownsizeLadder(history, CLV_DOWNSIZE_POLICY);
  assert.deepEqual(first, second);
});

test('currentClvDownsizeMultiplier defaults to full size with no history at all', () => {
  assert.equal(currentClvDownsizeMultiplier([], CLV_DOWNSIZE_POLICY), 1);
});

test('applyClvDownsize clamps to [0, 1] and never amplifies a stake', () => {
  assert.equal(applyClvDownsize(0.10, 0.5), 0.05);
  assert.equal(applyClvDownsize(0.10, 2), 0.1, 'a multiplier above 1 must never inflate the stake');
  assert.equal(applyClvDownsize(0.10, -1), 0, 'a negative multiplier must clamp to zero, not flip the sign');
  assert.equal(applyClvDownsize(0.10, null), 0.1, 'a missing multiplier means "no downsize", not "no stake"');
});

/* ------------------------------------------------- the seeded OOF evidence */

/*
 * Reproduces CLV_DOWNSIZE_DERIVATION's headline numbers from the identical
 * seeded generator described in the module's own header — the same
 * tuning/holdout seed split, the same null/drift regimes, the same frozen
 * policy. Unlike test/nfl-execution-corridor.test.js, this IS fully
 * reproducible here: the substrate is a declared, deterministic simulation,
 * not personal historical data this worktree has no access to.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussianFactory(rand) {
  let spare = null;
  return () => {
    if (spare != null) { const v = spare; spare = null; return v; }
    let u, v, s;
    do { u = rand() * 2 - 1; v = rand() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const mul = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * mul;
    return u * mul;
  };
}
const { weeks: WEEKS, observations_per_week: OBS_PER_WEEK, clv_sigma: SIGMA,
  drift_onset_week: ONSET, drift_mean: DRIFT_MEAN } = CLV_DOWNSIZE_DERIVATION.simulation;

function simulatePath(seed, drift) {
  const gauss = gaussianFactory(mulberry32(seed));
  const history = [];
  for (let w = 1; w <= WEEKS; w++) {
    const mean = drift && w >= ONSET ? DRIFT_MEAN : 0;
    for (let i = 0; i < OBS_PER_WEEK; i++) history.push({ week: w, clv: mean + gauss() * SIGMA });
  }
  return history;
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function runNullSet(seeds) {
  let everLeft = 0, totalChanges = 0;
  for (const seed of seeds) {
    const trace = replayClvDownsizeLadder(simulatePath(seed, false), CLV_DOWNSIZE_POLICY);
    if (trace.some(t => t.level !== 0)) everLeft++;
    totalChanges += trace.filter(t => t.action === 'downsize' || t.action === 'recover').length;
  }
  return { ever_left_1x: +(everLeft / seeds.length).toFixed(4), mean_ladder_changes_per_path: +(totalChanges / seeds.length).toFixed(4) };
}

function runDriftSet(seeds) {
  let detected = 0, lagSum = 0, lagCount = 0, levelSum = 0, avoidedSum = 0, fixedSum = 0;
  for (const seed of seeds) {
    const trace = replayClvDownsizeLadder(simulatePath(seed, true), CLV_DOWNSIZE_POLICY);
    const firstDownsize = trace.find(t => t.action === 'downsize' && t.week >= ONSET);
    if (firstDownsize) { detected++; lagSum += (firstDownsize.week - ONSET); lagCount++; }
    levelSum += trace[trace.length - 1].level;
    for (const t of trace) if (t.week >= ONSET) { fixedSum += 1; avoidedSum += (1 - t.multiplier); }
  }
  return {
    detected_before_week_60: +(detected / seeds.length).toFixed(4),
    mean_weeks_to_first_downsize_after_onset: lagCount ? +(lagSum / lagCount).toFixed(3) : null,
    mean_ladder_level_reached_by_week_60: +(levelSum / seeds.length).toFixed(3),
    units_at_risk_avoided_vs_fixed_1x: +(avoidedSum / fixedSum).toFixed(4)
  };
}

test('reproduces CLV_DOWNSIZE_DERIVATION.tuning_null exactly, from the same seeded generator', () => {
  const seeds = range(1, CLV_DOWNSIZE_DERIVATION.tuning_null.paths);
  const result = runNullSet(seeds);
  assert.equal(result.ever_left_1x, CLV_DOWNSIZE_DERIVATION.tuning_null.ever_left_1x);
  assert.equal(result.mean_ladder_changes_per_path, CLV_DOWNSIZE_DERIVATION.tuning_null.mean_ladder_changes_per_path);
});

test('reproduces CLV_DOWNSIZE_DERIVATION.tuning_drift exactly', () => {
  const seeds = range(1, CLV_DOWNSIZE_DERIVATION.tuning_drift.paths);
  const result = runDriftSet(seeds);
  assert.deepEqual(result, {
    detected_before_week_60: CLV_DOWNSIZE_DERIVATION.tuning_drift.detected_before_week_60,
    mean_weeks_to_first_downsize_after_onset: CLV_DOWNSIZE_DERIVATION.tuning_drift.mean_weeks_to_first_downsize_after_onset,
    mean_ladder_level_reached_by_week_60: CLV_DOWNSIZE_DERIVATION.tuning_drift.mean_ladder_level_reached_by_week_60,
    units_at_risk_avoided_vs_fixed_1x: CLV_DOWNSIZE_DERIVATION.tuning_drift.units_at_risk_avoided_vs_fixed_1x
  });
});

test('reproduces CLV_DOWNSIZE_DERIVATION.holdout_null exactly, on seeds disjoint from tuning', () => {
  const seeds = range(1001, 1000 + CLV_DOWNSIZE_DERIVATION.holdout_null.paths);
  assert.equal(seeds.some(s => s <= 300), false, 'holdout seeds must never overlap the tuning seed block');
  const result = runNullSet(seeds);
  assert.equal(result.ever_left_1x, CLV_DOWNSIZE_DERIVATION.holdout_null.ever_left_1x);
  assert.equal(result.mean_ladder_changes_per_path, CLV_DOWNSIZE_DERIVATION.holdout_null.mean_ladder_changes_per_path);
});

test('reproduces CLV_DOWNSIZE_DERIVATION.holdout_drift exactly', () => {
  const seeds = range(1001, 1000 + CLV_DOWNSIZE_DERIVATION.holdout_drift.paths);
  const result = runDriftSet(seeds);
  assert.deepEqual(result, {
    detected_before_week_60: CLV_DOWNSIZE_DERIVATION.holdout_drift.detected_before_week_60,
    mean_weeks_to_first_downsize_after_onset: CLV_DOWNSIZE_DERIVATION.holdout_drift.mean_weeks_to_first_downsize_after_onset,
    mean_ladder_level_reached_by_week_60: CLV_DOWNSIZE_DERIVATION.holdout_drift.mean_ladder_level_reached_by_week_60,
    units_at_risk_avoided_vs_fixed_1x: CLV_DOWNSIZE_DERIVATION.holdout_drift.units_at_risk_avoided_vs_fixed_1x
  });
});

test('the holdout false-trigger rate is reported as measured, not rounded toward the friendlier tuning number', () => {
  // This is the number the header/derivation are explicit about NOT prettifying:
  // holdout (11.33%) really is higher than tuning (7.67%).
  assert.ok(CLV_DOWNSIZE_DERIVATION.holdout_null.ever_left_1x > CLV_DOWNSIZE_DERIVATION.tuning_null.ever_left_1x);
});

/* ---------------------------------------- structural / documentation checks */

test('CLV_DOWNSIZE_LEVELS is a bounded, descending ladder ending at exactly zero', () => {
  assert.deepEqual(CLV_DOWNSIZE_LEVELS, [1, 0.5, 0.25, 0]);
  assert.ok(Object.isFrozen(CLV_DOWNSIZE_LEVELS));
});

test('CLV_DOWNSIZE_DERIVATION is frozen and every rejected form carries a reason', () => {
  assert.ok(Object.isFrozen(CLV_DOWNSIZE_DERIVATION));
  assert.ok(CLV_DOWNSIZE_DERIVATION.rejected_forms.length >= 3);
  for (const form of CLV_DOWNSIZE_DERIVATION.rejected_forms) {
    assert.ok(form.form && form.reason);
  }
});

test('the shipped policy is the one actually scored in the derivation record', () => {
  assert.equal(CLV_DOWNSIZE_POLICY.window_weeks, 6);
  assert.equal(CLV_DOWNSIZE_POLICY.ci_width, 0.98);
});
