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
 *
 * ARMED BY A SERVED REQUEST, NOT BY A TIMER, and this is the most important
 * decision in the file. A timer-armed watchdog can kill a process that is
 * still starting up, which turns one slow boot into an endless restart loop --
 * strictly worse than the wedge it is guarding against. And this app's boot is
 * genuinely slow after `app.listen`: the scheduler fires twenty boot jobs
 * twenty seconds in, sequentially, on the main thread, and a cold start on the
 * deployed machine was measured at about three minutes to first byte on
 * 2026-09-19. Any fixed arming delay is a guess against that number.
 *
 * So the watchdog watches nothing until the app has actually completed an HTTP
 * response. That is proof, rather than an assumption, that it reached a
 * serving state -- after which a minute of no event loop means it has left
 * one. The deliberate consequence: a process that never manages to serve
 * anything is never killed by this. That case is a failed boot, which a
 * restart would not fix, and it is what the health check and a human are for.
 */
import { Worker } from 'node:worker_threads';

const HEARTBEAT_MS = 1000;

let worker = null;
let beat = null;
let armed = null;

export function startLoopWatchdog({
  thresholdMs = Number(process.env.LOOP_WATCHDOG_THRESHOLD_MS) || 60_000
} = {}) {
  if (process.env.LOOP_WATCHDOG_DISABLED === '1') return { disabled: true };
  if (worker) return { already_running: true };

  // Two Int32 cells (Int32Array rather than BigInt64Array so Atomics work on
  // every platform Node supports): [0] is the heartbeat, milliseconds since
  // this watchdog started, and [1] is the armed flag. Milliseconds fit in an
  // int32 for 24 days, which is why the heartbeat is relative to startedAt
  // rather than an absolute epoch.
  const shared = new SharedArrayBuffer(8);
  const cell = new Int32Array(shared);
  armed = cell;
  const startedAt = Date.now();
  const stamp = () => Atomics.store(cell, 0, Date.now() - startedAt);
  stamp();

  beat = setInterval(stamp, HEARTBEAT_MS);
  // The heartbeat must never be the reason the process stays alive.
  beat.unref?.();

  worker = new Worker(new URL('./loop-watchdog-worker.js', import.meta.url), {
    workerData: { shared, thresholdMs, startedAt, heartbeatMs: HEARTBEAT_MS }
  });
  // Same: a watchdog that held the process open would keep a CLI or a test
  // runner from ever exiting.
  worker.unref();
  worker.once('error', error => console.error('[watchdog] stopped:', error?.message ?? error));

  return { started: true, threshold_ms: thresholdMs, armed_by: 'first completed HTTP response' };
}

/**
 * Called when the app completes an HTTP response. Idempotent and as close to
 * free as it can be, because it sits on the request path: after the first call
 * it is one Atomics.load and a comparison.
 */
export function armLoopWatchdog() {
  if (!armed || Atomics.load(armed, 1) === 1) return;
  Atomics.store(armed, 1, 1);
}

/** Express middleware form of the above. */
export function watchdogArmingMiddleware(req, res, next) {
  res.once('finish', armLoopWatchdog);
  next();
}

export function stopLoopWatchdog() {
  armed = null;
  if (beat) { clearInterval(beat); beat = null; }
  if (worker) { worker.terminate().catch(() => {}); worker = null; }
  return { stopped: true };
}
