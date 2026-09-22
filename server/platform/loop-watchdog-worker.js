/**
 * The watching half of loop-watchdog.js. Runs on its own thread, so it keeps
 * running while the main thread is blocked — which is the only moment it
 * matters.
 */
import { workerData } from 'node:worker_threads';
import { writeSync } from 'node:fs';

const { shared, thresholdMs, startedAt, heartbeatMs, headerBytes, headerCells, nameBytes } = workerData;
const cell = new Int32Array(shared, 0, headerCells);
// The running job's name, written by the main thread before each job starts.
// Read from shared memory rather than asked for, because by the time this
// matters the main thread is blocked and cannot answer anything.
const nameView = new Uint8Array(shared, headerBytes, nameBytes);
const decoder = new TextDecoder();

/** The job the main thread said it was running, or null if none was marked. */
function runningJob() {
  // Length first: the writer stores it last, so a non-zero length means the
  // bytes behind it are complete.
  const len = Atomics.load(cell, 2);
  if (len <= 0) return null;
  try { return decoder.decode(nameView.subarray(0, len)); } catch { return null; }
}

// Checked several times per threshold so the report names a real duration
// rather than rounding up to the next whole check.
const interval = setInterval(() => {
  // Cell 1 is set by the main thread once it has completed an HTTP response.
  // Until then this process has never been observed to serve anything, so
  // killing it could only turn a slow boot into a restart loop.
  if (Atomics.load(cell, 1) !== 1) return;
  const uptime = Date.now() - startedAt;
  // How long since the main thread last managed to run a one-second timer.
  const blockedMs = uptime - Atomics.load(cell, 0) - heartbeatMs;
  if (blockedMs < thresholdMs) return;

  // writeSync to fd 2, NOT console.error. A worker's stdout and stderr are
  // piped to the parent and delivered through the MAIN thread's event loop --
  // the one that is blocked -- so a console.error here would be queued behind
  // the wedge and then destroyed by the SIGKILL below. Nobody would ever learn
  // why the process died. writeSync goes straight to the file descriptor.
  // (Found by the test asserting this line reaches the logs; it did not.)
  const job = runningJob();
  writeSync(2, `[watchdog] the event loop has not turned for ${Math.round(blockedMs / 1000)}s ` +
    `(threshold ${Math.round(thresholdMs / 1000)}s). ` +
    // Naming the job is the whole point of the marker: without it the log says
    // the loop stopped and leaves which of two dozen jobs stopped it to be
    // guessed at from timing.
    (job ? `The job running when it stopped was '${job}'. ` : 'No job was marked as running. ') +
    'The process is serving nothing, so it is being ' +
    'killed to let the host restart it. If this is not a hung job, raise LOOP_WATCHDOG_THRESHOLD_MS ' +
    'or set LOOP_WATCHDOG_DISABLED=1.\n');
  clearInterval(interval);
  // SIGKILL, not SIGTERM: a SIGTERM handler would run on the blocked thread
  // and therefore not run at all. process.kill signals the whole process, not
  // this worker.
  process.kill(process.pid, 'SIGKILL');
}, Math.max(250, Math.floor(thresholdMs / 8)));
