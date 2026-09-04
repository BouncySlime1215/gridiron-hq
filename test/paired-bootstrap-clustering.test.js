import test from 'node:test';
import assert from 'node:assert/strict';
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';
import { withRandomSeed, randn } from '../server/services/stats-util.js';

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
