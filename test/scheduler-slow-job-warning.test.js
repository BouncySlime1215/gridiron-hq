/**
 * Per-job timing on runIfStale (added 2026-09-19).
 *
 * node:sqlite's DatabaseSync is fully synchronous (server/db/index.js), so a
 * slow query inside a scheduled job blocks the whole process, not just that
 * job — every concurrent HTTP request stalls for the same span. That is the
 * mechanism behind a real freeze Nick hit running the app with the scheduler
 * on, but it needs his real, months-of-usage database to reproduce (his own
 * comment elsewhere in scheduler.js records a 9.8 GB WAL file); a fresh test
 * database never gets slow enough to trigger it. So this cannot assert "which
 * job is slow" — only that when a job IS slow, runIfStale reports it: a
 * duration on the result, and a console.warn naming the job once it crosses
 * SLOW_JOB_WARN_MS. That is the diagnostic Nick's next run needs, done live
 * on his own database rather than reconstructed after the fact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-scheduler-timing-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const scheduler = await import('../server/services/scheduler.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

function withWarnCapture(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  return fn().finally(() => { console.warn = original; }).then(result => ({ result, warnings }));
}

test('a job under the threshold reports its duration and warns about nothing', async () => {
  scheduler.JOBS.__test_fast_job = {
    run: async () => ({ ok: true }), maxAgeMinutes: 0, tier: 'live', label: 'fast synthetic job'
  };
  const { result, warnings } = await withWarnCapture(
    () => scheduler.runIfStale('__test_fast_job', { force: true }));
  delete scheduler.JOBS.__test_fast_job;

  assert.equal(result.ran, true);
  assert.equal(typeof result.duration_ms, 'number');
  assert.ok(result.duration_ms < 750, `expected a fast job's own duration, got ${result.duration_ms}ms`);
  assert.equal(warnings.some(w => w.includes('took') && w.includes('blocked')), false,
    'a fast job must not trip the slow-job warning');
});

test('a job over the threshold is named in a warning, with its measured duration', async () => {
  scheduler.JOBS.__test_slow_job = {
    run: () => new Promise(r => setTimeout(() => r({ ok: true }), 900)),
    maxAgeMinutes: 0, tier: 'live', label: 'slow synthetic job'
  };
  const { result, warnings } = await withWarnCapture(
    () => scheduler.runIfStale('__test_slow_job', { force: true }));
  delete scheduler.JOBS.__test_slow_job;

  assert.equal(result.ran, true);
  assert.ok(result.duration_ms >= 850, `expected ~900ms measured, got ${result.duration_ms}ms`);
  const hit = warnings.find(w => w.includes("'__test_slow_job' took"));
  assert.ok(hit, `expected a warning naming the slow job; got ${JSON.stringify(warnings)}`);
  assert.match(hit, /blocked for that long/);
});

test('a job that throws still reports how long it ran before failing', async () => {
  scheduler.JOBS.__test_failing_job = {
    run: async () => { await new Promise(r => setTimeout(r, 10)); throw new Error('synthetic failure'); },
    maxAgeMinutes: 0, tier: 'live', label: 'failing synthetic job'
  };
  const result = await scheduler.runIfStale('__test_failing_job', { force: true });
  delete scheduler.JOBS.__test_failing_job;

  assert.equal(result.ran, true);
  assert.equal(result.error, 'synthetic failure');
  assert.equal(typeof result.duration_ms, 'number');
  assert.ok(result.duration_ms >= 5, `expected a nonzero duration on the error path, got ${result.duration_ms}ms`);
});
