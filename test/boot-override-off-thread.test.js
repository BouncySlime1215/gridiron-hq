/**
 * The boot-path override really does move a job into a worker (2026-09-19).
 *
 * `test/boot-path-off-thread.test.js` asserts the shape of the change: which
 * jobs are named, that the pass passes the override, that the resolver prefers
 * it. Every one of those assertions would still pass if the override were
 * threaded through `runIfStale` and then dropped on the floor.
 *
 * This file is the runtime half, and it is written the way
 * `test/scheduler-off-thread.test.js` writes the same claim: measure real
 * event-loop lag while the job runs, with an inline control of the identical
 * workload so the off-thread number means something.
 *
 * The job under test is deliberately a LIVE-tier job with no `offThread` flag —
 * exactly the shape of the 19 jobs on the boot path. Under the old rule it runs
 * on the request thread. The only thing sending it to a worker is the override
 * the boot pass now passes, so if the override stopped working this file fails
 * and the config assertions elsewhere would not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-boot-override-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const scheduler = await import('../server/services/scheduler.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const BURN_MS = 1200;
const FIXTURE = pathToFileURL(path.join(process.cwd(), 'test/fixtures/cpu-burn.mjs')).href;

/** Peak event-loop lag while `work` runs. A blocked loop cannot run the probe
 *  timer at all, so the lateness IS the block. */
async function peakLagDuring(work) {
  let peak = 0;
  let stop = false;
  (function probe() {
    if (stop) return;
    const due = Date.now() + 20;
    setTimeout(() => { peak = Math.max(peak, Date.now() - due); probe(); }, 20);
  })();
  const result = await work();
  // Yield one macrotask so the probe callback outstanding when the block
  // started lands before `peak` is read; a promise continuation is a microtask
  // and would run ahead of it.
  await new Promise(resolve => setTimeout(resolve, 40));
  stop = true;
  return { peak, result };
}

test('a live-tier job without the override blocks the loop (the control)', async () => {
  scheduler.JOBS.__test_boot_inline = {
    run: async () => (await import(FIXTURE)).burn(BURN_MS),
    maxAgeMinutes: 0, tier: 'live', label: 'boot-shaped job, no override (control)'
  };
  const { peak, result } = await peakLagDuring(
    () => scheduler.runIfStale('__test_boot_inline', { force: true }));
  delete scheduler.JOBS.__test_boot_inline;

  assert.equal(result.ran, true);
  assert.equal(result.error, undefined, `control job should succeed: ${result.error}`);
  // Without this the assertion below proves nothing: it would be measuring a
  // probe that cannot see a block rather than a block that is not there.
  assert.ok(peak > BURN_MS / 2,
    `the control must actually block the loop, got ${peak}ms for a ${BURN_MS}ms synchronous burn`);
});

test('the same live-tier job WITH the override leaves the loop responsive', async () => {
  scheduler.JOBS.__test_boot_override = {
    // If the override is ever dropped, this runs on the main thread and says so
    // by name, rather than the test failing on a timing number.
    run: async () => { throw new Error('the boot override did not reach the worker'); },
    worker: { module: FIXTURE, fn: 'burn', args: [BURN_MS] },
    maxAgeMinutes: 0, tier: 'live', label: 'boot-shaped job, override applied'
  };
  const { peak, result } = await peakLagDuring(
    () => scheduler.runIfStale('__test_boot_override', { force: true, offThread: true }));
  delete scheduler.JOBS.__test_boot_override;

  assert.equal(result.ran, true);
  assert.equal(result.error, undefined, `override job should succeed: ${result.error}`);
  assert.equal(result.detail?.burned_ms, BURN_MS, 'the worker must return the job result to the main thread');
  // The bar is the control's own, from the other side (see scheduler-off-thread.test.js):
  // an inline burn blocks for about BURN_MS and the control requires more than half of it,
  // so anything under half cannot be the burn on this thread. A flat 300 ms flaked once on
  // a starved CI runner (346 ms on #421, green on the re-run). A dropped override still
  // fails by name: the job's main-thread `run` throws.
  assert.ok(peak < BURN_MS / 2,
    `expected a responsive loop while the worker burned, got ${peak}ms of lag (an inline burn is ~${BURN_MS}ms)`);
});

test('an explicit false override keeps a heavy job on the main thread', async () => {
  // The override is a full override, not a one-way switch. Nothing ships using
  // it this way; the test exists so the asymmetry cannot be introduced silently.
  scheduler.JOBS.__test_heavy_pinned = {
    run: async () => (await import(FIXTURE)).burn(BURN_MS),
    maxAgeMinutes: 0, tier: 'heavy', label: 'heavy job pinned to the main thread'
  };
  const { peak, result } = await peakLagDuring(
    () => scheduler.runIfStale('__test_heavy_pinned', { force: true, offThread: false }));
  delete scheduler.JOBS.__test_heavy_pinned;

  assert.equal(result.ran, true);
  assert.ok(peak > BURN_MS / 2,
    `offThread: false must keep a heavy job inline, got ${peak}ms of lag`);
});
