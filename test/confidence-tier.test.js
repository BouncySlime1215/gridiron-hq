import test from 'node:test';
import assert from 'node:assert/strict';
import { expertConfidenceTier, predictionConfidence } from '../server/services/confidence-tier.js';

// Brill, Yurko & Wyner's thesis (arXiv:2406.16171, arXiv:2311.03490): report
// calibrated PER-DECISION confidence, and be honest when a decision doesn't
// deserve much trust, rather than presenting every point estimate the same
// way. This module turns each expert's walk-forward shrinkage `k` and its
// count of INDEPENDENT weeks of evidence into a simple tier — this suite
// checks the two defining cases: a well-shrunk, well-evidenced expert scores
// high, and a thin, heavily-shrunk (or never-earned) one scores low.

test('a real, walk-forward-validated expert with a full season-plus of independent weeks scores high', () => {
  const result = expertConfidenceTier({ k: 0.6, independentWeeks: 30 });
  assert.equal(result.tier, 'high');
  assert.ok(result.score >= 0.4);
});

test('an expert that never showed a walk-forward gain (k=0) scores low regardless of sample size', () => {
  const result = expertConfidenceTier({ k: 0, independentWeeks: 200 });
  assert.equal(result.tier, 'low');
  assert.equal(result.score, 0);
  assert.match(result.reason, /no walk-forward gain/);
});

test('a real but thinly-evidenced expert (few independent weeks) scores low even with a decent k', () => {
  const result = expertConfidenceTier({ k: 0.5, independentWeeks: 2 });
  assert.equal(result.tier, 'low');
});

test('a moderate k with a moderate number of independent weeks lands in the middle tier', () => {
  const result = expertConfidenceTier({ k: 0.5, independentWeeks: 8 });
  assert.equal(result.tier, 'medium');
});

test('missing independent-weeks data is treated as zero evidence, not as a crash', () => {
  const result = expertConfidenceTier({ k: 0.4 });
  assert.equal(result.tier, 'low');
  assert.equal(result.independent_weeks, 0);
});

test('more independent weeks strictly increases (or holds) the score for the same k', () => {
  const thin = expertConfidenceTier({ k: 0.5, independentWeeks: 4 });
  const thick = expertConfidenceTier({ k: 0.5, independentWeeks: 25 });
  assert.ok(thick.score > thin.score);
});

test('a prediction weighted toward its one high-confidence expert scores high overall', () => {
  const contributions = [
    { raw: 1.2, learned_weight: 0.3, confidence: expertConfidenceTier({ k: 0.6, independentWeeks: 30 }) },
    { raw: 0.8, learned_weight: 0.02, confidence: expertConfidenceTier({ k: 0, independentWeeks: 200 }) },
  ];
  const result = predictionConfidence(contributions);
  assert.equal(result.tier, 'high');
});

test('a prediction whose only active experts are thin or unvalidated scores low overall', () => {
  const contributions = [
    { raw: 1.2, learned_weight: 0.2, confidence: expertConfidenceTier({ k: 0, independentWeeks: 90 }) },
    { raw: 0.4, learned_weight: 0.05, confidence: expertConfidenceTier({ k: 0.3, independentWeeks: 3 }) },
  ];
  const result = predictionConfidence(contributions);
  assert.equal(result.tier, 'low');
});

test('a prediction with no active experts (all missing this week) reports low with a clear reason rather than NaN', () => {
  const contributions = [
    { raw: null, learned_weight: 0.3, confidence: expertConfidenceTier({ k: 0.6, independentWeeks: 30 }) },
  ];
  const result = predictionConfidence(contributions);
  assert.equal(result.tier, 'low');
  assert.equal(result.score, 0);
  assert.ok(result.reason);
});

test('score is always within [0, 1]', () => {
  for (const k of [0, 0.1, 0.5, 1]) {
    for (const weeks of [0, 1, 10, 50, 500]) {
      const result = expertConfidenceTier({ k, independentWeeks: weeks });
      assert.ok(result.score >= 0 && result.score <= 1);
    }
  }
});
