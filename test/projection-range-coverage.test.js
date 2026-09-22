import test from 'node:test';
import assert from 'node:assert/strict';

// The other half of docs/spec/projection-range.md's requirement (section 7):
// the algorithm alone (projection-range.js, GREEN 0860e49) isn't enough to
// quote a coverage number to a user -- the spec's own 80.74% was measured
// against a research baseline, not production, and must be re-measured
// against real production out-of-sample rows before anyone quotes it. This
// is that re-measurement's PURE half: given a chronologically-ordered set of
// already-graded {season, week, pos, yhat, y} rows (from wherever they came
// from -- a real walk-forward, or here, synthetic fixtures), walk forward
// exactly like the spec's own reference script (intervals2.py) does: fit the
// quantile table only from strictly-prior rows, score the next batch against
// it, then fold that batch into history for the next one. The DB-backed
// half (running server/services/weekly-backtest.js's replaySeasonWeekly
// across real seasons and feeding its output through this) is separate and
// is exercised directly against real data in the evidence file, not as an
// assert in this suite -- a live DB measurement isn't a repeatable unit test.
const { causalCoverageReport } = await import('../server/services/projection-range.js');

/** n rows for one (season, week) batch, evenly spread yhat so bins fill predictably. */
function batch(season, week, n, pos, yhatOf, yOf) {
  return Array.from({ length: n }, (_, i) => ({ season, week, pos, yhat: yhatOf(i), y: yOf(i) }));
}

test('nothing is scored before minHist rows have accumulated -- the warm-up period scores nothing, by design', () => {
  const rows = [
    ...batch(2020, 1, 100, 'WR', i => i % 50, i => Math.max(0, i % 50)),
    ...batch(2020, 2, 100, 'WR', i => i % 50, i => Math.max(0, i % 50))
  ];
  const report = causalCoverageReport(rows, { minHist: 1000 });
  assert.equal(report.n, 0, 'only 200 rows accumulated, under the 1000 minHist -- nothing scored yet');
});

test('once minHist is reached, the NEXT batch is scored -- not the batch that crossed the threshold itself', () => {
  const rows = [
    ...batch(2020, 1, 300, 'WR', i => i % 50, i => Math.max(0, i % 50)), // crosses minHist=300 exactly
    ...batch(2020, 2, 40, 'WR', i => i % 50, i => Math.max(0, i % 50))    // this one should be scored
  ];
  const report = causalCoverageReport(rows, { minHist: 300 });
  assert.equal(report.n, 40, 'only week 2\'s rows are scored, not week 1\'s own rows used to build the table');
});

test('a batch is scored using ONLY strictly prior rows -- adding a later batch never changes an earlier score', () => {
  const week1 = batch(2020, 1, 300, 'WR', i => i % 50, i => Math.max(0, i % 50));
  const week2 = batch(2020, 2, 300, 'WR', i => i % 50, i => Math.max(0, i % 50));
  const week3 = batch(2020, 3, 40, 'WR', i => i % 50, i => Math.max(0, i % 50));

  const reportUpToWeek3 = causalCoverageReport([...week1, ...week2, ...week3], { minHist: 300 });
  const reportUpToWeek2 = causalCoverageReport([...week1, ...week2], { minHist: 300 });
  // week2 is the first scored batch in both runs (300 rows crosses minHist after
  // week1); its scored bands must be identical whether or not week3 exists.
  assert.deepEqual(
    reportUpToWeek3.scored.filter(r => r.week === 2),
    reportUpToWeek2.scored,
    'week 2\'s scoring must not depend on week 3, which comes later'
  );
});

test('rows out of chronological input order are still walked forward in (season, week) order', () => {
  const week1 = batch(2020, 1, 300, 'WR', i => i % 50, i => Math.max(0, i % 50));
  const week2 = batch(2020, 2, 40, 'WR', i => i % 50, i => Math.max(0, i % 50));
  const inOrder = causalCoverageReport([...week1, ...week2], { minHist: 300 });
  const shuffled = causalCoverageReport([...week2, ...week1], { minHist: 300 });
  assert.equal(shuffled.n, inOrder.n);
  assert.deepEqual(shuffled.scored, inOrder.scored);
});

test('coverage is the fraction of scored rows whose actual y fell within [lo, hi]', () => {
  const week1 = batch(2020, 1, 300, 'WR', i => i % 50, i => Math.max(0, i % 50));
  // Week 2: half the rows score wildly outside any plausible band (y=9999), half score normally.
  const week2 = [
    ...batch(2020, 2, 20, 'WR', () => 25, () => 9999),
    ...batch(2020, 2, 20, 'WR', () => 25, i => Math.max(0, 25 + (i % 5) - 2))
  ];
  const report = causalCoverageReport([...week1, ...week2], { minHist: 300 });
  assert.ok(report.coverage < 0.7, `expected visibly degraded coverage from the 9999 outliers, got ${report.coverage}`);
});

test('byPosition breaks coverage down per position, matching the spec\'s own reporting shape', () => {
  const wr1 = batch(2020, 1, 300, 'WR', i => i % 50, i => Math.max(0, i % 50));
  const rb1 = batch(2020, 1, 300, 'RB', i => i % 50, i => Math.max(0, i % 50));
  const wr2 = batch(2020, 2, 40, 'WR', i => i % 50, i => Math.max(0, i % 50));
  const rb2 = batch(2020, 2, 40, 'RB', i => i % 50, i => Math.max(0, i % 50));
  const report = causalCoverageReport([...wr1, ...rb1, ...wr2, ...rb2], { minHist: 300 });
  assert.ok(report.byPosition.WR);
  assert.ok(report.byPosition.RB);
  assert.equal(report.byPosition.WR.n + report.byPosition.RB.n, report.n);
});

test('a row whose bin has fewer than 20 prior rows (no band available) is not scored, not counted as a miss', () => {
  // History has plenty of WR rows but zero TE rows, so a TE query has no
  // table entry at all once real per-position pooling kicks in below minHist
  // -- actually with pooling this DOES serve a WR-pooled band, so instead
  // force the true "no band" case: an entirely unseen position.
  const wr1 = batch(2020, 1, 300, 'WR', i => i % 50, i => Math.max(0, i % 50));
  const dst2 = batch(2020, 2, 10, 'DST', () => 5, () => 5); // position never in history
  const report = causalCoverageReport([...wr1, ...dst2], { minHist: 300 });
  assert.equal(report.n, 0, 'DST was never in the fitting history, so nothing about it is scored');
});
