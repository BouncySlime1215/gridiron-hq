/**
 * Worker-thread entry for report-cache.js. Opens its own SQLite connection
 * (db/index.js reads GRIDIRON_DB_PATH from the inherited env), imports the
 * heavy service, runs one function, and posts the JSON-serializable result.
 * Anything not serializable is dropped by the structured clone, which is
 * the same contract the HTTP route had.
 */
import { parentPort, workerData } from 'node:worker_threads';

try {
  const mod = await import(workerData.module);
  const fn = mod[workerData.fn];
  if (typeof fn !== 'function') throw new Error(`${workerData.module} has no export ${workerData.fn}`);
  const value = await fn(...(workerData.args ?? []));
  parentPort.postMessage({ value: JSON.parse(JSON.stringify(value ?? null)) });
} catch (error) {
  parentPort.postMessage({ error: error?.message ?? String(error) });
}
