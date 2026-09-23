/**
 * Level-vs-information decomposition, per Auditor §R25/R36.
 *
 * Centres a model's own bias using the MEDIAN of its training-split residuals,
 * not the mean (R36 change 1): MAE's optimal centring statistic is the
 * median, and weekly fantasy scores are right-skewed enough that the two
 * arms' mean-median gaps differ, so a mean-based centring does not cancel
 * out of the delta between them. Also reports the multiplicative form from
 * R7: headroom(X) = MAE(X) - MAE(X * m0(X)), m0 = the prediction-weighted
 * median of actual/pred on the training split.
 *
 * The bias/m0 inputs must come from a split the arm is NOT being graded on
 * (the training/bias season) -- never from the test split itself, or the
 * "correction" is fit to the same rows it is then judged against.
 */
import { quantile } from './stats-util.js';

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const mae = (pred, act) => mean(pred.map((p, i) => Math.abs(act[i] - p)));

/** Weighted quantile of `values`, weighted by `weights` (same length, same order). */
export function weightedQuantile(values, weights, q) {
  if (!values.length || values.length !== weights.length) return null;
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (!(totalWeight > 0)) return null;
  const pairs = values.map((v, i) => [v, weights[i]]).sort((a, b) => a[0] - b[0]);
  const target = q * totalWeight;
  let cum = 0;
  for (const [v, w] of pairs) {
    cum += w;
    if (cum >= target) return v;
  }
  return pairs[pairs.length - 1][0];
}

/**
 * m0: the prediction-weighted median of actual/pred over a training split.
 * Rows with a non-positive prediction are dropped -- a ratio against a
 * zero-or-negative denominator is not a scale factor.
 */
export function predictionWeightedMedianRatio(predictions, actuals) {
  const ratios = [], weights = [];
  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i];
    if (!(p > 0)) continue;
    ratios.push(actuals[i] / p);
    weights.push(p);
  }
  return weightedQuantile(ratios, weights, 0.5);
}

/**
 * One arm's (shipped or control) decomposition on one test season, centred
 * using ONLY the bias split's own residuals/ratio -- the test split is read
 * only to compute the metrics being decomposed, never to compute the
 * correction it is then judged against.
 */
export function decomposeArm({ biasPredictions, biasActuals, testPredictions, testActuals }) {
  const medianBias = quantile(biasActuals.map((a, i) => a - biasPredictions[i]), 0.5);
  const m0 = predictionWeightedMedianRatio(biasPredictions, biasActuals);
  const rawMae = mae(testPredictions, testActuals);
  const rawMeanSignedError = mean(testActuals.map((a, i) => a - testPredictions[i]));
  const debiasedPred = testPredictions.map(p => p + medianBias);
  const debiasedMae = mae(debiasedPred, testActuals);
  const scaledPred = m0 == null ? null : testPredictions.map(p => p * m0);
  const scaledMae = scaledPred == null ? null : mae(scaledPred, testActuals);
  const headroom = scaledMae == null ? null : rawMae - scaledMae;
  return {
    n: testPredictions.length, rawMae, rawMeanSignedError,
    medianBias, debiasedMae, m0, scaledMae, headroom
  };
}
