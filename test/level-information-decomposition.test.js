/**
 * Auditor R36: median-based centring (not mean) and the multiplicative
 * headroom form from R7, for the R25 shipped-vs-control decomposition.
 * MAE's optimal centring statistic is the median of residuals; weekly
 * fantasy scores are right-skewed enough that a mean-based centring does
 * not cancel out of the delta between two arms with different skew.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  weightedQuantile, predictionWeightedMedianRatio, decomposeArm
} from '../server/services/level-information-decomposition.js';

test('weightedQuantile with equal weights matches the plain median', () => {
  const values = [1, 5, 2, 9, 3];
  const weights = values.map(() => 1);
  assert.equal(weightedQuantile(values, weights, 0.5), 3);
});

test('weightedQuantile is pulled toward the heavily-weighted value', () => {
  // Ten copies of 1 vs one 100 -- the weighted median stays at 1 well past
  // where an unweighted median of the raw list [1,100] (50.5) would land.
  const values = [1, 100];
  const weights = [10, 1];
  assert.equal(weightedQuantile(values, weights, 0.5), 1);
});

test('weightedQuantile: mismatched lengths or zero total weight return null, not a throw', () => {
  assert.equal(weightedQuantile([1, 2], [1], 0.5), null);
  assert.equal(weightedQuantile([1, 2], [0, 0], 0.5), null);
  assert.equal(weightedQuantile([], [], 0.5), null);
});

test('predictionWeightedMedianRatio recovers a constant actual/pred ratio', () => {
  const predictions = [4, 8, 12, 16, 20];
  const actuals = predictions.map(p => p * 1.25);
  assert.equal(predictionWeightedMedianRatio(predictions, actuals), 1.25);
});

test('predictionWeightedMedianRatio drops non-positive predictions (no div-by-zero/negative scale)', () => {
  const predictions = [0, -3, 5, 10];
  const actuals = [999, 999, 6, 12]; // ratio 1.2 for both real rows
  assert.equal(predictionWeightedMedianRatio(predictions, actuals), 1.2);
});

test('predictionWeightedMedianRatio: all-non-positive predictions returns null', () => {
  assert.equal(predictionWeightedMedianRatio([0, -1], [5, 5]), null);
});

test('decomposeArm: median-based debiasing removes a constant additive offset', () => {
  // Bias split: the arm is uniformly 2 points low (actual = pred + 2).
  const biasPredictions = [10, 12, 8, 15, 9];
  const biasActuals = biasPredictions.map(p => p + 2);
  // Test split: same constant miss.
  const testPredictions = [11, 13, 7, 14, 10];
  const testActuals = testPredictions.map(p => p + 2);
  const out = decomposeArm({ biasPredictions, biasActuals, testPredictions, testActuals });
  assert.equal(out.medianBias, 2);
  assert.equal(out.rawMae, 2);
  // Debiasing with the correct +2 shift should leave zero error.
  assert.equal(out.debiasedMae, 0);
});

test('decomposeArm: headroom is zero when the multiplicative correction is neutral (m0=1)', () => {
  const biasPredictions = [10, 12, 8, 15, 9];
  const biasActuals = [...biasPredictions]; // actual == pred -> m0 = 1, medianBias = 0
  const testPredictions = [11, 13, 7];
  const testActuals = [12, 10, 9];
  const out = decomposeArm({ biasPredictions, biasActuals, testPredictions, testActuals });
  assert.equal(out.m0, 1);
  assert.equal(out.medianBias, 0);
  assert.equal(out.headroom, 0);
  assert.equal(out.scaledMae, out.rawMae);
});

test('decomposeArm: a real multiplicative miss is caught by headroom, not by the additive term', () => {
  // Bias split: actual is consistently 1.5x pred (a pure scale miss, zero
  // median residual once averaged against a spread that straddles it --
  // built here as an exact ratio so m0 = 1.5 unambiguously).
  const biasPredictions = [4, 8, 12, 16];
  const biasActuals = biasPredictions.map(p => p * 1.5);
  const testPredictions = [6, 10, 14];
  const testActuals = testPredictions.map(p => p * 1.5);
  const out = decomposeArm({ biasPredictions, biasActuals, testPredictions, testActuals });
  assert.equal(out.m0, 1.5);
  // The additive median-residual correction under-fixes a proportional miss
  // (it is a flat shift, not a scale), so debiasedMae stays above zero...
  assert.ok(out.debiasedMae > 0);
  // ...while the multiplicative correction (pred * m0) removes it exactly,
  // so headroom equals the full raw MAE for this arm.
  assert.equal(out.scaledMae, 0);
  assert.equal(out.headroom, out.rawMae);
});

test('decomposeArm centres on the MEDIAN residual, not the mean (R36 change 1)', () => {
  // Four rows with zero residual, one outlier with a +50 residual: median
  // stays 0, mean would be 10. A mean-based centring (the pre-R36 shape)
  // would report medianBias=10 here; this pins the R36 fix.
  const biasPredictions = [10, 10, 10, 10, 10];
  const biasActuals = [10, 10, 10, 10, 60];
  const testPredictions = [10];
  const testActuals = [10];
  const out = decomposeArm({ biasPredictions, biasActuals, testPredictions, testActuals });
  assert.equal(out.medianBias, 0);
  assert.equal(out.debiasedMae, 0); // a mean-based centring would over-correct to -10 here
});

test('decomposeArm never reads the test split to compute its own bias/m0 (no leakage)', () => {
  // Bias split says "no correction needed" (already unbiased, m0=1). Test
  // split is wildly biased. If the function leaked test-split data into
  // medianBias/m0, debiasedMae/scaledMae would come back suspiciously good;
  // instead they should reflect the (uncorrected) test-split miss.
  const biasPredictions = [10, 10, 10, 10];
  const biasActuals = [10, 10, 10, 10];
  const testPredictions = [10, 10, 10];
  const testActuals = [20, 20, 20]; // arm is 10 low on every test row
  const out = decomposeArm({ biasPredictions, biasActuals, testPredictions, testActuals });
  assert.equal(out.medianBias, 0);
  assert.equal(out.m0, 1);
  assert.equal(out.rawMae, 10);
  assert.equal(out.debiasedMae, 10); // uncorrected -- bias split found nothing to fix
  assert.equal(out.scaledMae, 10);   // uncorrected -- bias split found nothing to fix
});
