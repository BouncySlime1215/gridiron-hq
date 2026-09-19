/**
 * A failed sync must be retried, and a job that did nothing must not be
 * logged as healthy (2026-09-19).
 *
 * Both bugs come from the same place. `record()` stamps `last_run_at` whether
 * a job succeeded or failed, and the staleness check read only that timestamp
 * — so a single transient failure bought a job its entire cadence of silence,
 * 24 hours for `espn_rosters` and three days for `ffopportunity`. On the live
 * app the ordinary failure was a 502 from an OOM-killed process, exactly the
 * kind that works on the next attempt. There was no retry anywhere in the
 * file.
 *
 * And the status was hardcoded to 'ok' for anything that did not throw, so a
 * job that skipped its work, or whose every batch member failed, reported
 * success to every freshness view in the app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-retry-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const scheduler = await import('../server/services/scheduler.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const DAILY = { maxAgeMinutes: 24 * 60, tier: 'growth', label: 'synthetic daily job' };

test('the two return shapes that were slipping through as ok', () => {
  // refreshPlayerRosters returns this — a STRING, which `=== true` missed.
  assert.equal(scheduler.statusFromDetail({ skipped: 'live draft in progress' }), 'skipped');
  assert.equal(scheduler.statusFromDetail({ skipped: true, reason: 'no ODDS_API_KEY configured' }), 'skipped');
  // refreshLeagueRosters returns this: every league failed, job returned normally.
  assert.equal(scheduler.statusFromDetail({ leagues: 5, failed: 5 }), 'error');
  assert.equal(scheduler.statusFromDetail({ leagues: 5, failed: 2 }), 'partial');
  // A genuine success must stay ok — this is a narrowing, not a new failure mode.
  assert.equal(scheduler.statusFromDetail({ ok: true, fetched: 800, added: 12 }), 'ok');
  assert.equal(scheduler.statusFromDetail({ leagues: 5, failed: 0 }), 'ok');
  assert.equal(scheduler.statusFromDetail(null), 'ok');
  assert.equal(scheduler.statusFromDetail('a string detail'), 'ok');
});

test('a job that skips its work is logged as skipped, not as a healthy sync', async () => {
  scheduler.JOBS.__test_skipper = { ...DAILY, run: async () => ({ skipped: 'live draft in progress' }) };
  await scheduler.runIfStale('__test_skipper', { force: true });
  const logged = scheduler.lastRun('__test_skipper');
  delete scheduler.JOBS.__test_skipper;

  assert.equal(logged.last_status, 'skipped',
    'a skipped job logged as ok tells every freshness view a sync happened when none did');
});

test('a batch job whose every member failed is logged as an error', async () => {
  scheduler.JOBS.__test_all_failed = { ...DAILY, run: async () => ({ leagues: 5, failed: 5 }) };
  await scheduler.runIfStale('__test_all_failed', { force: true });
  const logged = scheduler.lastRun('__test_all_failed');
  delete scheduler.JOBS.__test_all_failed;

  assert.equal(logged.last_status, 'error');
});

test('a failed daily job is retried in minutes, not in a day', async () => {
  scheduler.JOBS.__test_flaky = { ...DAILY, run: async () => { throw new Error('502 from upstream'); } };
  await scheduler.runIfStale('__test_flaky', { force: true });

  const afterOne = scheduler.nextDueMinutes('__test_flaky', scheduler.JOBS.__test_flaky);
  assert.equal(afterOne, 5, `one failure should be retried on the next background pass, got ${afterOne} minutes`);
  assert.ok(afterOne < DAILY.maxAgeMinutes,
    'the whole bug was that a failure waited out the full cadence');

  // And it backs off rather than hammering a genuinely broken upstream.
  await scheduler.runIfStale('__test_flaky', { force: true });
  assert.equal(scheduler.nextDueMinutes('__test_flaky', scheduler.JOBS.__test_flaky), 10);
  await scheduler.runIfStale('__test_flaky', { force: true });
  assert.equal(scheduler.nextDueMinutes('__test_flaky', scheduler.JOBS.__test_flaky), 20);
  assert.equal(scheduler.lastRun('__test_flaky').consecutive_failures, 3);
  delete scheduler.JOBS.__test_flaky;
});

test('the backoff is capped at the cadence, so a long-broken job is not hammered forever', () => {
  scheduler.JOBS.__test_capped = { ...DAILY, maxAgeMinutes: 60 };
  // 12 failures would be 5 * 2^11 = 10240 minutes without the cap.
  // Drive the counter up through the same path the scheduler uses.
  for (let i = 0; i < 12; i++) scheduler.recordSync('__test_capped', 'error', 'still broken');
  const due = scheduler.nextDueMinutes('__test_capped', scheduler.JOBS.__test_capped);
  delete scheduler.JOBS.__test_capped;

  assert.equal(due, 60, `backoff must settle at the job's own cadence, got ${due}`);
});

test('a success resets the failure count, so one bad day does not slow the next', async () => {
  scheduler.JOBS.__test_recovers = { ...DAILY, run: async () => { throw new Error('transient'); } };
  await scheduler.runIfStale('__test_recovers', { force: true });
  await scheduler.runIfStale('__test_recovers', { force: true });
  assert.equal(scheduler.lastRun('__test_recovers').consecutive_failures, 2);

  scheduler.JOBS.__test_recovers.run = async () => ({ ok: true, fetched: 1 });
  await scheduler.runIfStale('__test_recovers', { force: true });
  const logged = scheduler.lastRun('__test_recovers');
  const due = scheduler.nextDueMinutes('__test_recovers', scheduler.JOBS.__test_recovers);
  delete scheduler.JOBS.__test_recovers;

  assert.equal(logged.last_status, 'ok');
  assert.equal(logged.consecutive_failures, 0);
  assert.equal(due, DAILY.maxAgeMinutes, 'a recovered job returns to its normal cadence');
});

test('a never-run job is due immediately', () => {
  scheduler.JOBS.__test_never = { ...DAILY, run: async () => ({ ok: true }) };
  const due = scheduler.nextDueMinutes('__test_never', scheduler.JOBS.__test_never);
  delete scheduler.JOBS.__test_never;
  assert.equal(due, 0);
});
