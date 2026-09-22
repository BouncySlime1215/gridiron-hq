import test from 'node:test';
import assert from 'node:assert/strict';

// Data & techniques R&D's finding (RELIABILITY-SPEC.md, 2026-09-22): fitK's
// return already carries sigma2_within and sigma2_between, and the ICC --
// what fraction of a metric's week-to-week variance is the PLAYER rather than
// noise -- is one line on top of that nobody had taken: icc = sigma2_between
// / (sigma2_between + sigma2_within). This file pins that one line's
// arithmetic directly, on synthetic data where the true answer is computable
// by hand, independent of R&D's own nflverse-fitted reference numbers.
const { fitK } = await import('../server/services/shrinkage-fit.js');

/** {group, weight, value} rows for `groups` players, `weight` fixed per row. */
function rowsFor(values, weight = 1) {
  const obs = [];
  values.forEach((vals, i) => {
    for (const v of vals) obs.push({ group: `g${i}`, weight, value: v });
  });
  return obs;
}

test('icc is 0 when there is no detectable between-group variance (matches k=Infinity)', () => {
  // Every group has the exact same values -- all the variance is within-group
  // noise, none of it is "the player." fitK already reports this as k=Infinity;
  // icc should say the same thing in its own units, 0.
  const values = Array.from({ length: 8 }, () => [1, 2, 3, 4, 5]);
  const fit = fitK(rowsFor(values));
  assert.equal(fit.k, Infinity);
  assert.equal(fit.icc, 0);
});

test('icc rises toward 1 as between-group separation grows relative to within-group noise', () => {
  // Groups spread far apart (0, 10, 20, ... 70), tiny within-group jitter --
  // almost all the variance is between groups, so icc should sit close to 1.
  const values = [0, 10, 20, 30, 40, 50, 60, 70].map(center =>
    [center - 0.1, center, center + 0.1]
  );
  const fit = fitK(rowsFor(values));
  assert.ok(fit.icc > 0.99, `expected icc near 1 for well-separated groups, got ${fit.icc}`);
});

test('icc equals sigma2_between / (sigma2_between + sigma2_within) exactly, not just approximately', () => {
  const values = [
    [1, 3, 5], [2, 6, 4], [10, 12, 8], [9, 11, 13],
    [20, 18, 22], [15, 17, 19], [30, 28, 32], [25, 27, 29]
  ];
  const fit = fitK(rowsFor(values));
  const expected = fit.sigma2_between / (fit.sigma2_between + fit.sigma2_within);
  assert.equal(fit.icc, expected);
});

test('icc is always a fraction in [0, 1], never negative and never above 1', () => {
  const values = [[5, 5.2, 4.9], [5.1, 5.3, 4.8], [5.05, 5.15, 4.95], [4.95, 5.25, 5.0],
    [5.02, 4.98, 5.1], [4.9, 5.0, 5.05]];
  const fit = fitK(rowsFor(values));
  assert.ok(fit.icc >= 0 && fit.icc <= 1, `icc ${fit.icc} out of [0,1]`);
});

test('fitK still returns null on too little data, unaffected by the icc addition', () => {
  assert.equal(fitK([{ group: 'a', weight: 1, value: 1 }]), null);
});
