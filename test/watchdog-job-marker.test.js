/**
 * The scheduler must tell the watchdog which job it is running (2026-09-22).
 *
 * The kill-line tests in loop-watchdog.test.js prove the watchdog PRINTS the
 * marked job. They do not prove anything sets it -- deleting
 * `markJobRunning(name)` from runJobNow leaves all eight of them passing,
 * because the fixture marks the job itself. That gap is what this file closes:
 * the wiring between the scheduler and the watchdog, which is the half that
 * actually runs in production.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const scheduler = readFileSync(`${ROOT}server/services/scheduler.js`, 'utf8');

test('runJobNow marks the job as running before it runs it', () => {
  const body = scheduler.slice(scheduler.indexOf('async function runJobNow'));
  const marker = body.indexOf('markJobRunning(name)');
  assert.ok(marker !== -1,
    'runJobNow must call markJobRunning(name), or a stall names no job');
  // Before the work, not after. A marker set after synchronous work begins is
  // never set at all, because the thread does not come back to set it.
  const tryBlock = body.indexOf('try {');
  assert.ok(marker < tryBlock,
    'markJobRunning must be called BEFORE the try block that runs the job');
});

test('the marker is cleared in a finally, not only on the happy path', () => {
  const body = scheduler.slice(scheduler.indexOf('async function runJobNow'));
  const fin = body.indexOf('} finally {');
  assert.ok(fin !== -1, 'runJobNow must have a finally block');
  // By name: tiers overlap, and a clear that wiped every marker let the job
  // that finished first erase the name of the one still holding the thread.
  const clear = body.indexOf('clearJobRunning(name)');
  assert.ok(clear !== -1, 'runJobNow must clear its own marker, by name');
  assert.ok(clear > fin,
    'clearJobRunning must be inside the finally: a job that threw is as '
    + 'finished as one that returned, and a stale marker makes the NEXT '
    + 'stall blame the wrong job');
});

test('an off-thread job is not marked, because it cannot block this thread', () => {
  // A worker-thread job running while a request path wedges the loop would
  // otherwise be named in the kill line as the culprit -- the wrong suspect,
  // and the same misdirection the marker exists to end.
  const body = scheduler.slice(scheduler.indexOf('async function runJobNow'));
  assert.match(body.slice(0, body.indexOf('try {')),
    /const offThread = resolveOffThread\(job, offThreadOverride\);\s*if \(!offThread\) markJobRunning\(name\);/,
    'runJobNow must decide offThread first and mark only an inline job');
});

test('both marker functions are imported from the watchdog', () => {
  assert.match(scheduler, /import \{[^}]*markJobRunning[^}]*\} from '\.\.\/platform\/loop-watchdog\.js'/,
    'markJobRunning must come from the watchdog module');
  assert.match(scheduler, /import \{[^}]*clearJobRunning[^}]*\} from '\.\.\/platform\/loop-watchdog\.js'/,
    'clearJobRunning must come from the watchdog module');
});
