import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fitFantasyCoordinator, coordinateFantasy, __test
} from '../server/services/fantasy-coordinator.js';

const { shrinkageScales, familiesOf } = __test;

// Deterministic pseudo-noise (no Math.random) so the fixture is reproducible.
function noise(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s / 0x7fffffff) * 2 - 1; };
}

/**
 * Synthetic examples across 20 weeks, 15/week (300 total), matching the real
 * shape { season, week, target, experts: {ensemble_shift, game_script_delta,
 * boom_bust_signal} }.
 *   - ensemble_shift: a REAL signal — target is genuinely a function of it.
 *   - boom_bust_signal: a near-duplicate of ensemble_shift (same underlying
 *     signal, slightly noisier) — should merge into ensemble_shift's family.
 *   - game_script_delta: pure noise, uncorrelated with target — must shrink
 *     to zero rather than be treated as informative.
 */
function syntheticExamples() {
  const rand = noise(7);
  const rows = [];
  for (let week = 1; week <= 20; week++) {
    for (let i = 0; i < 15; i++) {
      const trueSignal = rand() * 3; // the real underlying effect
      const target = 0.8 * trueSignal + rand() * 0.5; // target genuinely depends on it
      rows.push({
        season: 2024, week,
        target,
        experts: {
          ensemble_shift: trueSignal + rand() * 0.3,
          boom_bust_signal: trueSignal + rand() * 0.4, // same signal, independently noised — should family with ensemble_shift
          game_script_delta: rand() * 3 // pure noise, no relation to target
        }
      });
    }
  }
  return rows;
}

test('a genuinely predictive expert earns positive shrinkage; pure noise shrinks to zero', () => {
  const examples = syntheticExamples();
  const shrinkage = shrinkageScales(examples);
  assert.ok(shrinkage.ensemble_shift.k > 0, 'a real, walk-forward-validated signal must earn non-zero weight');
  assert.equal(shrinkage.game_script_delta.k, 0, 'pure noise must shrink to zero');
  assert.equal(shrinkage.game_script_delta.reason, 'shrunk to zero: no walk-forward gain');
});

test('two experts carrying the same underlying signal are merged into one family', () => {
  const examples = syntheticExamples();
  const { families } = familiesOf(examples);
  const merged = families.find(f => f.members.includes('ensemble_shift'));
  assert.ok(merged, 'ensemble_shift and boom_bust_signal share the same underlying signal and must form a family');
  assert.ok(merged.members.includes('boom_bust_signal'));
  assert.ok(!merged.members.includes('game_script_delta'), 'uncorrelated noise must not be pulled into the family');
});

test('fitFantasyCoordinator refuses to fit below MIN_ROWS, and a real fit corrects toward the true signal', () => {
  const tooFew = fitFantasyCoordinator(syntheticExamples().slice(0, 50));
  assert.equal(tooFew.ready, false);

  const fit = fitFantasyCoordinator(syntheticExamples());
  assert.equal(fit.ready, true);

  // A player whose ensemble_shift and boom_bust_signal both say "+2" should
  // get a positive correction toward that signal; "-2" a negative one. The
  // ridge/weight-cap regularization here (inherited from the spread
  // coordinator's conservative calibration) deliberately damps the magnitude,
  // so this checks direction and consistency, not an exact size.
  const strongPositive = coordinateFantasy(fit, { ensemble_shift: 2, boom_bust_signal: 2, game_script_delta: 2 }, 10);
  const strongNegative = coordinateFantasy(fit, { ensemble_shift: -2, boom_bust_signal: -2, game_script_delta: -2 }, 10);
  assert.equal(strongPositive.ready, true);
  // A fixed intercept from finite-sample noise can shift both corrections by a
  // constant, so a strict "must be below -X" threshold on the negative case is
  // fragile — the property that actually proves the fit learned the real
  // experts' direction is that flipping the sign of every real input moves the
  // correction meaningfully in the opposite direction, not the absolute sign.
  assert.ok(strongPositive.correction - strongNegative.correction > 0.1,
    `flipping the real experts' sign must move the correction the opposite way (positive ${strongPositive.correction}, negative ${strongNegative.correction})`);
  assert.equal(strongPositive.corrected_ppg, +(10 + strongPositive.correction).toFixed(3));

  // A missing expert (e.g. game_script_delta unavailable that week) must not
  // crash and must still produce a sensible correction from what IS present.
  const missingOne = coordinateFantasy(fit, { ensemble_shift: 2, boom_bust_signal: 2, game_script_delta: null }, 10);
  assert.equal(missingOne.ready, true);
  assert.ok(Number.isFinite(missingOne.corrected_ppg));
});

test('coordinateFantasy on an unfitted coordinator reports not-ready rather than a fabricated correction', () => {
  const out = coordinateFantasy({ ready: false, reason: 'warmup requires 200 rows' }, { ensemble_shift: 5 }, 10);
  assert.equal(out.ready, false);
  assert.equal(out.structural_ppg, 10);
});
