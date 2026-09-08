import test from 'node:test';
import assert from 'node:assert/strict';

const {
  isCalibrated, shrinkProbability, uncertaintyShrunkKelly, compareStakingPolicies,
  CALIBRATION_PRIOR_STRENGTH, FIXED_PAPER_STAKE_UNITS
} = await import('../server/services/nfl-execution-staking-policy.js');

const CALIBRATED_SCORECARD = {
  status: 'pilot_review_eligible', settled: 240,
  gates: { sample: true, mean_clv: true, median_clv: true, clustered_clv: true, ece: true, slope: true }
};
const UNCALIBRATED_SCORECARD = {
  status: 'accumulating', settled: 40,
  gates: { sample: false, mean_clv: true, median_clv: false, clustered_clv: false, ece: true, slope: true }
};

test('isCalibrated requires every gate to pass, not just most of them', () => {
  assert.equal(isCalibrated(CALIBRATED_SCORECARD), true);
  assert.equal(isCalibrated(UNCALIBRATED_SCORECARD), false);
  assert.equal(isCalibrated(null), false);
  assert.equal(isCalibrated({ gates: {} }), false);
});

test('shrinkProbability pulls a small sample almost all the way back to the fair price', () => {
  const shrunk = shrinkProbability({ modelProbability: 0.65, fairProbability: 0.50, settledSamples: 5 });
  // weight = 5 / (5 + 200) ~= 0.024, so the result should sit very close to 0.50.
  assert.ok(Math.abs(shrunk - 0.50) < 0.01);
});

test('shrinkProbability trusts a large sample close to its raw value', () => {
  const shrunk = shrinkProbability({ modelProbability: 0.65, fairProbability: 0.50, settledSamples: 20000 });
  assert.ok(Math.abs(shrunk - 0.65) < 0.01);
});

test('shrinkProbability with zero settled samples returns exactly the fair price — "no opinion"', () => {
  const shrunk = shrinkProbability({ modelProbability: 0.70, fairProbability: 0.48, settledSamples: 0 });
  assert.equal(shrunk, 0.48);
});

test('CALIBRATION_PRIOR_STRENGTH matches the project\'s existing 200-settled-bet calibration bar', () => {
  assert.equal(CALIBRATION_PRIOR_STRENGTH, 200);
});

test('uncertaintyShrunkKelly stakes nothing when the shrunk probability implies no edge', () => {
  // Model believes 0.55 on a market whose fair price is already 0.55 (no edge to size).
  const result = uncertaintyShrunkKelly({ modelProbability: 0.55, fairProbability: 0.55,
    settledSamples: 5000, americanPrice: americanForFairProb(0.55) });
  // American-price rounding can leave a hair of edge either side of exactly zero; the point of
  // this test is that a model that agrees with the fair price stakes essentially nothing.
  assert.ok(result.stake_fraction < 0.005);
});

test('uncertaintyShrunkKelly sizes a real edge once enough evidence exists', () => {
  const result = uncertaintyShrunkKelly({ modelProbability: 0.60, fairProbability: 0.50,
    settledSamples: 5000, americanPrice: -110 });
  assert.ok(result.stake_fraction > 0);
});

test('compareStakingPolicies blocks Kelly entirely pre-calibration, but the fixed paper stake is always available', () => {
  const comparison = compareStakingPolicies({
    marketScorecard: UNCALIBRATED_SCORECARD, modelProbability: 0.65, fairProbability: 0.50,
    settledSamples: 40, americanPrice: -110
  });
  assert.equal(comparison.calibrated, false);
  assert.equal(comparison.kelly.blocked, true);
  assert.equal(comparison.kelly.units, 0);
  assert.equal(comparison.fixed.units, FIXED_PAPER_STAKE_UNITS);
});

test('compareStakingPolicies sizes uncertainty-shrunk Kelly once a market is calibrated', () => {
  const comparison = compareStakingPolicies({
    marketScorecard: CALIBRATED_SCORECARD, modelProbability: 0.60, fairProbability: 0.50,
    settledSamples: 240, americanPrice: -110, bankrollUnits: 100
  });
  assert.equal(comparison.calibrated, true);
  assert.ok(comparison.kelly.units > 0);
  // Still not the fixed stake — the two policies are reported side by side, not merged.
  assert.notEqual(comparison.kelly.units, comparison.fixed.units);
});

test('compareStakingPolicies never derives a stake purely from a raw historical hit rate', () => {
  // A scorecard whose only evidence is a settled count, with no calibration gates passed, must
  // still block Kelly even if that settled count is large — the point is calibration, not sample size alone.
  const bigSampleButUncalibrated = { status: 'abstain', settled: 5000,
    gates: { sample: true, mean_clv: false, median_clv: false, clustered_clv: false, ece: false, slope: false } };
  const comparison = compareStakingPolicies({
    marketScorecard: bigSampleButUncalibrated, modelProbability: 0.70, fairProbability: 0.50,
    settledSamples: 5000, americanPrice: -110
  });
  assert.equal(comparison.calibrated, false);
  assert.equal(comparison.kelly.units, 0);
});

/** American price whose implied probability equals `p`, for building a genuinely no-edge test case. */
function americanForFairProb(p) {
  return p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}
