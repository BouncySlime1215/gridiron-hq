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

test('two positions each below 8x150 rows are both pooled onto the SAME combined fit, not each fit alone', () => {
  // WR and TE get DIFFERENT, non-overlapping yhat ranges (0-49 vs 100-149).
  // If each fit alone, their edges would live entirely within their own
  // range and never match. If truly pooled onto one combined fit, both
  // tables are identical AND span the full 0-149 range -- neither is
  // achievable by coincidence, unlike same-shaped fixtures would allow.
  const history = [];
  for (let i = 0; i < 600; i++) history.push({ pos: 'WR', yhat: i % 50, y: Math.max(0, i % 50) });
  for (let i = 0; i < 600; i++) history.push({ pos: 'TE', yhat: 100 + (i % 50), y: Math.max(0, i % 50) });
  const table = fitProjectionRangeTable(history);
  assert.deepEqual(table.WR.edges, table.TE.edges, 'both under threshold -> same pooled edges');
  assert.deepEqual(table.WR.bins, table.TE.bins, 'both under threshold -> same pooled bins');
  assert.ok(table.WR.edges.some(e => e < 50) && table.WR.edges.some(e => e >= 100),
    'the pooled edges must span BOTH positions\' ranges, proving they were actually combined');
});

test('a position AT OR ABOVE 8x150 rows gets its own fit, not the pooled one -- the threshold is a floor, not a ceiling', () => {
  const history = [];
  for (let i = 0; i < 1200; i++) history.push({ pos: 'WR', yhat: i % 100, y: Math.max(0, (i % 100) - 10) });
  for (let i = 0; i < 50; i++) history.push({ pos: 'TE', yhat: i, y: Math.max(0, i - 10) });
  const table = fitProjectionRangeTable(history);
  assert.notDeepEqual(table.WR.edges, table.TE.edges, 'WR (1200 rows) fits alone; TE (50 rows) pools -- different tables');
});

test('the lower edge is floored at 0 and never goes negative, even when the raw empirical p10 would be', () => {
  const history = [];
  for (let i = 0; i < 1200; i++) {
    // Deliberately NOT floored in the fixture itself -- y ranges roughly
    // -15 to +5, so the raw (unfloored) p10 of this bin is well below 0.
    // The code's own Math.max(0, ...) is the only thing that can prevent a
    // negative lo here; without it this test would see lo < 0.
    history.push({ pos: 'WR', yhat: 5, y: 5 + ((i % 21) - 15) });
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

test('the fitted upper tail absorbs exactly what the floored lower tail could not hold -- pinned to the exact formula, not just "wider on top"', () => {
  // Hand-computable bin: 30 zeros + values 1..70 (100 rows total), all at
  // yhat=2. quantile(sorted, 0.10) -> index 0.10*99=9.9, both neighbors are
  // 0 (within the first 30 zeros) -> raw p10 = 0 -> lo = 0. f_lo = fraction
  // of values STRICTLY below lo(=0) = 0 (nothing is negative). Per section
  // 2: upperP = 1 - (0.20 - f_lo) = 1 - 0.20 = 0.80 -> index 0.80*99=79.2,
  // landing between the 50th and 51st of the 1..70 values (index 79 = value
  // 50, index 80 = value 51) -> hi = 50 + 0.2 = 50.2.
  // A NAIVE symmetric band (ignoring f_lo, upperP fixed at 0.90) would
  // instead land at index 89.1 -> value 60 + 0.1 = 60.1 -- a different,
  // wrong number this test would also catch.
  const history = [
    ...Array.from({ length: 30 }, () => 0),
    ...Array.from({ length: 70 }, (_, k) => k + 1)
  ].map(y => ({ pos: 'WR', yhat: 2, y }));
  const table = fitProjectionRangeTable(history);
  const band = projectionRangeFor(table, 'WR', 2);
  assert.equal(band.lo, 0);
  assert.ok(Math.abs(band.hi - 50.2) < 1e-9, `expected hi = 50.2 (f_lo-adjusted), got ${band.hi}`);
});

test('range_n (the row count the band came from) travels with the band, so a thin bin is visible', () => {
  const history = Array.from({ length: 1200 }, (_, i) => ({ pos: 'WR', yhat: i % 50, y: Math.max(0, i % 50) }));
  const table = fitProjectionRangeTable(history);
  const band = projectionRangeFor(table, 'WR', 5);
  assert.ok(Number.isInteger(band.n) && band.n >= 20);
});
