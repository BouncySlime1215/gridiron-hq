import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Persisting server/services/projection-range.js's fitProjectionRangeTable
// output (migration 064) so buildProjections can attach range_lo/range_hi
// to a projection without refitting per request. Versioned + activatable,
// same shape as shrinkage-fit.js's own shrinkage_fits/shrinkage_k, since
// this is a periodic batch artifact, unlike nfl_metric_reliability's
// upsert-in-place design (many small independent measurements).
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-projection-range-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const {
  fitProjectionRangeTable, saveProjectionRangeFit, activateProjectionRangeFit,
  activeProjectionRangeTable, projectionRangeFitHistory, projectionRangeFor
} = await import('../server/services/projection-range.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** A real fitted table over enough synthetic rows to actually serve bands. */
function realTable() {
  const history = Array.from({ length: 1200 }, (_, i) => ({ pos: 'WR', yhat: i % 100, y: Math.max(0, (i % 100) - 10) }));
  return fitProjectionRangeTable(history);
}

test('nfl_projection_range_fits starts empty and activeProjectionRangeTable returns null before any fit is saved', () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nfl_projection_range_fits').get().n, 0);
  assert.equal(activeProjectionRangeTable(), null);
});

test('saveProjectionRangeFit persists a fit; it is NOT active until activateProjectionRangeFit is called', () => {
  const table = realTable();
  const id = saveProjectionRangeFit({
    throughSeason: 2025, minHist: 1200, nRows: 1200, coverageOverall: 0.802,
    coverageByPosition: { WR: { n: 1200, coverage: 0.805 } }, table
  });
  assert.ok(id);
  assert.equal(activeProjectionRangeTable(), null, 'saving a fit does not activate it');
});

test('activateProjectionRangeFit makes a saved fit the one activeProjectionRangeTable returns', () => {
  const table = realTable();
  const id = saveProjectionRangeFit({ throughSeason: 2025, minHist: 1200, nRows: 1200, table });
  activateProjectionRangeFit(id);
  const active = activeProjectionRangeTable();
  assert.ok(active);
  assert.deepEqual(active.table, table);
  assert.equal(active.through_season, 2025);
});

test('only one fit is ever active -- activating a new one deactivates the previous', () => {
  const tableA = realTable();
  const idA = saveProjectionRangeFit({ throughSeason: 2024, minHist: 1200, nRows: 1200, table: tableA });
  activateProjectionRangeFit(idA);

  const tableB = fitProjectionRangeTable(Array.from({ length: 1200 }, (_, i) =>
    ({ pos: 'WR', yhat: i % 100, y: Math.max(0, (i % 100) - 30) })));
  const idB = saveProjectionRangeFit({ throughSeason: 2025, minHist: 1200, nRows: 1200, table: tableB });
  activateProjectionRangeFit(idB);

  const activeCount = db.prepare('SELECT COUNT(*) AS n FROM nfl_projection_range_fits WHERE active = 1').get().n;
  assert.equal(activeCount, 1);
  assert.equal(activeProjectionRangeTable().through_season, 2025);
});

test('projectionRangeFor still works correctly against a table round-tripped through JSON persistence', () => {
  // Guards against a subtle bug: JSON.stringify/parse could silently corrupt
  // a value (e.g. Infinity -> null) without a test that actually EXERCISES
  // projectionRangeFor on the round-tripped table, not just deepEquals it.
  const table = realTable();
  const id = saveProjectionRangeFit({ throughSeason: 2025, minHist: 1200, nRows: 1200, table });
  activateProjectionRangeFit(id);
  const { table: roundTripped } = activeProjectionRangeTable();

  const original = projectionRangeFor(table, 'WR', 50);
  const restored = projectionRangeFor(roundTripped, 'WR', 50);
  assert.deepEqual(restored, original);
});

test('projectionRangeFitHistory lists saved fits, most recent first', () => {
  const table = realTable();
  saveProjectionRangeFit({ throughSeason: 2023, minHist: 1200, nRows: 1200, table });
  saveProjectionRangeFit({ throughSeason: 2025, minHist: 1200, nRows: 1200, table });
  const history = projectionRangeFitHistory();
  assert.ok(history.length >= 2);
  assert.ok(history[0].id > history[1].id, 'most recent (highest id) first');
});
