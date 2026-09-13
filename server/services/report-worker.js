/**
 * Worker-thread entry for report-cache.js. Opens its own SQLite connection
 * (db/index.js reads GRIDIRON_DB_PATH from the inherited env), imports the
 * heavy service, runs one function, and posts the JSON-serializable result.
 * Anything not serializable is dropped by the structured clone, which is
 * the same contract the HTTP route had.
 */
import { parentPort, workerData } from 'node:worker_threads';

let reportModuleLoaded = false;
try {
  const mod = await import(workerData.module);
  reportModuleLoaded = true; // only past this point could db/index.js have been imported
  const fn = mod[workerData.fn];
  if (typeof fn !== 'function') throw new Error(`${workerData.module} has no export ${workerData.fn}`);
  const value = await fn(...(workerData.args ?? []));
  parentPort.postMessage({ value: JSON.parse(JSON.stringify(value ?? null)) });
} catch (error) {
  parentPort.postMessage({ error: error?.message ?? String(error) });
} finally {
  // Close this worker's own read connection explicitly and immediately,
  // rather than leaving it to whenever the thread happens to be torn down.
  // report-cache.js runs an opportunistic WAL checkpoint after this worker
  // exits, and that checkpoint can only reclaim space once every reader --
  // this one included -- is actually gone.
  if (reportModuleLoaded) {
    try { (await import('../db/index.js')).db.close(); } catch { /* nothing to close */ }
  }
}
