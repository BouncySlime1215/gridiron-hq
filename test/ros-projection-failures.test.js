/**
 * A failure in the rest-of-season inputs must be loud, and must not stick.
 *
 * ros-projection.js#inSeasonHistory wrapped its query in `catch { return acc; }`: any
 * error (a bad bind, a locked or corrupt DB) became an empty history, so
 * buildRosProjections returned an empty Map and buildAssetUniverse silently fell back to
 * the weekly number for ros_ppg — the very bug the ROS model was built to fix — with no
 * log. rosPriorMap swallowed errors the same way and then cached the partial map for
 * the life of the process. contingency.js turned an unparseable role `config` into
 * "not by position" without a word.
 *
 * Kept: a table that does not exist yet (a fresh install) is a normal empty state.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ros-failures-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

// buildProjections fails on demand, the way a locked database would.
const realProjections = await import('../server/services/projections.js');
let failProjections = 0;
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: (...args) => {
      if (failProjections > 0) { failProjections--; throw new Error('database is locked'); }
      return realProjections.buildProjections(...args);
    }
  }
});
const R = await import('../server/services/ros-projection.js');
const { buildAvailabilityLookup } = await import('../server/services/contingency.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try { return { value: fn(), warnings }; } finally { console.warn = original; }
}

test('inSeasonHistory raises a query failure instead of returning an empty history', () => {
  const { warnings } = captureWarnings(() => {
    assert.throws(() => R.inSeasonHistory(2026, undefined), /bound|parameter/i);
  });
  assert.ok(warnings.some(w => /inSeasonHistory/.test(w) && /2026/.test(w)), `logged with the season: ${warnings}`);
});

test('buildRosProjections does not turn a history failure into "no ROS for anyone"', () => {
  const weekly = new Map([[1, { position: 'WR', structural_ppg: 10 }]]);
  captureWarnings(() => {
    assert.throws(() => R.buildRosProjections({ season: 2026, week: undefined, weekly, priors: new Map() }));
  });
});

test('a prior map built after a failure is not cached', () => {
  R.clearRosPriorCache();
  failProjections = 1;
  const first = captureWarnings(() => R.rosPriorMap(2031));
  assert.ok(first.warnings.some(w => /rosPriorMap/.test(w) && /database is locked/.test(w)), `warned: ${first.warnings}`);
  const second = R.rosPriorMap(2031);
  assert.notEqual(second, first.value, 'the second call recomputes instead of serving the partial map');
  assert.equal(R.rosPriorMap(2031), second, 'a clean build is cached');
});

test('an unreadable role config is reported, not silently read as "not by position"', () => {
  const { value: lookup, warnings } = captureWarnings(() => buildAvailabilityLookup({ roleRates: [
    { report_status: 'noreport', practice_status: '*', position: '*', tier: '*', gap: '*', p_active: 0.95, n: 10, config: '{byPosition: true' }
  ] }));
  assert.ok(lookup.configError, 'the lookup says its config could not be read');
  assert.ok(warnings.some(w => /config/.test(w)), `warned: ${warnings}`);
});
