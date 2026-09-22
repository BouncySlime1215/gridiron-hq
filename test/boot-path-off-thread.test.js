/**
 * Nothing on the boot path may block the request thread past the watchdog's
 * fuse (2026-09-19).
 *
 * The live app spent the evening restarting every ~160 seconds: serve for
 * about 100 seconds, go dark for about 60, restart. The 60-second dark window
 * is the event-loop watchdog's own threshold. Something on the boot path was
 * blocking the main thread long enough to be killed, and the restart ran the
 * same boot path again.
 *
 * THE NUMBERS ARE THE FINDING, not any one job. `DEFAULT_JOB_TIMEOUT_MS` is
 * 120,000 ms and the watchdog threshold is 60,000 ms, and every boot job used
 * the default. The scheduler granted every main-thread job a budget twice the
 * tolerance at which the host replaces the machine, so any main-thread job
 * that used half its allowance was fatal by design — whichever one it turned
 * out to be on the night. Hunting the individual job was hunting a symptom.
 *
 * Worse, the budget cannot protect the case that matters. `withJobTimeout` is
 * a `Promise.race`, so it can only abandon a promise; it cannot interrupt
 * synchronous work, and its own timer is queued behind the very block it is
 * meant to bound. `node:sqlite`'s DatabaseSync is fully synchronous. So a
 * lowered budget would read as a guard while guarding nothing, which is this
 * project's recurring failure and not a fix.
 *
 * So the invariant is structural rather than numeric: boot-path work does not
 * run on the request thread at all, and any exception is named in
 * `MAIN_THREAD_ONLY` with its reason. This file fails the moment someone adds
 * a boot job that is neither.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOT_JOBS, MAIN_THREAD_ONLY, JOBS, resolveOffThread, bootOffThread } from '../server/services/scheduler.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCHEDULER = readFileSync(join(ROOT, 'server/services/scheduler.js'), 'utf8');
const WATCHDOG = readFileSync(join(ROOT, 'server/platform/loop-watchdog.js'), 'utf8');

test('the job budget really is larger than the watchdog threshold', () => {
  // Not a rule, a record. If someone later brings these into line, this test
  // should be read again rather than deleted: the reason the boot path runs
  // off-thread does not depend on the gap, but the urgency did.
  const budget = Number(/DEFAULT_JOB_TIMEOUT_MS = ([\d_]+)/.exec(SCHEDULER)[1].replace(/_/g, ''));
  const fuse = Number(/LOOP_WATCHDOG_THRESHOLD_MS\) \|\| ([\d_]+)/.exec(WATCHDOG)[1].replace(/_/g, ''));
  assert.ok(budget > fuse,
    `expected the documented mismatch: job budget ${budget}ms vs watchdog ${fuse}ms`);
});

test('every boot job either runs off-thread or is named with a reason', () => {
  const onMainThread = BOOT_JOBS.filter(name => !resolveOffThread(JOBS[name], bootOffThread(name)));
  assert.deepEqual(onMainThread, [...MAIN_THREAD_ONLY.keys()].filter(n => BOOT_JOBS.includes(n)),
    'a boot job that runs on the request thread must be named in MAIN_THREAD_ONLY with the reason '
    + 'it cannot move; unnamed ones can block the loop past the watchdog threshold and restart the app');
  for (const [name, reason] of MAIN_THREAD_ONLY) {
    assert.ok(JOBS[name], `MAIN_THREAD_ONLY names ${name}, which is not a job`);
    assert.ok(reason && reason.length > 20, `MAIN_THREAD_ONLY entry ${name} needs a real reason`);
  }
});

test('every name in the boot list is a real job', () => {
  // A typo here is silent: runIfStale returns { error: 'unknown job' } and the
  // pass carries on, so a job could quietly never run at boot.
  const missing = BOOT_JOBS.filter(name => !JOBS[name]);
  assert.deepEqual(missing, []);
});

test('the boot pass passes the per-job override rather than calling bare', () => {
  // Source-level, because the pass is fire-and-forget behind a setTimeout: no
  // test can observe it from outside without waiting out bootDelayMs.
  assert.match(SCHEDULER, /for \(const j of bootJobs\) await runIfStale\(j, \{ offThread: bootOffThread\(j\) \}\)/);
});

test('the two delayed boot timers run off-thread too', () => {
  // nfl_model_growth is the one that mattered: growth tier with no offThread
  // flag, fired at a flat 90s after every boot from its own setTimeout, and
  // run every boot rather than every six hours because nextDueMinutes gives an
  // errored job a five-minute retry window.
  assert.match(SCHEDULER, /runIfStale\('nfl_model_growth', \{ offThread: true \}\)/);
  assert.match(SCHEDULER, /runIfStale\('nfl_reports', \{ offThread: true \}\)/);
});

test('resolveOffThread prefers the override and otherwise keeps the old rule', () => {
  assert.equal(resolveOffThread({ tier: 'live' }, true), true);
  assert.equal(resolveOffThread({ tier: 'heavy' }, false), false, 'an explicit false must win');
  // No override: exactly what the code did before this change.
  assert.equal(resolveOffThread({ tier: 'live' }, undefined), false);
  assert.equal(resolveOffThread({ tier: 'heavy' }, undefined), true);
  assert.equal(resolveOffThread({ tier: 'live', offThread: true }, undefined), true);
  assert.equal(resolveOffThread({ tier: 'heavy', offThread: false }, undefined), false);
});

test('the allow-list is only an escape for jobs that need it', () => {
  // If book-feeds ever persists _providerBackoff and _directBookLastSeen, this
  // is the test that should be updated as the entries come out, rather than
  // the allow-list quietly growing.
  assert.deepEqual([...MAIN_THREAD_ONLY.keys()],
    ['nfl_book_feeds_fast', 'nfl_book_feeds_slow', 'nfl_book_feeds_extra']);
});
