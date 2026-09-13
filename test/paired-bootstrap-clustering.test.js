import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// nfl-replay.js (imported below for its `uncertainty`) transitively imports
// server/db/index.js, which opens a real sqlite connection AT IMPORT TIME
// against GRIDIRON_DB_PATH -- or, unset, against the live server/data.sqlite.
// This must be set before that import, exactly like every other test that
// touches a service importing the db layer, so this file never depends on
// whatever the invoking shell happened to export.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-paired-bootstrap-clustering-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');
const { withRandomSeed, randn, weeklyClusterBootstrap } = await import('../server/services/stats-util.js');
const { uncertainty } = await import('../server/services/nfl-replay.js');
const { db } = await import('../server/db/index.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// pairedBootstrapDiff resamples individual units (player-weeks) uniformly
// with replacement. When several units in the array actually come from the
// same NFL game (shared weather, game script, pace), they are correlated in
// reality but shuffled independently by that resample — this inflates the
// apparent sample size and makes the reported 90% CI too narrow. This is the
// same effective-sample-size inflation documented in Brill, Yurko & Wyner,
// "Exploring the Difficulty of Estimating Win Probability: A Simulation
// Study" (arXiv:2406.16171, 2024): NFL play-by-play bootstraps achieved only
// ~60% actual coverage vs 90% nominal because within-game correlation was
// ignored by the resample.
//
// This test builds synthetic "games" of UNITS_PER_GAME correlated units each
// (a shared per-game shock plus per-unit noise) around a KNOWN true
// mean_diff, repeats the whole experiment across many independent "worlds,"
// and checks what fraction of the reported 90% CIs actually contain the
// true diff. The plain (ungrouped) call should under-cover badly; passing
// `groups` (one game id per unit) should restore ~90% coverage.

const UNITS_PER_GAME = 8;
const NUM_GAMES = 25; // n = 200 units per world, comparable to real call sites
const TRUE_DIFF = 0.4; // known ground truth: mean(B) - mean(A)
const WORLDS = 200;
const GAME_SHOCK_SD = 2.0; // per-game difficulty driver (weather, script, pace)
const ALPHA_A = 1.0, ALPHA_B = 0.3; // the two models react DIFFERENTLY to game difficulty,
// so the shock does not cancel out of (B - A) — it stays correlated within a game, which
// is the realistic case: harder games don't move every model's error by the same amount.
const UNIT_NOISE_SD = 0.6;

function buildWorld(seed) {
  const a = [], b = [], groups = [];
  withRandomSeed(seed, () => {
    for (let g = 0; g < NUM_GAMES; g++) {
      const gameShock = randn() * GAME_SHOCK_SD;
      for (let u = 0; u < UNITS_PER_GAME; u++) {
        const unitNoiseA = randn() * UNIT_NOISE_SD;
        const unitNoiseB = randn() * UNIT_NOISE_SD;
        a.push(5 + ALPHA_A * gameShock + unitNoiseA);
        b.push(5 + TRUE_DIFF + ALPHA_B * gameShock + unitNoiseB);
        groups.push(`game${g}`);
      }
    }
  });
  return { a, b, groups };
}

function coverageRate(useGroups) {
  let covered = 0;
  for (let w = 0; w < WORLDS; w++) {
    const { a, b, groups } = buildWorld(5000 + w);
    const opts = { iterations: 500, seed: 1 };
    if (useGroups) opts.groups = groups;
    const result = pairedBootstrapDiff(a, b, opts);
    const [lo, hi] = result.ci90;
    if (lo <= TRUE_DIFF && TRUE_DIFF <= hi) covered++;
  }
  return covered / WORLDS;
}

test('ungrouped bootstrap under-covers when units are correlated within game (reproduces the bug)', () => {
  const rate = coverageRate(false);
  assert.ok(rate < 0.85, `expected ungrouped 90% CIs to badly under-cover the true diff under within-game correlation, got ${rate}`);
});

test('game-clustered block bootstrap restores honest ~90% coverage on the same correlated data', () => {
  const rate = coverageRate(true);
  assert.ok(rate >= 0.85 && rate <= 0.97, `expected grouped 90% CIs to cover the true diff near the nominal 90% rate, got ${rate}`);
});

test('with no within-game correlation (zero-correlation control), ungrouped coverage is already honest', () => {
  // Control: exact same per-unit generative model as the "bug" world above
  // (same ALPHA_A/ALPHA_B reaction to a shock of the same size, so marginal
  // variance and true_diff are unchanged), except the shock is drawn fresh
  // per UNIT instead of shared per GAME — so there is no within-game
  // correlation left. The ungrouped resample's independence assumption is
  // then actually correct, and coverage should be close to nominal even
  // without `groups`.
  let covered = 0;
  for (let w = 0; w < WORLDS; w++) {
    const a = [], b = [];
    withRandomSeed(9000 + w, () => {
      for (let i = 0; i < NUM_GAMES * UNITS_PER_GAME; i++) {
        const shock = randn() * GAME_SHOCK_SD; // independent per unit, not shared within a game
        const unitNoiseA = randn() * UNIT_NOISE_SD;
        const unitNoiseB = randn() * UNIT_NOISE_SD;
        a.push(5 + ALPHA_A * shock + unitNoiseA);
        b.push(5 + TRUE_DIFF + ALPHA_B * shock + unitNoiseB);
      }
    });
    const result = pairedBootstrapDiff(a, b, { iterations: 500, seed: 1 });
    const [lo, hi] = result.ci90;
    if (lo <= TRUE_DIFF && TRUE_DIFF <= hi) covered++;
  }
  const rate = covered / WORLDS;
  assert.ok(rate >= 0.85, `expected ~90% coverage with no within-game correlation, got ${rate}`);
});

test('groups option does not break the existing default (ungrouped) call shape', () => {
  const a = [], b = [];
  withRandomSeed(1, () => { for (let i = 0; i < 50; i++) { a.push(randn()); b.push(randn() + 0.5); } });
  const result = pairedBootstrapDiff(a, b, { iterations: 200, seed: 1 });
  assert.equal(result.error, undefined);
  assert.equal(result.n, 50);
  assert.ok(Array.isArray(result.ci90));
});

test('groups shorter than n is ignored gracefully (falls back to ungrouped)', () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const b = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const result = pairedBootstrapDiff(a, b, { iterations: 100, seed: 1, groups: ['g1', 'g2'] });
  assert.equal(result.error, undefined);
  assert.equal(result.n, 10);
});

/**
 * 2026-09-12 sweep item 16(ii): the guard used to be `groups.length >= n`, so
 * a `groups` array LONGER than `n = min(valuesA.length, valuesB.length)` was
 * accepted and read at indices [0, n) as if it lined up with both value
 * arrays. This is exactly offseason-model.js's own call shape: `groups:
 * p.groups` is built in lockstep with the CANDIDATE's own pooled errors
 * (`pooled[name].groups.push(...groups)` beside `pooled[name].errs.push(...e)`
 * every season), while the comparison's OTHER side can legitimately be
 * shorter -- any season where an optional challenger (the code's own example:
 * `if (gbmModel) { try {...} catch {} }`) failed to fit drops that season
 * from one pooled array but not the other. `n` then no longer equals
 * `groups.length`, and the two arrays being compared over the truncated
 * window are not guaranteed to be the SAME units the docstring requires.
 */
test('groups longer than n (item 16ii) is ignored gracefully instead of silently truncated to a mismatched pairing', () => {
  const a = Array(12).fill(0).map((_, i) => (i % 4 < 2 ? 1 : 9));   // 12 units, the shorter side
  const b = Array(20).fill(0).map((_, i) => (i % 4 < 2 ? 1 : 9));   // 20 units, the longer side
  const groups = Array(20).fill(0).map((_, i) => `game${Math.floor(i / 4)}`); // built for b's length, per offseason-model.js's own pattern
  const grouped = pairedBootstrapDiff(a, b, { iterations: 500, seed: 1, groups });
  const ungrouped = pairedBootstrapDiff(a, b, { iterations: 500, seed: 1 });
  assert.equal(grouped.error, undefined);
  assert.equal(grouped.n, 12, 'n is min(12, 20)');
  // Falling back to the ungrouped path means an IDENTICAL run (same seed, same
  // iterations, same truncated a/b) reproduces byte-for-byte -- the surest
  // proof the mismatched groups array was set aside rather than partially trusted.
  assert.deepEqual(grouped, ungrouped, 'a length-mismatched groups array must fall back to the exact ungrouped result, not a partially-grouped one');
});

/**
 * Giant Plan 8.9 (audit-consolidation stage 5): `weeklyClusterBootstrap`
 * (stats-util.js) is the one shared implementation replacing five
 * near-identical hand-rolled copies, one of which was `nfl-replay.js`'s own
 * `uncertainty()`. The bug it fixes: every prior copy built its resampling
 * universe purely from weeks present in the bet rows, so a week where the
 * policy correctly bet nothing could never be drawn and never contributed
 * its real, honest zero -- silently dropping information and overstating
 * both the apparent edge and its precision.
 */
const won = (season, week, units = 0.909) => ({ season, week, result: 'Won', units });
const lost = (season, week, units = -1) => ({ season, week, result: 'Lost', units });

test('weeklyClusterBootstrap with no declared weeks matches the resampling universe of the bets themselves', () => {
  const bets = [won(2026, 1), won(2026, 1), lost(2026, 2), won(2026, 3)];
  const result = weeklyClusterBootstrap(bets, { iterations: 500, seed: 1 });
  assert.equal(result.clusters, 3, 'three distinct weeks appear in the bets, and only those three form the universe');
  assert.equal(result.trials, 500);
});

test('a declared week with zero bets is drawable and contributes 0 units, not an absence', () => {
  const bets = [won(2026, 1), won(2026, 1), won(2026, 2), won(2026, 3)];
  // Week 4 is declared (the policy considered it and bet nothing) but has no rows.
  const withZeroWeek = weeklyClusterBootstrap(bets, {
    weeks: ['2026-1', '2026-2', '2026-3', '2026-4'], iterations: 4000, seed: 1
  });
  const withoutZeroWeek = weeklyClusterBootstrap(bets, { iterations: 4000, seed: 1 });

  assert.equal(withZeroWeek.clusters, 4, 'the declared universe includes the zero-bet week');
  assert.equal(withoutZeroWeek.clusters, 3, 'omitting `weeks` falls back to only the weeks present in the rows');
  // A universe that is 1/4 guaranteed-zero weeks must report strictly lower
  // (or equal, at the interval edges) ROI bounds than one that never draws a
  // zero at all -- the whole point of declaring the zero-bet week.
  assert.ok(withZeroWeek.roi_95[1] <= withoutZeroWeek.roi_95[1],
    `expected including the honest zero-bet week to not raise the ROI upper bound (${withZeroWeek.roi_95[1]} vs ${withoutZeroWeek.roi_95[1]})`);
});

test('an all-losing declared universe with a mix of zero-bet weeks never reports a positive ROI lower bound', () => {
  const bets = [lost(2026, 1), lost(2026, 2)];
  const result = weeklyClusterBootstrap(bets, {
    weeks: ['2026-1', '2026-2', '2026-3', '2026-4', '2026-5'], iterations: 4000, seed: 1
  });
  assert.ok(result.roi_95[1] <= 0, `an all-losing-or-abstained record must not show a positive ROI upper bound (got ${result.roi_95})`);
});

test('nfl-replay.js uncertainty() delegates to weeklyClusterBootstrap and preserves its prior (no-weeks) output exactly', () => {
  const bets = [won(2026, 1), won(2026, 1), lost(2026, 2), won(2026, 3), lost(2026, 4), won(2026, 5)];
  const viaUncertainty = uncertainty(bets);
  const viaShared = weeklyClusterBootstrap(bets);
  assert.deepEqual(viaUncertainty, viaShared,
    'uncertainty(bets) with no declared weeks must produce byte-identical output to calling the shared function directly -- this migration must not change any existing caller\'s numbers');
});

test('uncertainty() accepts an optional declared week set and forwards it', () => {
  const bets = [won(2026, 1), won(2026, 1)];
  const result = uncertainty(bets, { weeks: ['2026-1', '2026-2', '2026-3'] });
  assert.equal(result.clusters, 3);
});
