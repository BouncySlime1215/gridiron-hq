import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeekIndex, purgedWalkForwardFolds, purgedWalkForwardEvaluate }
  from '../server/services/purged-walk-forward.js';

// Three seasons, 4 weeks each, one row per (season, week).
function threeSeasonRows() {
  const rows = [];
  for (const season of [2021, 2022, 2023]) {
    for (let week = 1; week <= 4; week++) rows.push({ season, week, id: `${season}-${week}` });
  }
  return rows;
}

test('buildWeekIndex assigns a strictly increasing index across seasons', () => {
  const { index, seasons } = buildWeekIndex(threeSeasonRows());
  assert.deepEqual(seasons, [2021, 2022, 2023]);
  assert.equal(index.get('2021|1'), 0);
  assert.equal(index.get('2021|4'), 3);
  assert.equal(index.get('2022|1'), 4);
  assert.equal(index.get('2023|4'), 11);
});

test('buildWeekIndex throws on a row missing numeric season/week', () => {
  assert.throws(() => buildWeekIndex([{ season: 2021 }]), /missing numeric season\/week/);
});

test('folds roll forward: each test season trains on every earlier season', () => {
  const folds = purgedWalkForwardFolds(threeSeasonRows(), { minTrainSeasons: 1 });
  assert.equal(folds.length, 2); // test 2022, then test 2023
  assert.equal(folds[0].testSeason, 2022);
  assert.deepEqual(folds[0].trainSeasons, [2021]);
  assert.equal(folds[0].counts.train, 4);
  assert.equal(folds[0].counts.test, 4);

  assert.equal(folds[1].testSeason, 2023);
  assert.deepEqual(folds[1].trainSeasons, [2021, 2022]);
  assert.equal(folds[1].counts.train, 8);
});

test('minTrainSeasons controls how many seasons must exist before the first fold', () => {
  const folds = purgedWalkForwardFolds(threeSeasonRows(), { minTrainSeasons: 2 });
  assert.equal(folds.length, 1);
  assert.equal(folds[0].testSeason, 2023);
});

test('no folds when there is only one season', () => {
  const rows = [{ season: 2021, week: 1 }, { season: 2021, week: 2 }];
  assert.deepEqual(purgedWalkForwardFolds(rows), []);
});

test('purges a training row whose feature lookback window reaches into the test season', () => {
  const rows = threeSeasonRows(); // test season 2022 starts at global index 4 (week 1)
  // featureLookbackWeeks=2: a training row's OWN feature window is [wi-2, wi]. The
  // last row of 2021 (index 3, week 4) has window [1,3] -- does not reach index 4,
  // so it should NOT be purged with a plain lookback purge and no embargo.
  const folds = purgedWalkForwardFolds(rows, { minTrainSeasons: 1, featureLookbackWeeks: 2 });
  const fold2022 = folds.find(f => f.testSeason === 2022);
  assert.equal(fold2022.counts.purged, 0);
  assert.equal(fold2022.counts.train, 4);
});

test('purges a training row whose label horizon window reaches into the test season', () => {
  const rows = threeSeasonRows();
  // labelHorizonWeeks=2: the last 2021 row (index 3) has a label window [3,5], which
  // overlaps the 2022 test window [4,7] at index 4 and 5 -- must be purged. The
  // second-to-last 2021 row (index 2) has label window [2,4] -- does not reach 4? it
  // reaches exactly 4, so IT also overlaps (index 4 is in test). Only rows whose
  // window ends before index 4 survive.
  const folds = purgedWalkForwardFolds(rows, { minTrainSeasons: 1, labelHorizonWeeks: 2 });
  const fold2022 = folds.find(f => f.testSeason === 2022);
  // 2021 has indices 0..3. winEnd = wi+2 must be < 4 to survive (winEnd < purgeLower=4).
  // wi=0 -> winEnd=2 (survives), wi=1 -> winEnd=3 (survives), wi=2 -> winEnd=4 (purged,
  // since overlap test is winEnd >= purgeLower), wi=3 -> winEnd=5 (purged).
  assert.equal(fold2022.counts.purged, 2);
  assert.equal(fold2022.counts.train, 2);
  assert.deepEqual(fold2022.purgedRows.map(r => r.id).sort(), ['2021-3', '2021-4']);
});

test('embargoWeeks widens the purge window on both sides', () => {
  const rows = threeSeasonRows();
  // No lookback/horizon, but embargoWeeks=1 should still purge the row immediately
  // before the test window (2021 week 4, index 3) since purgeLower becomes 4-1=3.
  const folds = purgedWalkForwardFolds(rows, { minTrainSeasons: 1, embargoWeeks: 1 });
  const fold2022 = folds.find(f => f.testSeason === 2022);
  assert.equal(fold2022.counts.purged, 1);
  assert.deepEqual(fold2022.purgedRows.map(r => r.id), ['2021-4']);
});

test('purged rows never appear in trainRows, and every non-purged prior-season row does', () => {
  const rows = threeSeasonRows();
  const folds = purgedWalkForwardFolds(rows, { minTrainSeasons: 1, labelHorizonWeeks: 2 });
  const fold2022 = folds.find(f => f.testSeason === 2022);
  const trainIds = new Set(fold2022.trainRows.map(r => r.id));
  const purgedIds = new Set(fold2022.purgedRows.map(r => r.id));
  for (const id of trainIds) assert.ok(!purgedIds.has(id), `${id} in both train and purged`);
  assert.equal(trainIds.size + purgedIds.size, 4); // all of 2021 accounted for
});

test('purgedWalkForwardEvaluate calls predict/score per fold and reports pooled seasons', () => {
  const rows = threeSeasonRows();
  const result = purgedWalkForwardEvaluate(rows, {
    minTrainSeasons: 1,
    predict: (train, testRows) => testRows.map(r => ({ id: r.id, pred: train.length })),
    score: (predictions, testRows, fold) => ({ trainSize: fold.counts.train, testSize: testRows.length }),
  });
  assert.deepEqual(result.seasons_evaluated, [2022, 2023]);
  assert.equal(result.folds.length, 2);
  assert.equal(result.folds[0].metric.trainSize, 4);
  assert.equal(result.folds[1].metric.trainSize, 8);
});

test('purgedWalkForwardEvaluate requires both predict and score', () => {
  assert.throws(() => purgedWalkForwardEvaluate(threeSeasonRows(), { predict: () => [] }),
    /requires both predict/);
});
