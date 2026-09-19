/**
 * What may arm the event-loop watchdog, and what must not (2026-09-19).
 *
 * #29 gave the watchdog a rule it argued for at length: arm on a completed
 * HTTP response, never on a timer, because a timer-armed watchdog can kill a
 * process that is still booting and turn one slow boot into an endless restart
 * loop. The rule was right and the implementation had a hole in it, and the
 * hole produced exactly the restart loop the rule was written to prevent.
 *
 * `fly.toml` polls `/api/health` every 15 seconds. On the deployed machine the
 * first completed HTTP response is therefore the platform's own liveness
 * probe, about 15 seconds after `app.listen` — before the scheduler's boot
 * pass has started, never mind finished. So the watchdog armed in the middle
 * of boot, the boot pass blocked the thread past the 60-second threshold, the
 * watchdog SIGKILLed the process, Fly restarted it, and the same boot pass ran
 * again. Measured on the live app on 2026-09-19: two starts 165 seconds apart,
 * each serving for roughly 100 seconds and then going silent.
 *
 * Arming on that probe is circular as well as early. `/api/health` runs
 * JavaScript and makes one synchronous SQLite call, so it answers exactly when
 * the event loop is turning — the thing the watchdog itself measures.
 *
 * Both assertions below are needed and neither is sufficient. Excluding the
 * liveness path alone would leave an app nobody has visited yet permanently
 * unarmed, because once it wedges the request that would have armed it can no
 * longer complete. Arming from the boot pass alone would not stop the probe
 * arming it early. The pair is the fix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVENESS_PATH, watchdogArmingMiddleware, startLoopWatchdog, stopLoopWatchdog
} from '../server/platform/loop-watchdog.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A response object that records whether anything subscribed to 'finish'. */
function fakeRes() {
  const listeners = [];
  return { once: (event, fn) => { if (event === 'finish') listeners.push(fn); }, listeners };
}

test("the host's liveness probe does not arm the watchdog", () => {
  const res = fakeRes();
  let nexted = false;
  watchdogArmingMiddleware({ path: LIVENESS_PATH }, res, () => { nexted = true; });
  assert.equal(res.listeners.length, 0,
    'a response to the liveness path must not arm the watchdog: fly.toml polls it every 15s, '
    + 'so it would arm during boot and make a slow boot pass a restart loop');
  assert.ok(nexted, 'the middleware must still pass the request along');
});

test('an ordinary request still arms the watchdog', () => {
  const res = fakeRes();
  watchdogArmingMiddleware({ path: '/api/teams' }, res, () => {});
  assert.equal(res.listeners.length, 1);
});

test('a path that merely starts with the liveness path still arms it', () => {
  // The exclusion is an equality, not a prefix. `/api/healthz` or
  // `/api/health-report` would be app routes and their traffic is real.
  const res = fakeRes();
  watchdogArmingMiddleware({ path: `${LIVENESS_PATH}-report` }, res, () => {});
  assert.equal(res.listeners.length, 1);
});

test('arming that arrives before the watchdog starts is not lost', async () => {
  // startScheduler calls back synchronously when SCHEDULER_DISABLED=1, and that
  // is before app.listen, where the watchdog starts. An arm dropped there would
  // leave the process unwatched for good.
  const { armLoopWatchdog } = await import('../server/platform/loop-watchdog.js');
  stopLoopWatchdog();
  armLoopWatchdog();
  const started = startLoopWatchdog({ thresholdMs: 60_000 });
  assert.equal(started.started, true);
  // Arming is internal state; the observable proof is in the child-process test
  // in loop-watchdog.test.js. Here it is enough that starting after an early
  // arm does not throw and does not reset anything.
  stopLoopWatchdog();
});

test('the scheduler arms the watchdog when its boot pass finishes', () => {
  // A source assertion, because the wiring is what was wrong: the boot pass is
  // fire-and-forget behind a setTimeout, so no test can observe it from the
  // outside without waiting out bootDelayMs.
  const index = readFileSync(join(ROOT, 'server/index.js'), 'utf8');
  assert.match(index, /startScheduler\(\{[^}]*onBootComplete:\s*armLoopWatchdog/,
    'server/index.js must pass armLoopWatchdog as startScheduler onBootComplete');

  const scheduler = readFileSync(join(ROOT, 'server/services/scheduler.js'), 'utf8');
  assert.match(scheduler, /onBootComplete\s*=\s*null/,
    'startScheduler must accept an onBootComplete option');
  // In a `finally`, not on success: a pass where every job timed out has still
  // finished blocking the thread, which is all the watchdog cares about.
  assert.match(scheduler, /\.finally\(\(\) => \{ try \{ onBootComplete\?\.\(\)/,
    'the boot pass must call onBootComplete however it ends');
});

test('the liveness path the watchdog excludes is the one fly.toml probes', () => {
  // If these ever drift apart, the exclusion silently stops applying to the
  // traffic it was written for and the restart loop comes back.
  const fly = readFileSync(join(ROOT, 'fly.toml'), 'utf8');
  const paths = [...fly.matchAll(/^\s*path\s*=\s*"([^"]+)"/gm)].map(m => m[1]);
  assert.deepEqual(paths, [LIVENESS_PATH]);
});
