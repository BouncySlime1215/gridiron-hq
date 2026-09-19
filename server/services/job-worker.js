/**
 * Worker-thread entry for scheduler.js's off-thread jobs.
 *
 * Node serves every request on one thread, and node:sqlite's DatabaseSync is
 * fully synchronous, so a scheduled job that parses a 7 MB CSV or refits a
 * model does not just take a long time — every HTTP request queues behind it
 * for exactly as long. report-cache.js already solved this for reports; this
 * is the same solution for the ingestion and compute jobs in JOBS.
 *
 * Two shapes, deliberately:
 *
 *   { job: 'nfl_weekly_learning' }   — import scheduler.js here and run that
 *                                      job's own `run()`. The heavy job bodies
 *                                      are closures in scheduler.js, so this
 *                                      needs no restructuring of any of them.
 *   { module, fn, args }             — import a module and call one export,
 *                                      report-worker.js's contract. Used by
 *                                      the tests, and available to any job
 *                                      that would rather name its work
 *                                      explicitly than be looked up by name.
 *
 * This thread never writes sync_log. The main thread records the outcome, so
 * there is exactly one writer of a job's status and a worker that dies without
 * reporting is still recorded (by the 'exit' handler in scheduler.js) rather
 * than leaving a job looking like it is permanently mid-run.
 */
import { parentPort, workerData } from 'node:worker_threads';

let dbLoaded = false;
try {
  let value;
  if (workerData.job) {
    const scheduler = await import('./scheduler.js');
    dbLoaded = true; // scheduler.js imports db/index.js, so a connection is open from here
    const spec = scheduler.JOBS[workerData.job];
    if (!spec) throw new Error(`unknown job ${workerData.job}`);
    value = await spec.run();
  } else {
    const mod = await import(workerData.module);
    dbLoaded = true;
    const fn = mod[workerData.fn];
    if (typeof fn !== 'function') throw new Error(`${workerData.module} has no export ${workerData.fn}`);
    value = await fn(...(workerData.args ?? []));
  }
  // Structured clone drops anything non-serializable; the detail is only ever
  // JSON.stringify'd into sync_log, so round-tripping it here means the main
  // thread sees exactly what it will store rather than failing at postMessage.
  parentPort.postMessage({ value: JSON.parse(JSON.stringify(value ?? null)) });
} catch (error) {
  parentPort.postMessage({ error: error?.message ?? String(error) });
} finally {
  // Close this thread's own SQLite connection immediately rather than at
  // teardown — report-cache.js's opportunistic WAL checkpoint can only
  // reclaim space once every reader is actually gone, and an ingestion job
  // holds a far larger write footprint than a report ever did.
  if (dbLoaded) {
    try { (await import('../db/index.js')).db.close(); } catch { /* nothing to close */ }
  }
}
