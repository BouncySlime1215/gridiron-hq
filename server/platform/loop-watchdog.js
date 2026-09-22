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
 *
 * EXCEPT THAT THE HOST'S OWN LIVENESS PROBE IS NOT PROOF OF ANYTHING, and
 * missing that turned the paragraph above into the restart loop it was written
 * to prevent. `fly.toml` polls `/api/health` every 15 seconds, so on the
 * deployed machine the first completed response is the platform's probe,
 * roughly 15 seconds after `app.listen` -- before the scheduler's boot pass has
 * even started, let alone finished. The arming was meant to wait for the boot
 * to be over and instead fired in the middle of it, so a boot-pass block past
 * the threshold became SIGKILL, restart, same boot pass, again. Measured on the
 * live app on 2026-09-19: two starts 165 seconds apart, each serving for about
 * 100 seconds and then going silent.
 *
 * It is circular as well as wrong. `/api/health` executes JavaScript and makes
 * one synchronous SQLite call -- it answers exactly when the event loop is
 * turning, which is the thing this watchdog measures. Arming on it means
 * arming on a weaker copy of the watchdog's own signal.
 *
 * So the liveness path does not arm anything (see `watchdogArmingMiddleware`),
 * and the gap that leaves is closed from the other end: the scheduler's boot
 * pass arms the watchdog when it finishes (`startScheduler`'s `onBootComplete`,
 * wired in server/index.js). Both halves are needed. Without the second, an app
 * that nobody has visited yet would wedge after boot and never be restarted,
 * because the request that would have armed it can no longer complete. Every
 * job in the boot pass is time-bound, so the pass always ends and the arming
 * always happens, whether the jobs succeeded or timed out.
 */
import { Worker } from 'node:worker_threads';

const HEARTBEAT_MS = 1000;

let worker = null;
let beat = null;
let armed = null;
// An arm that arrived before the watchdog started. It is not hypothetical:
// `startScheduler` calls back synchronously when SCHEDULER_DISABLED=1, and that
// runs before `app.listen`, which is where the watchdog starts. Dropping it
// would leave the process permanently unwatched for a reason nobody would
// guess from either call site.
let armedEarly = false;
// Header: [heartbeat, armed, nameLen]. 12 bytes, then the name.
const HEADER_CELLS = 3;
const HEADER_BYTES = HEADER_CELLS * 4;
// 64 bytes is comfortably past the longest job name in the registry
// (`polymarket_line_watch`, 21). A longer one is truncated rather than
// refused: a slightly clipped name in a kill line beats no kill line.
const NAME_BYTES = 64;
let nameBytes = null;
const encoder = new TextEncoder();

export function startLoopWatchdog({
  thresholdMs = Number(process.env.LOOP_WATCHDOG_THRESHOLD_MS) || 60_000
} = {}) {
  if (process.env.LOOP_WATCHDOG_DISABLED === '1') return { disabled: true };
  if (worker) return { already_running: true };

  // Three Int32 cells (Int32Array rather than BigInt64Array so Atomics work on
  // every platform Node supports): [0] is the heartbeat, milliseconds since
  // this watchdog started, [1] is the armed flag, and [2] is the byte length
  // of the running job's name. Milliseconds fit in an int32 for 24 days, which
  // is why the heartbeat is relative to startedAt rather than an absolute
  // epoch. After the header comes NAME_BYTES of UTF-8 for that name.
  //
  // The name lives in SHARED memory, not in a variable, for the same reason
  // the watchdog lives on its own thread: at the moment it matters the main
  // thread is blocked and cannot answer a question. Whatever is going to be
  // read out of the kill line has to have been written there BEFORE the block
  // started.
  const shared = new SharedArrayBuffer(HEADER_BYTES + NAME_BYTES);
  const cell = new Int32Array(shared, 0, HEADER_CELLS);
  armed = cell;
  nameBytes = new Uint8Array(shared, HEADER_BYTES, NAME_BYTES);
  if (armedEarly) { Atomics.store(cell, 1, 1); armedEarly = false; }
  const startedAt = Date.now();
  const stamp = () => Atomics.store(cell, 0, Date.now() - startedAt);
  stamp();

  beat = setInterval(stamp, HEARTBEAT_MS);
  // The heartbeat must never be the reason the process stays alive.
  beat.unref?.();

  worker = new Worker(new URL('./loop-watchdog-worker.js', import.meta.url), {
    workerData: { shared, thresholdMs, startedAt, heartbeatMs: HEARTBEAT_MS,
      headerBytes: HEADER_BYTES, headerCells: HEADER_CELLS, nameBytes: NAME_BYTES }
  });
  // Same: a watchdog that held the process open would keep a CLI or a test
  // runner from ever exiting.
  worker.unref();
  worker.once('error', error => console.error('[watchdog] stopped:', error?.message ?? error));

  return { started: true, threshold_ms: thresholdMs, armed_by: 'the scheduler boot pass, or any completed response other than the liveness probe' };
}

/**
 * Called when the app completes an HTTP response. Idempotent and as close to
 * free as it can be, because it sits on the request path: after the first call
 * it is one Atomics.load and a comparison.
 */
export function armLoopWatchdog() {
  if (!armed) { armedEarly = true; return; }
  if (Atomics.load(armed, 1) === 1) return;
  Atomics.store(armed, 1, 1);
}

/**
 * Records which job is about to run, so that if it blocks the thread the kill
 * line can name it.
 *
 * This is the difference between "the event loop stopped for 60s" and "the
 * event loop stopped for 60s during nfl_model_growth". The first has cost this
 * project days of guessing at which of two dozen jobs was responsible; the
 * second ends the question in the log line itself.
 *
 * Call it BEFORE the work starts. A marker written after a synchronous job
 * begins is never written at all, because the thread never comes back to run
 * it. Cheap by construction: one encode and one store, off the request path.
 */
export function markJobRunning(name) {
  if (!nameBytes || !armed) return;
  const encoded = encoder.encode(String(name ?? ''));
  const len = Math.min(encoded.length, NAME_BYTES);
  nameBytes.set(encoded.subarray(0, len));
  // Length stored LAST, deliberately: the worker reads the length first and
  // treats 0 as "no job", so this order means it can never decode a name that
  // is only half written. Stated honestly -- the suite does NOT prove this
  // ordering. Reversing these two lines leaves all 8 watchdog tests passing,
  // because the window is nanoseconds and a test cannot reliably land inside
  // it. The order is kept because it is free and the race is real across two
  // threads, not because anything checks it. Do not cite this comment as
  // evidence that it is tested.
  Atomics.store(armed, 2, len);
}

/** Clears the marker once the job has returned, however it returned. */
export function clearJobRunning() {
  if (!armed) return;
  Atomics.store(armed, 2, 0);
}

/**
 * The host's liveness path. A response to it must never arm the watchdog --
 * see the third block of the file comment for why, and server/index.js for
 * where the boot pass arms it instead.
 *
 * Declared here rather than imported from the route, because the reason it is
 * special belongs to the watchdog: this is the one path whose traffic is
 * generated by the platform on a timer rather than by anything using the app.
 */
export const LIVENESS_PATH = '/api/health';

/** Express middleware form of the above. */
export function watchdogArmingMiddleware(req, res, next) {
  // Not `startsWith`: an app route that merely begins with the same characters
  // is ordinary traffic and should arm normally.
  if (req.path === LIVENESS_PATH) return next();
  res.once('finish', armLoopWatchdog);
  next();
}

export function stopLoopWatchdog() {
  armed = null;
  nameBytes = null;
  armedEarly = false;
  if (beat) { clearInterval(beat); beat = null; }
  if (worker) { worker.terminate().catch(() => {}); worker = null; }
  return { stopped: true };
}
