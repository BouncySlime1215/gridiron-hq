/**
 * A weekly-weight promotion that fails its own read-back check must not stay live.
 *
 * review-fixes-2, finding 4 (silent-failure-hunter): promote-early-week-weights.mjs
 * saved the fit with promoted = 1, THEN ran its round-trip checks, and on a failure
 * printed "Demote by hand: UPDATE ..." and exited 1 — leaving the failed fit promoted.
 * activeWeeklyWeightSet() reads the table on every call and the asset-universe key
 * carries the served set's id, so the running server moved weeks 2-4 onto the failed
 * fit on its next request, with no one watching. promote-weekly-ensemble.mjs had the
 * same shape.
 *
 * Rule: promoteWeeklyFitChecked() saves, runs the caller's checks against the stored
 * row, and on any failure (or a throw) demotes the fit and proves it is no longer
 * served before returning. Both promotion scripts go through it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-promotion-rollback-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const store = await import('../server/services/weekly-weight-store.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const vector = w => Object.fromEntries(['QB', 'RB', 'WR', 'TE'].map(p => [p, w]));
const LEDGER = { sample_size: 100, validation_size: 50, candidate_mae: 4.3, champion_mae: 4.4,
  candidate_spearman: 0.6, champion_spearman: 0.59, coverage_80: 0.8, through_season: 2025, through_week: 18 };
const baseline = store.saveWeeklyFit({ ...LEDGER, data_hash: 'rb-baseline', promoted: 1, weights: vector([0.2, 0.4, 0.15, 0.05, 0.2]) });
const served = () => store.activeWeeklyWeightSet({ season: 2026, week: 6 }).fit?.data_hash;

test('a promotion whose read-back check fails is demoted and no longer served', () => {
  assert.equal(typeof store.promoteWeeklyFitChecked, 'function');
  const result = store.promoteWeeklyFitChecked(
    { ...LEDGER, data_hash: 'rb-failing', weights: vector([1, 0, 0, 0, 0]) },
    () => ['stored early block differs from the graded one']);
  assert.equal(result.ok, false);
  assert.equal(result.demoted, true);
  assert.deepEqual(result.failures, ['stored early block differs from the graded one']);
  assert.equal(row('SELECT promoted FROM weekly_ensemble_fits WHERE data_hash = ?', result.saved.stored_data_hash).promoted, 0);
  assert.equal(served(), baseline.stored_data_hash, 'the fit that was live before is served again');
});

test('a check that throws is a failure too', () => {
  const result = store.promoteWeeklyFitChecked(
    { ...LEDGER, data_hash: 'rb-throwing', weights: vector([0, 1, 0, 0, 0]) },
    () => { throw new Error('harness replay failed'); });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /harness replay failed/);
  assert.equal(served(), baseline.stored_data_hash);
});

test('the checks run against the stored, promoted row', () => {
  let seen = null;
  const result = store.promoteWeeklyFitChecked(
    { ...LEDGER, data_hash: 'rb-passing', weights: vector([0.3, 0.3, 0.2, 0.1, 0.1]) },
    saved => { seen = served(); return seen === saved.stored_data_hash ? [] : [`served ${seen}`]; });
  assert.equal(result.ok, true, result.failures.join('; '));
  assert.equal(result.demoted, false);
  assert.equal(seen, result.saved.stored_data_hash);
  assert.equal(served(), result.saved.stored_data_hash, 'a passing promotion stays live');
});

test('both promotion scripts promote only through the checked path', () => {
  for (const script of ['scripts/promote-early-week-weights.mjs', 'scripts/promote-weekly-ensemble.mjs']) {
    const source = fs.readFileSync(path.join(process.cwd(), script), 'utf8');
    assert.match(source, /promoteWeeklyFitChecked\(/, `${script} promotes through promoteWeeklyFitChecked`);
    assert.doesNotMatch(source, /promoted:\s*1/, `${script} writes no promoted row outside the checked path`);
    assert.doesNotMatch(source, /Demote by hand/, `${script} does not leave the demotion to a person`);
  }
});
