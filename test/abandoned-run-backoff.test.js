/**
 * A job that kills the process must not be started again by the process that
 * replaces it (2026-09-19).
 *
 * `record()` runs only after `job.run()` returns. So a job that takes the
 * whole process down — an OOM kill, or the #29 event-loop watchdog firing on
 * a synchronous ingest — writes nothing at all. Its `sync_log` row survives
 * untouched, the next boot reads exactly what the last boot read, reaches the
 * same conclusion, starts the same job, and dies at the same point. There is
 * no counter anywhere in that loop.
 *
 * Measured on the live app on 2026-09-19: `nfl_model_growth` with
 * `last_run_at` frozen at 21:17:44Z and `consecutive_failures: 1` across seven
 * consecutive lives, each one about 160 seconds long, each one killed ~90
 * seconds after boot.
 *
 * The fix is a start marker plus a reaper, and the tests below are about the
 * two ways it could be written and be useless: a marker that makes an
 * unfinished job look freshly synced, and a reap that records the failure
 * without actually stopping the next run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-abandoned-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db, run: dbRun, rows } = await import('../server/db/index.js');
const scheduler = await import('../server/services/scheduler.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const DAILY = { maxAgeMinutes: 24 * 60, tier: 'growth', label: 'synthetic daily job' };

/** The row a dead process leaves behind, without having to kill this one. */
function leaveAbandonedRow(job, startedAt) {
  dbRun(`INSERT INTO sync_log (job, last_run_at, last_status, last_detail, runs, consecutive_failures)
         VALUES (?, NULL, 'running', ?, 0, 0)
         ON CONFLICT(job) DO UPDATE SET
           last_status='running', last_detail=excluded.last_detail`,
    job, JSON.stringify({ running: true, started_at: startedAt }));
}

test('a job in flight is marked running without being made to look fresh', async () => {
  scheduler.JOBS.__test_inflight = { ...DAILY, run: async () => ({ ok: true }) };
  await scheduler.runIfStale('__test_inflight', { force: true });
  const afterFirst = scheduler.lastRun('__test_inflight');
  assert.equal(afterFirst.last_status, 'ok');
  assert.ok(afterFirst.last_run_at, 'the first run must have stamped a timestamp to compare against');

  let seen = null;
  scheduler.JOBS.__test_inflight.run = async () => {
    seen = scheduler.lastRun('__test_inflight');
    return { ok: true };
  };
  await scheduler.runIfStale('__test_inflight', { force: true });
  delete scheduler.JOBS.__test_inflight;

  assert.equal(seen.last_status, 'running',
    'without a start marker there is no trace at all of a run that never returns');
  // THE POINT OF THE TEST. Every freshness view in the app — confidence() in
  // source-registry.js, the diagnostic, the model routes — reads last_run_at.
  // A marker that stamped it would make a job that has produced nothing yet
  // read as freshly synced for as long as it runs.
  assert.equal(seen.last_run_at, afterFirst.last_run_at,
    'the start marker must not advance last_run_at: nothing has been produced yet');
});

test('a completed run leaves no running row behind', async () => {
  scheduler.JOBS.__test_clean = { ...DAILY, run: async () => ({ ok: true }) };
  await scheduler.runIfStale('__test_clean', { force: true });
  delete scheduler.JOBS.__test_clean;

  assert.equal(scheduler.lastRun('__test_clean').last_status, 'ok');
  assert.deepEqual(rows("SELECT job FROM sync_log WHERE last_status = 'running'"), [],
    'a marker that outlives its own successful run would reap a healthy job as failed on the next boot');
});

test('a run that never reported back is recorded as the failure it was', () => {
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  leaveAbandonedRow('__test_killed', startedAt);

  const reaped = scheduler.reapAbandonedRuns();
  assert.deepEqual(reaped.reaped, ['__test_killed']);

  const logged = scheduler.lastRun('__test_killed');
  assert.equal(logged.last_status, 'error',
    'a job that killed the process did not succeed, and recording it as anything else hides the one job you most need to see');
  assert.equal(logged.consecutive_failures, 1,
    'the counter is the whole point: without it the backoff below has nothing to grow from');
  assert.equal(logged.last_run_at, startedAt,
    'dated by the marker, not by the reap: the attempt happened when it started, not when the next boot noticed');
  assert.equal(JSON.parse(logged.last_detail).abandoned, true);
});

test('the boot after a kill does not start the same job again', () => {
  // The whole cycle, in one assertion. Started a moment ago, killed, reaped.
  leaveAbandonedRow('__test_cycle', new Date().toISOString());
  scheduler.JOBS.__test_cycle = { ...DAILY, run: async () => ({ ok: true }) };
  scheduler.reapAbandonedRuns();

  const due = scheduler.nextDueMinutes('__test_cycle', scheduler.JOBS.__test_cycle);
  delete scheduler.JOBS.__test_cycle;
  assert.equal(due, 5,
    'one failure buys the standard first retry window — and a boot is far shorter than that, which is what breaks the loop');
});

test('the second kill backs off further than the first', () => {
  leaveAbandonedRow('__test_twice', new Date().toISOString());
  scheduler.reapAbandonedRuns();
  leaveAbandonedRow('__test_twice', new Date().toISOString());
  scheduler.reapAbandonedRuns();

  const logged = scheduler.lastRun('__test_twice');
  assert.equal(logged.consecutive_failures, 2,
    'a second marker must add to the count rather than replace it, or a job that dies forever is retried every 5 minutes forever');
  assert.equal(scheduler.nextDueMinutes('__test_twice', { maxAgeMinutes: 24 * 60 }), 10);
});

test('a job that recovers stops being backed off', async () => {
  leaveAbandonedRow('__test_recovers', new Date().toISOString());
  scheduler.reapAbandonedRuns();
  assert.equal(scheduler.lastRun('__test_recovers').consecutive_failures, 1);

  scheduler.JOBS.__test_recovers = { ...DAILY, run: async () => ({ ok: true }) };
  await scheduler.runIfStale('__test_recovers', { force: true });
  delete scheduler.JOBS.__test_recovers;

  const logged = scheduler.lastRun('__test_recovers');
  assert.equal(logged.last_status, 'ok');
  assert.equal(logged.consecutive_failures, 0,
    'the backoff must clear on success, or one bad night permanently slows a healthy job');
});

test('the reap happens before the scheduler decides anything, brake or no brake', () => {
  leaveAbandonedRow('__test_braked', new Date().toISOString());
  // SCHEDULER_DISABLED is '1' for this whole file, so this is the braked path:
  // nothing will be scheduled, and the log must still be honest for whoever
  // reads it while the brake is on — which is exactly when someone is looking.
  const result = scheduler.startScheduler({ intervalMinutes: 5 });
  assert.equal(result.disabled, true, 'this test is only meaningful on the braked path');
  assert.equal(scheduler.lastRun('__test_braked').last_status, 'error',
    'with the brake on, a running row left by the last life would otherwise sit there unexplained');
});

test('the reaper is wired in ahead of the brake and the boot pass', () => {
  const src = fs.readFileSync(new URL('../server/services/scheduler.js', import.meta.url), 'utf8');
  const start = src.indexOf('export function startScheduler(');
  assert.ok(start > 0);
  const reap = src.indexOf('reapAbandonedRuns()', start);
  const brake = src.indexOf("SCHEDULER_DISABLED === '1'", start);
  const bootPass = src.indexOf('const bootJobs = BOOT_JOBS', start);
  assert.ok(reap > 0 && brake > 0 && bootPass > 0, 'all three landmarks must exist in startScheduler');
  assert.ok(reap < brake,
    'reaping after the brake returns means the brake hides the evidence');
  assert.ok(reap < bootPass,
    'reaping after the boot pass means the boot pass has already re-run the job that killed the last process');
});

test('the start marker is written before the job can fail', () => {
  const src = fs.readFileSync(new URL('../server/services/scheduler.js', import.meta.url), 'utf8');
  const fn = src.indexOf('async function runJobNow(');
  assert.ok(fn > 0);
  const mark = src.indexOf('recordStart(name)', fn);
  const tryBlock = src.indexOf('try {', fn);
  assert.ok(mark > 0 && mark < tryBlock,
    'a marker written inside the try is a marker that a synchronous throw can skip');
});
