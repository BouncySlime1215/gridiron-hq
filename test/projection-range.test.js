import test from 'node:test';
import assert from 'node:assert/strict';

// docs/spec/projection-range.md (Model evidence audit, 2026-09-22, branch
// claude/project-thread-w0gpjt commit c58c20e) section 2's method, as pure
// tested code: "a spec, not an implementation ... the integration points
// below belong to other owners." This is that implementation's ALGORITHM
// only -- the causal empirical-quantile band fit, exactly as section 2
// describes it. It does NOT wire real production out-of-sample data through
// it or claim the spec's 80.74% coverage figure applies here: section 7 is
// explicit that those widths were measured against a research baseline, not
// the production model, and must be re-measured before being quoted to a
// user. That re-measurement -- running production's own walk-forward and
// feeding its real {season,week,pos,yhat,y} through this fitter -- is
// separate, larger work, not started in this file.
const { quantile, fitProjectionRangeTable, projectionRangeFor } =
  await import('../server/services/projection-range.js');

test('quantile interpolates linearly between order statistics, matching the spec script exactly', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(quantile(sorted, 0), 1);
  assert.equal(quantile(sorted, 1), 10);
  assert.equal(quantile(sorted, 0.5), 5.5);
  // i = 0.1 * 9 = 0.9 -> between sorted[0]=1 and sorted[1]=2, frac 0.9
  assert.equal(quantile(sorted, 0.1), 1.9);
});

test('quantile returns null on an empty array rather than throwing', () => {
  assert.equal(quantile([], 0.5), null);
});

test('fitProjectionRangeTable bins each position into 8 equal-count bins by yhat when it has enough rows', () => {
  // 8 bins x 150-row minimum = 1200; give WR exactly enough to avoid pooling.
  const history = [];
  for (let i = 0; i < 1200; i++) {
    history.push({ pos: 'WR', yhat: i % 100, y: Math.max(0, (i % 100) + (i % 7) - 3) });
  }
  const table = fitProjectionRangeTable(history);
  assert.ok(table.WR, 'WR gets its own table, not pooled');
  assert.equal(table.WR.edges.length, 7, '8 bins means 7 interior edges');
  assert.equal(table.WR.bins.length, 8);
});

test('a position with fewer than 8x150 rows is pooled across all positions rather than fit alone', () => {
  const history = [];
  for (let i = 0; i < 1200; i++) history.push({ pos: 'WR', yhat: i % 50, y: Math.max(0, i % 50) });
  for (let i = 0; i < 50; i++) history.push({ pos: 'TE', yhat: i, y: Math.max(0, i) }); // far under 1200
  const table = fitProjectionRangeTable(history);
  // A pooled position's table is the SAME object as the full-population fit,
  // not a thin TE-only one built from 50 rows.
  assert.equal(table.TE, table.WR, 'TE pools onto the full population, same table object');
});

test('the lower edge is floored at 0 and never goes negative, even when the empirical p10 would be', () => {
  const history = [];
  for (let i = 0; i < 1200; i++) {
    // A distribution where the true 10th percentile of y is well below 0 if
    // not floored -- y is only floored at 0 itself (fantasy points can't be
    // negative), so the spec's own floor on `lo` is the thing under test.
    history.push({ pos: 'WR', yhat: 5, y: Math.max(0, 5 + ((i % 21) - 15)) });
  }
  const table = fitProjectionRangeTable(history);
  const band = projectionRangeFor(table, 'WR', 5);
  assert.ok(band.lo >= 0, `lo ${band.lo} should never be negative`);
});

test('a thinly-fitted bin (under 20 prior rows) serves no range at all -- absent beats invented', () => {
  const history = [{ pos: 'RB', yhat: 3, y: 4 }, { pos: 'RB', yhat: 3, y: 2 }];
  const table = fitProjectionRangeTable(history);
  const band = projectionRangeFor(table, 'RB', 3);
  assert.equal(band, null);
});

test('projectionRangeFor returns null for a position that was never in the fitting history at all', () => {
  const history = Array.from({ length: 1200 }, (_, i) => ({ pos: 'WR', yhat: i % 50, y: Math.max(0, i % 50) }));
  const table = fitProjectionRangeTable(history);
  assert.equal(projectionRangeFor(table, 'K', 5), null);
});

test('the band is asymmetric when the outcome distribution is floored -- never silently symmetrised', () => {
  // Low projections: a floored, right-skewed outcome (many exact zeros, a
  // long right tail) -- section 2's own worked case. The lower tail cannot
  // hold 10% of the mass once more than 10% of true outcomes sit at 0, so
  // the fitted upper tail must absorb the rest of the 20% miss, producing a
  // visibly wider gap above than below the projection.
  const history = [];
  for (let i = 0; i < 1200; i++) {
    const isZero = i % 3 === 0; // a third of outcomes are exactly 0
    history.push({ pos: 'WR', yhat: 2, y: isZero ? 0 : 2 + (i % 25) });
  }
  const table = fitProjectionRangeTable(history);
  const band = projectionRangeFor(table, 'WR', 2);
  assert.equal(band.lo, 0, 'more than 10% of outcomes are 0, so the floored 10th percentile is exactly 0');
  const upperGap = band.hi - 2, lowerGap = 2 - band.lo;
  assert.ok(upperGap > lowerGap, `expected an asymmetric band (upper gap ${upperGap} > lower gap ${lowerGap})`);
});

test('range_n (the row count the band came from) travels with the band, so a thin bin is visible', () => {
  const history = Array.from({ length: 1200 }, (_, i) => ({ pos: 'WR', yhat: i % 50, y: Math.max(0, i % 50) }));
  const table = fitProjectionRangeTable(history);
  const band = projectionRangeFor(table, 'WR', 5);
  assert.ok(Number.isInteger(band.n) && band.n >= 20);
});
