/**
 * A job must not run on top of itself (2026-09-19).
 *
 * `scheduler.js` guards each tier against its own next pass, which is why two
 * background passes no longer interleave. But a tier timer is one of five
 * independent callers of `runIfStale`: the 20-second boot catch-up pass, the
 * live timer, the background timer, `refreshInBackground` on page loads, and
 * `POST /api/mlb/sync/now?job=X` by hand. Nothing coordinated them.
 *
 * The staleness check cannot coordinate them either. `record()` runs only
 * after `job.run()` returns, so for the whole time a job is in flight its
 * last recorded run is the previous one — it reads as stale to everyone, and
 * they all start it. The two manual callers pass `force: true` and never
 * consult it at all.
 *
 * Measured on the live app, this fires on every boot rather than rarely: the
 * boot pass carries 18 jobs and `evidence_daemon` alone burns its full
 * 120-second budget on each of its runs, so the pass is still going when the
 * 90-second live timer starts the same jobs behind it. Two synchronous SQLite
 * transactions then write the same tables and record over each other.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-reentry-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const scheduler = await import('../server/services/scheduler.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const DAILY = { maxAgeMinutes: 24 * 60, tier: 'growth', label: 'synthetic daily job' };

/** A job that blocks until the test releases it, counting its own entries. */
function gatedJob(extra = {}) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const state = { entered: 0, release };
  return [{ ...DAILY, ...extra, run: async () => { state.entered += 1; await gate; return { ok: true }; } }, state];
}

test('a second caller does not start a job that is already running', async () => {
  const [job, state] = gatedJob();
  scheduler.JOBS.__test_reentry = job;

  // Caller 1: the boot pass. Caller 2: the live timer, 70 seconds later, while
  // the boot pass is still inside this job.
  const first = scheduler.runIfStale('__test_reentry', { force: true });
  const second = scheduler.runIfStale('__test_reentry', { force: true });
  state.release();
  const [a, b] = await Promise.all([first, second]);
  delete scheduler.JOBS.__test_reentry;

  assert.equal(state.entered, 1,
    'the job body ran twice — two synchronous SQLite transactions writing the same tables');
  assert.deepEqual(a, b,
    'the second caller must get the real result of the run in flight, not a sentinel');
  assert.equal(a.detail.ok, true);
});

test('force does not bypass the in-flight guard', async () => {
  // The manual sweep path. `POST /api/mlb/sync/now?job=X` passes force:true and
  // skips the staleness gate entirely, so this is the one caller that could
  // still double-run a job the scheduler had already started.
  const [job, state] = gatedJob();
  scheduler.JOBS.__test_reentry_force = job;

  const scheduled = scheduler.runIfStale('__test_reentry_force');
  const byHand = scheduler.runIfStale('__test_reentry_force', { force: true });
  state.release();
  await Promise.all([scheduled, byHand]);
  delete scheduler.JOBS.__test_reentry_force;

  assert.equal(state.entered, 1);
});

test('the guard is released once the run finishes, so the next tick still runs', async () => {
  // The failure mode of a guard like this is a job that is permanently
  // "already running" and therefore never runs again — silent, and worse than
  // what it fixed.
  const [job, state] = gatedJob();
  scheduler.JOBS.__test_reentry_release = job;

  const first = scheduler.runIfStale('__test_reentry_release', { force: true });
  state.release();
  await first;
  await scheduler.runIfStale('__test_reentry_release', { force: true });
  delete scheduler.JOBS.__test_reentry_release;

  assert.equal(state.entered, 2, 'the job stopped running entirely after its first run');
});

test('a job that throws also releases the guard', async () => {
  let entered = 0;
  scheduler.JOBS.__test_reentry_throw = {
    ...DAILY, run: async () => { entered += 1; throw new Error('boom'); }
  };

  const failed = await scheduler.runIfStale('__test_reentry_throw', { force: true });
  assert.equal(failed.error, 'boom');
  await scheduler.runIfStale('__test_reentry_throw', { force: true });
  delete scheduler.JOBS.__test_reentry_throw;

  assert.equal(entered, 2,
    'a job that fails once would be locked out forever, which is how a guard becomes the outage');
});

test('different jobs are not blocked by each other', async () => {
  // The guard is per job name, not a global lock — a tier pass must keep
  // moving through its other jobs while one of them is in flight.
  const [slow, slowState] = gatedJob();
  scheduler.JOBS.__test_reentry_slow = slow;
  scheduler.JOBS.__test_reentry_other = { ...DAILY, run: async () => ({ ok: true, other: true }) };

  const blocked = scheduler.runIfStale('__test_reentry_slow', { force: true });
  const other = await scheduler.runIfStale('__test_reentry_other', { force: true });
  assert.equal(other.detail.other, true, 'one slow job must not stop every other job');

  slowState.release();
  await blocked;
  delete scheduler.JOBS.__test_reentry_slow;
  delete scheduler.JOBS.__test_reentry_other;
});

test('an unknown job name is still answered rather than tracked', async () => {
  const out = await scheduler.runIfStale('__test_reentry_nonexistent');
  assert.equal(out.error, 'unknown job');
});
