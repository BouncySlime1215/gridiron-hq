/**
 * Kill this process if the event loop stops turning, so the host can replace it.
 *
 * WHY THIS EXISTS. On 2026-09-19 the app was wedged for over three hours and
 * nothing recovered it. Fly's check was TCP-only, which the kernel's listen
 * backlog answers while the loop is blocked, so the platform saw a healthy
 * machine. /api/health and an HTTP check fix the seeing. They do not fix the
 * recovering: Fly's health checks and its restart policy are independent, and
 * a failing check stops traffic being routed to a machine but never restarts
 * it. Only a process EXIT does that, under the default `on-failure` policy.
 * So something inside the process has to notice and exit.
 *
 * WHY A WORKER THREAD. A watchdog on the main thread cannot fire during a
 * block, by definition — its own timer is queued behind whatever is blocking,
 * and it only runs once the block is over, which is exactly when it is no
 * longer needed. The main thread instead writes a timestamp into shared
 * memory once a second, and a worker on its own thread watches that timestamp
 * go stale in real time. Shared memory rather than a message because
 * postMessage is delivered through the event loop this is trying to observe.
 *
 * WHY SIGKILL. SIGTERM is handled on the main thread, which is the blocked
 * one, so a wedged process ignores it for as long as the wedge lasts. SQLite
 * is in WAL mode and crash-safe (db/index.js), and the process being killed is
 * by definition serving nothing, so an abrupt end costs nothing a graceful one
 * would have saved.
 *
 * The threshold is deliberately far beyond any legitimate pause. With the
 * heavy scheduler tier moved to worker threads, the main thread should never
 * block for anything close to a minute; if it does, the app has already failed
 * by any definition a user would recognize. Set LOOP_WATCHDOG_DISABLED=1 to
 * turn it off.
 */
import { Worker } from 'node:worker_threads';

const HEARTBEAT_MS = 1000;

let worker = null;
let beat = null;

export function startLoopWatchdog({
  thresholdMs = Number(process.env.LOOP_WATCHDOG_THRESHOLD_MS) || 60_000,
  // Nothing is watched until the app has been up a while: boot runs migrations,
  // seed reconciliation and the evidence warm-up, and a watchdog that fired on
  // a slow first start would turn a long boot into a restart loop, which is a
  // far worse failure than the one it is guarding against.
  armAfterMs = 120_000
} = {}) {
  if (process.env.LOOP_WATCHDOG_DISABLED === '1') return { disabled: true };
  if (worker) return { already_running: true };

  // Int32Array rather than BigInt64Array so Atomics.store/load work on every
  // platform Node supports. Milliseconds since the watchdog started fits in an
  // int32 for 24 days; it is re-based below rather than allowed to overflow.
  const shared = new SharedArrayBuffer(4);
  const cell = new Int32Array(shared);
  const startedAt = Date.now();
  const stamp = () => Atomics.store(cell, 0, Date.now() - startedAt);
  stamp();

  beat = setInterval(stamp, HEARTBEAT_MS);
  // The heartbeat must never be the reason the process stays alive.
  beat.unref?.();

  worker = new Worker(new URL('./loop-watchdog-worker.js', import.meta.url), {
    workerData: { shared, thresholdMs, armAfterMs, startedAt, heartbeatMs: HEARTBEAT_MS }
  });
  // Same: a watchdog that held the process open would keep a CLI or a test
  // runner from ever exiting.
  worker.unref();
  worker.once('error', error => console.error('[watchdog] stopped:', error?.message ?? error));

  return { started: true, threshold_ms: thresholdMs, arm_after_ms: armAfterMs };
}

export function stopLoopWatchdog() {
  if (beat) { clearInterval(beat); beat = null; }
  if (worker) { worker.terminate().catch(() => {}); worker = null; }
  return { stopped: true };
}
