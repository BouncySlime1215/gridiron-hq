/**
 * How long does each live-tier job block the event loop?
 *
 *   GRIDIRON_DB_PATH=/path/to/copy.sqlite node scripts/measure-live-tier-stalls.mjs
 *
 * WHY THIS EXISTS. The live tier runs on a 90-second timer and, on 791b131,
 * 23 of its 24 jobs ran on the request thread. `node:sqlite`'s DatabaseSync is
 * synchronous, so a job that blocks does not block only itself -- it blocks the
 * HTTP server, the health route answers nothing, and the #29 event-loop
 * watchdog SIGKILLs the process at 60s. Which job does that has been argued
 * from code and never measured. This measures it.
 *
 * THE INSTRUMENT. `perf_hooks.monitorEventLoopDelay` samples how late the loop
 * is relative to a fixed interval. Synchronous work cannot be preempted, so a
 * job that blocks for N ms shows up as a single sample of ~N ms. `max` is the
 * longest single stall -- which is the number that matters, because the
 * watchdog fires on one continuous stall, not on cumulative slowness.
 *
 * READ `max`, NOT `mean`. A job that blocks once for 70s and is idle the rest
 * of the time has a mean in the milliseconds and is still fatal.
 *
 * THRESHOLDS (Nick, 2026-09-22): over 60s = killer (it is the watchdog's own
 * threshold), over 10s = suspect, under = clear on this database.
 *
 * WHAT A "CLEAR" HERE IS AND IS NOT. Every figure is a property of the DATABASE
 * IT RAN AGAINST. These jobs are dominated by synchronous SQLite, so a job that
 * is instant on an empty schema can block for a minute on a populated one. A
 * result over threshold is therefore conclusive -- it is a lower bound, and the
 * real database can only be slower. A result under threshold is conclusive ONLY
 * for that database. The run prints what it ran against so the two cannot be
 * confused.
 *
 * Nothing here is a mock. The jobs run for real, against whatever database
 * GRIDIRON_DB_PATH names, and they will write to it -- so point it at a COPY.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

if (!process.env.GRIDIRON_DB_PATH) {
  console.error('Refusing to run: set GRIDIRON_DB_PATH to a COPY. These jobs write.');
  process.exit(2);
}

// Per-job wall-clock ceiling. It cannot interrupt synchronous work -- nothing
// in JavaScript can -- so it only bounds jobs that are slow in their ASYNC
// phase (a hanging fetch). A job that blocks the thread runs to completion and
// is reported in full, which is the case we are hunting anyway.
const PER_JOB_TIMEOUT_MS = Number(process.env.STALL_JOB_TIMEOUT_MS) || 180_000;

const { JOBS } = await import('../server/services/scheduler.js');
const { db } = await import('../server/db/index.js');

const liveJobs = Object.entries(JOBS)
  .filter(([, j]) => j.tier === 'live')
  .map(([name]) => name);

// Count network calls per job. Every ingest in this codebase goes through
// global fetch; anything that did not would show as network=no and is worth
// noticing rather than assuming.
let fetchCount = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { fetchCount++; return realFetch(...args); };

const totalChanges = () => db.prepare('SELECT total_changes() AS n').get().n;

const withTimeout = (promise, ms, name) => Promise.race([
  Promise.resolve(promise),
  new Promise((_, reject) => setTimeout(() => reject(new Error(`exceeded ${ms}ms of wall clock`)), ms).unref()),
]).catch((e) => { throw e instanceof Error ? e : new Error(String(e)); });

const results = [];
console.error(`Measuring ${liveJobs.length} live-tier jobs against ${process.env.GRIDIRON_DB_PATH}\n`);

for (const name of liveJobs) {
  const job = JOBS[name];
  const h = monitorEventLoopDelay({ resolution: 10 });
  fetchCount = 0;
  const changesBefore = totalChanges();

  // Let anything left over from the previous job settle, so its tail is not
  // attributed to this one.
  await new Promise((r) => setTimeout(r, 50));

  h.enable();
  const t0 = performance.now();
  let status = 'ok';
  let detail = '';
  try {
    const out = await withTimeout(job.run(), PER_JOB_TIMEOUT_MS, name);
    if (out && typeof out === 'object') {
      if (out.error) { status = 'error'; detail = String(out.error).slice(0, 120); }
      else if (out.skipped) { status = 'skipped'; detail = String(out.skipped).slice(0, 120); }
    }
  } catch (e) {
    status = 'threw';
    detail = String(e?.message ?? e).slice(0, 120);
  }
  const wallMs = performance.now() - t0;
  h.disable();

  // `max` is in NANOSECONDS. Reading it as milliseconds understates every
  // stall by six orders of magnitude and would clear every job on the list.
  const maxStallMs = h.max / 1e6;

  results.push({
    name, maxStallMs, wallMs, fetches: fetchCount,
    rowsWritten: totalChanges() - changesBefore,
    status, detail,
    verdict: maxStallMs >= 60_000 ? 'KILLER' : maxStallMs >= 10_000 ? 'SUSPECT' : 'clear',
  });
  const r = results[results.length - 1];
  console.error(`  ${name.padEnd(24)} stall=${r.maxStallMs.toFixed(0).padStart(7)}ms `
    + `wall=${r.wallMs.toFixed(0).padStart(7)}ms net=${String(r.fetches).padStart(3)} `
    + `rows=${String(r.rowsWritten).padStart(5)} ${r.status}${r.detail ? ': ' + r.detail : ''}`);
}

console.log(JSON.stringify({
  db: process.env.GRIDIRON_DB_PATH,
  measuredAt: new Date().toISOString(),
  results,
}, null, 2));
