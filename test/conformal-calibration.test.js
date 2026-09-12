import test from 'node:test';
import assert from 'node:assert/strict';
import {
  binIndex, binLabel, conformalQuantile, buildConformal, recencyWeights, weightedDraw
} from '../server/services/conformal.js';

/*
 * These are LOGIC checks and belong on a deterministic fixture (see
 * test/helpers/requires-real-history.js for when that is not true). Nothing
 * below asserts anything about football; the football claims — realised
 * coverage on held-out NFL games — are measured against real history and
 * reported in the build notes, because a fixture tuned to satisfy a coverage
 * assertion would only prove that the fixture was tuned.
 *
 * What these checks protect is the part that can silently rot: the finite-
 * sample rank, the bin routing, the thin-bin fallback, and the fact that the
 * interval and the probability are two readings of ONE calibration set. A
 * conformal interval that quietly loses its +1 still looks completely normal
 * and under-covers forever.
 */

/* ------------------------------------------------------------------ binning */

test('binIndex puts a value in the bin whose lower edge it reaches, and unknowns in the top bin', () => {
  const edges = [3, 6.5, 10];
  assert.equal(binIndex(edges, 0), 0);
  assert.equal(binIndex(edges, 2.5), 0);
  assert.equal(binIndex(edges, 3), 1, 'a value exactly on an edge belongs to the higher bin');
  assert.equal(binIndex(edges, 6.5), 2);
  assert.equal(binIndex(edges, 9.99), 2);
  assert.equal(binIndex(edges, 10), 3);
  assert.equal(binIndex(edges, 40), 3);
  // An unknown key must never land in the narrowest bin by accident — that is
  // the direction that under-covers.
  assert.equal(binIndex(edges, null), 3);
  assert.equal(binIndex(edges, NaN), 3);
  assert.equal(binLabel(edges, 0), '0-3');
  assert.equal(binLabel(edges, 3), '10+');
});

/* ------------------------------------------------------- the finite-sample rank */

test('conformalQuantile uses the ceil((n+1)*level) order statistic, not the plain empirical quantile', () => {
  // |residuals| 1..10. Plain 80th percentile would be 8; conformal needs
  // ceil(11 * 0.8) = 9th smallest = 9. The extra point is the whole guarantee.
  const abs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(conformalQuantile(abs, 0.80).halfWidth, 9);
  assert.equal(conformalQuantile(abs, 0.50).halfWidth, 6);
  assert.equal(conformalQuantile(abs, 0.90).halfWidth, 10);
});

test('a level the calibration set is too small to certify is reported as exhausted, not silently met', () => {
  const abs = [1, 2, 3];               // ceil(4 * 0.95) = 4 > 3
  const q = conformalQuantile(abs, 0.95);
  assert.equal(q.exhausted, true);
  assert.equal(q.halfWidth, 3, 'falls back to the largest miss actually observed');
  assert.equal(conformalQuantile([], 0.8).halfWidth, null);
});

test('the conformal interval really covers at least the nominal rate on exchangeable draws', () => {
  // A deterministic, deliberately non-normal residual generator: coverage must
  // hold without any distributional assumption, which is the entire point.
  const draw = i => (i % 7 === 0 ? 40 : (i % 3) * (i % 2 ? -9 : 11) + (i % 5));
  const calibration = Array.from({ length: 400 }, (_, i) => ({ key: 1, residual: draw(i) }));
  const evaluation = Array.from({ length: 400 }, (_, i) => draw(i + 400));
  const cal = buildConformal(calibration, { edges: [], minBin: 10 });
  const [lo, hi] = cal.interval(0, 1, 0.80);
  const covered = evaluation.filter(r => r >= lo && r <= hi).length / evaluation.length;
  assert.ok(covered >= 0.78, `conformal 80% interval covered only ${(100 * covered).toFixed(1)}%`);
});

/* --------------------------------------------------------- Mondrian behaviour */

test('each bin is sized from its own residuals, so a volatile slice gets a wider interval', () => {
  const calm = Array.from({ length: 300 }, (_, i) => ({ key: 1, residual: (i % 21) - 10 }));      // +/-10
  const wild = Array.from({ length: 300 }, (_, i) => ({ key: 12, residual: 3 * ((i % 21) - 10) })); // +/-30
  const cal = buildConformal([...calm, ...wild], { edges: [3, 6.5, 10], minBin: 150 });
  const calmWidth = cal.halfWidth(1, 0.80);
  const wildWidth = cal.halfWidth(12, 0.80);
  assert.ok(wildWidth > calmWidth * 2.5,
    `volatile bin should be much wider (calm ${calmWidth}, wild ${wildWidth})`);
  // and the pooled-normal failure mode — one width for everything — is gone
  assert.notEqual(calmWidth, wildWidth);
});

test('a bin too thin to estimate a tail quantile borrows the pooled set instead of inventing a narrow one', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ key: 1, residual: (i % 41) - 20 }));
  const few = [{ key: 12, residual: 0 }, { key: 12, residual: 1 }];  // would imply a +/-1 interval
  const cal = buildConformal([...many, ...few], { edges: [10], minBin: 150 });
  const thin = cal.bins.find(b => b.label === '10+');
  assert.equal(thin.n, 2);
  assert.equal(thin.borrowed_pool, true);
  assert.ok(cal.halfWidth(12, 0.80) > 10,
    'the thin bin must not report a confidently narrow interval built from two points');
});

test('the probability and the interval are read off the same calibration set', () => {
  const cal = buildConformal(
    Array.from({ length: 400 }, (_, i) => ({ key: 1, residual: (i % 41) - 20 })),
    { edges: [], minBin: 50 });
  // A point forecast sitting exactly at its own interval edge must carry a tail
  // probability consistent with that edge; if these two ever come from
  // different pools this is the assertion that notices.
  const [lo, hi] = cal.interval(0, 1, 0.80);
  const pAboveHi = cal.probabilityAbove(0, 1, hi);
  const pAboveLo = cal.probabilityAbove(0, 1, lo);
  // Tolerances are loose in one direction on purpose: the calibration set here
  // is a coarse integer grid and `probabilityAbove` uses a strict inequality, so
  // the residuals sitting exactly on an edge count as outside it. The assertion
  // is that both readings describe the same distribution, not that a discrete
  // sample hits 10% and 90% to the decimal.
  assert.ok(pAboveHi <= 0.12, `upper tail should be about 10%, got ${pAboveHi}`);
  assert.ok(pAboveLo >= 0.86, `mass above the lower edge should be about 90%, got ${pAboveLo}`);
  // never a hard 0 or 1 off a finite sample
  assert.ok(cal.probabilityAbove(0, 1, 1e6) > 0);
  assert.ok(cal.probabilityAbove(0, 1, -1e6) < 1);
});

/* ------------------------------------------------------------ recency weights */

test('recency weighting down-weights older seasons and leaves the newest at full weight', () => {
  const seasons = [2020, 2021, 2022, 2023];
  const w = recencyWeights(seasons, { decay: 0.5, minEffectiveFraction: 0 });
  const raw = w.cumulative.map((c, i) => c - (i ? w.cumulative[i - 1] : 0));
  assert.deepEqual(raw.map(v => +v.toFixed(4)), [0.125, 0.25, 0.5, 1]);
  assert.equal(w.reference_season, 2023);
  assert.ok(w.effectiveN < seasons.length);
});

test('the effective-sample floor relaxes a decay that would throw the calibration set away', () => {
  // 26 seasons, one residual each, at the carryover the ratings model fits.
  const seasons = Array.from({ length: 26 }, (_, i) => 1999 + i);
  const unfloored = recencyWeights(seasons, { decay: 0.5, minEffectiveFraction: 0 });
  assert.ok(unfloored.effectiveN < 4, 'decay 0.5 over 26 seasons keeps only a couple of seasons');
  const floored = recencyWeights(seasons, { decay: 0.5, minEffectiveFraction: 0.4 });
  assert.equal(floored.floor_engaged, true);
  assert.ok(floored.applied_decay > 0.5, 'the decay is relaxed, not the floor');
  assert.ok(floored.effectiveN >= 0.4 * seasons.length - 0.5,
    `floor should hold at least 40% effective sample, got ${floored.effectiveN}`);
  // and a decay that already clears the floor is left exactly alone
  const untouched = recencyWeights(seasons, { decay: 0.98, minEffectiveFraction: 0.4 });
  assert.equal(untouched.floor_engaged, false);
  assert.equal(untouched.applied_decay, 0.98);
});

test('weightedDraw is a correct inverse CDF, so the weights actually reach the sampler', () => {
  const seasons = [2020, 2021, 2022, 2023];
  const w = recencyWeights(seasons, { decay: 0.5, minEffectiveFraction: 0 });
  assert.equal(weightedDraw(w.cumulative, w.total, 0), 0);
  assert.equal(weightedDraw(w.cumulative, w.total, 0.999999), 3);
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < 100000; i++) counts[weightedDraw(w.cumulative, w.total, i / 100000)]++;
  // shares should track 0.125 : 0.25 : 0.5 : 1 (i.e. 1/15, 2/15, 4/15, 8/15)
  const share = counts.map(c => c / 100000);
  assert.ok(Math.abs(share[3] - 8 / 15) < 0.01, `newest season share ${share[3]}`);
  assert.ok(Math.abs(share[0] - 1 / 15) < 0.01, `oldest season share ${share[0]}`);
  assert.ok(share[3] > share[2] && share[2] > share[1] && share[1] > share[0]);
});
