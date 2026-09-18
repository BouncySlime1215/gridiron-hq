/**
 * Gate scripts grade against a PINNED baseline, not whatever is promoted today.
 *
 * scripts/fit-ros-projection.mjs, fit-posture-calibration.mjs, fit-weekly-coverage.mjs
 * and promote-early-week-weights.mjs each looked their baseline up at run time with
 * activeWeeklyWeightSet({2026, week 3}) (or today's week). The ROS gate ran against
 * fit-1; today that call returns fit-2, whose weeks 2-4 are structural only, so a
 * re-run silently grades a different baseline and the published 3.83 -> 2.47 table
 * cannot be regenerated. The scripts now read the pre-registered fit by id
 * (weeklyWeightSetById), and the posture script keys its cached dataset on the
 * weight set and the availability fit it was built with (availabilityFitStamp).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-pinned-baselines-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows } = await import('../server/db/index.js');
const S = await import('../server/services/weekly-weight-store.js');
const C = await import('../server/services/contingency.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const LEDGER = { sample_size: 0, validation_size: 0, candidate_mae: null, champion_mae: null,
  candidate_spearman: null, champion_spearman: null, coverage_80: null };
const vector = w => Object.fromEntries(['QB', 'RB', 'WR', 'TE'].map(p => [p, [...w]]));
const EARLY = { weeks: [2, 4], buckets: { 1: vector([1, 0, 0, 0, 0]) } };

test('weeklyWeightSetById reads one stored fit, whatever is promoted now', () => {
  S.saveWeeklyFit({ ...LEDGER, data_hash: 'pin-1', through_season: 2025, through_week: 18, promoted: true,
    weights: vector([0.2, 0.4, 0.15, 0.05, 0.2]) });
  S.saveWeeklyFit({ ...LEDGER, data_hash: 'pin-2', through_season: 2025, through_week: 18, promoted: true,
    weights: { ...vector([0.2, 0.4, 0.15, 0.05, 0.2]), early: EARLY } });
  const [first, second] = rows('SELECT id FROM weekly_ensemble_fits ORDER BY id').map(r => r.id);
  assert.equal(S.activeWeeklyWeightSet({ season: 2026, week: 3 }).id, `fit-${second}`, 'today the newest is served');
  const pinned = S.weeklyWeightSetById(first);
  assert.equal(pinned.id, `fit-${first}`);
  assert.deepEqual(pinned.weights.WR, [0.2, 0.4, 0.15, 0.05, 0.2]);
  assert.equal(pinned.weights.early, undefined);
  assert.ok(pinned.data_hash, 'the stored data hash travels with it, for the result file');
  // The week window applies exactly as activeWeeklyWeightSet applies it.
  assert.deepEqual(S.weeklyWeightSetById(second, { week: 3 }).weights.early, EARLY);
  assert.equal(S.weeklyWeightSetById(second, { week: 6 }).weights.early, undefined);
});

test('weeklyWeightSetById refuses an id that is not stored', () => {
  assert.throws(() => S.weeklyWeightSetById(9999), /fit 9999/);
  assert.throws(() => S.weeklyWeightSetById('1'), /integer/);
});

test('availabilityFitStamp changes when either availability table is refit', () => {
  const before = C.availabilityFitStamp();
  db.exec(C.AVAILABILITY_RATES_DDL);
  db.prepare(`INSERT INTO nfl_availability_rates (scope, team, report_status, practice_status, p_active, n, raw_rate, shrunk, fitted_at)
              VALUES ('league', '', 'out', 'any', 0.02, 50, 0.02, 0, '2026-09-18T00:07:01Z')`).run();
  const rates = C.availabilityFitStamp();
  assert.notEqual(rates, before);
  db.exec(C.AVAILABILITY_ROLE_RATES_DDL);
  db.prepare(`INSERT INTO nfl_availability_role_rates (report_status, practice_status, position, tier, gap, p_active, n, raw_rate, config, fitted_at)
              VALUES ('noreport', '*', '*', '*', '*', 0.97, 500, 0.97, '{}', '2026-09-19T00:00:00Z')`).run();
  assert.notEqual(C.availabilityFitStamp(), rates);
});
