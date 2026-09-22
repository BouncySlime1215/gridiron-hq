/**
 * The heavy tier must not block the thread that serves requests (2026-09-19).
 *
 * Why this test exists: the live app went unreachable after AUTO_HEAVY_SYNC was
 * switched on. server/index.js starts the scheduler with `intervalMinutes: 5`,
 * so enabling that flag put eleven minutes-long jobs onto a five-minute pass,
 * sequentially, on the main thread — and node:sqlite's DatabaseSync is fully
 * synchronous, so "slow job" and "app answers nothing" are the same event.
 * fly.toml's TCP check could not see it, because the kernel's listen backlog
 * keeps accepting connections while the event loop is blocked.
 *
 * So the assertion is about EVENT-LOOP LAG, not about duration. A job that
 * takes two seconds is fine; a job that stops the loop for two seconds is the
 * outage. The inline control below is what makes the off-thread number mean
 * something: the identical workload is run both ways and the lag is compared.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-offthread-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const scheduler = await import('../server/services/scheduler.js');

test.after(async () => {
  // A worker's result promise resolves on its 'message' event, but the OS-level
  // teardown of its own sqlite connection (opened at GRIDIRON_DB_PATH, under
  // `temp`) can still be in flight a few ms after that — measured on a loaded
  // CI runner (2026-09-22) as an ENOTEMPTY race in the recursive rmSync below.
  // A short yield covers the ordinary case; maxRetries covers the tail Node
  // already knows how to retry (it retries ENOTEMPTY/EBUSY/EPERM on its own).
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const BURN_MS = 1200;
const FIXTURE = pathToFileURL(path.join(process.cwd(), 'test/fixtures/cpu-burn.mjs')).href;

/**
 * Peak event-loop lag while `work` runs: schedule a 20ms timer over and over
 * and record how late each one actually fires. A blocked loop cannot run the
 * timer at all, so the lateness IS the block.
 */
async function peakLagDuring(work) {
  let peak = 0;
  let stop = false;
  (function probe() {
    if (stop) return;
    const due = Date.now() + 20;
    setTimeout(() => {
      peak = Math.max(peak, Date.now() - due);
      probe();
    }, 20);
  })();
  const result = await work();
  // The probe timer that was outstanding when the block started is still
  // pending here: a resolved promise's continuation runs as a microtask, ahead
  // of any timer. Reading `peak` now would read it before the very callback
  // that measures the block. Yield one macrotask so that callback lands first.
  await new Promise(resolve => setTimeout(resolve, 40));
  stop = true;
  return { peak, result };
}

test('an inline job of this size does block the event loop (the control)', async () => {
  scheduler.JOBS.__test_inline_burn = {
    run: async () => (await import(FIXTURE)).burn(BURN_MS),
    maxAgeMinutes: 0, tier: 'growth', offThread: false, label: 'inline CPU burn (control)'
  };
  const { peak, result } = await peakLagDuring(
    () => scheduler.runIfStale('__test_inline_burn', { force: true }));
  delete scheduler.JOBS.__test_inline_burn;

  assert.equal(result.ran, true);
  assert.equal(result.error, undefined, `control job should succeed: ${result.error}`);
  // If this ever stops holding, the probe is no longer measuring what it thinks
  // it is and the off-thread assertion below is worthless.
  assert.ok(peak > BURN_MS / 2,
    `the control must actually block the loop, got ${peak}ms of lag for a ${BURN_MS}ms synchronous burn`);
});

test('the same job off-thread leaves the event loop responsive', async () => {
  scheduler.JOBS.__test_worker_burn = {
    run: async () => { throw new Error('must not run on the main thread'); },
    worker: { module: FIXTURE, fn: 'burn', args: [BURN_MS] },
    maxAgeMinutes: 0, tier: 'heavy', label: 'off-thread CPU burn'
  };
  const { peak, result } = await peakLagDuring(
    () => scheduler.runIfStale('__test_worker_burn', { force: true }));
  delete scheduler.JOBS.__test_worker_burn;

  assert.equal(result.ran, true);
  assert.equal(result.error, undefined, `off-thread job should succeed: ${result.error}`);
  assert.equal(result.detail?.burned_ms, BURN_MS, 'the worker must return the job result to the main thread');
  // Spawning a thread costs a little, and CI runners are shared, so this is a
  // deliberately loose bound. It is still an order of magnitude below the
  // control, which is the claim being made.
  assert.ok(peak < 300, `expected a responsive loop while the worker burned, got ${peak}ms of lag`);
});

test('the heavy tier is off-thread by default, so a new heavy job cannot reintroduce the outage', () => {
  const heavy = Object.entries(scheduler.JOBS).filter(([, j]) => j.tier === 'heavy');
  assert.ok(heavy.length > 0, 'expected heavy jobs to exist');
  for (const [name, job] of heavy) {
    assert.notEqual(job.offThread, false,
      `${name} opts out of the worker thread; that is the exact shape of the outage, so it needs a reason here`);
  }
});

test('a worker that fails is recorded as an error, not as a healthy run', async () => {
  scheduler.JOBS.__test_worker_throws = {
    run: async () => ({ ok: true }),
    worker: { module: FIXTURE, fn: 'noSuchExport', args: [] },
    maxAgeMinutes: 0, tier: 'heavy', label: 'off-thread job with a bad descriptor'
  };
  const result = await scheduler.runIfStale('__test_worker_throws', { force: true });
  const logged = scheduler.lastRun('__test_worker_throws');
  delete scheduler.JOBS.__test_worker_throws;

  assert.ok(result.error, 'a failing worker must surface an error');
  assert.equal(logged.last_status, 'error',
    'a job that failed in a worker must not be logged as ok — that is how a dead feed looks healthy');
});
