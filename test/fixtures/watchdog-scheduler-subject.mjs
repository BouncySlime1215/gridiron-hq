/**
 * Child process for test/watchdog-job-marker.test.js. It runs synthetic jobs
 * through the REAL scheduler path (runIfStale -> runJobNow -> withJobTimeout,
 * or runJobOffThread) under the REAL watchdog at a 1s threshold, then lets the
 * watchdog SIGKILL it. argv[2] names the scenario.
 *
 * The kill-line tests in loop-watchdog.test.js mark jobs by hand, so they show
 * that the watchdog PRINTS what it is told. This shows that the scheduler TELLS
 * it the truth: which jobs' own code is still running on this thread when the
 * loop stops, including a job whose budget has already given up on it.
 *
 * Progress goes out through writeSync, not console.log. The process is killed
 * in the middle of a block, and a line queued behind the block would die with
 * it.
 */
import { writeSync } from 'node:fs';
import { startLoopWatchdog, armLoopWatchdog } from '../../server/platform/loop-watchdog.js';
import { JOBS, runIfStale, lastRun } from '../../server/services/scheduler.js';

const scenario = process.argv[2];
const say = line => writeSync(1, `${line}\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Holds the thread the way a synchronous SQLite call does. Eight seconds is
// far past the 1s threshold, so a live watchdog always fires before it ends.
const HOLD_MS = 8000;
const block = () => {
  const until = Date.now() + HOLD_MS;
  let n = 0;
  while (Date.now() < until) n += Math.sqrt(n + 1);
  return n;
};
// A live-tier job with no offThread flag runs inline (see resolveOffThread).
const INLINE = { maxAgeMinutes: 1, tier: 'live', label: 'synthetic watchdog-marker job' };

startLoopWatchdog({ thresholdMs: 1000 });
armLoopWatchdog();
// A server's listening socket keeps its event loop alive. This child has no
// socket, and the watchdog, its heartbeat and the budget's timer are all
// unref'd, so without a handle of its own it would exit in the middle of a
// scenario with an unsettled top-level await (exit 13).
setInterval(() => {}, 1000);
// Let the heartbeat and the watching thread start before anything blocks.
await sleep(300);

// The abandoned job waits on this, and the scenario releases it only after the
// tier has moved past it. So "abandoned, then it blocks" happens in that order
// by construction, not by racing timers.
let releaseCulprit;
const tierMovedOn = new Promise(resolve => { releaseCulprit = resolve; });
// A 200ms budget that the job's own code outlives, as withJobTimeout allows: it
// can stop waiting for a job, but it cannot stop the job.
const CULPRIT = { ...INLINE, timeoutMs: 200, run: async () => { await tierMovedOn; block(); return {}; } };

const scenarios = {
  // An inline job returns, then the thread blocks outside any job.
  async 'returned-then-block'() {
    JOBS.synthetic_returned = { ...INLINE, run: async () => ({ ok: true }) };
    say(`returned: ${JSON.stringify(await runIfStale('synthetic_returned', { force: true }))}`);
    block();
  },
  // The same for a job that threw. It is exactly as finished as one that returned.
  async 'threw-then-block'() {
    JOBS.synthetic_threw = { ...INLINE, run: async () => { throw new Error('synthetic failure'); } };
    say(`threw: ${JSON.stringify(await runIfStale('synthetic_threw', { force: true }))}`);
    block();
  },
  // The job itself blocks the thread after an await.
  async 'blocks-after-await'() {
    JOBS.synthetic_blocks = { ...INLINE, run: async () => { await sleep(20); block(); return {}; } };
    await runIfStale('synthetic_blocks', { force: true });
  },
  // The job blocks the moment it is called, before it awaits anything. A marker
  // set after the job starts would never be set at all.
  async 'blocks-at-once'() {
    JOBS.synthetic_blocks = { ...INLINE, run: () => { block(); return {}; } };
    await runIfStale('synthetic_blocks', { force: true });
  },
  // The budget abandons a job. The tier runs the next job to completion. Then
  // the abandoned job's own code blocks the thread.
  async 'abandoned-then-next-returned'() {
    JOBS.synthetic_culprit = CULPRIT;
    JOBS.synthetic_next = { ...INLINE, run: async () => ({ ok: true }) };
    say(`culprit: ${JSON.stringify(await runIfStale('synthetic_culprit', { force: true }))}`);
    say(`next: ${JSON.stringify(await runIfStale('synthetic_next', { force: true }))}`);
    releaseCulprit();
  },
  // The budget abandons a job, and the tier moves on to a job that is still
  // awaiting I/O when the abandoned job's code blocks the thread.
  async 'abandoned-while-next-awaits'() {
    JOBS.synthetic_culprit = CULPRIT;
    JOBS.synthetic_bystander = { ...INLINE, run: async () => { releaseCulprit(); await sleep(60_000); return {}; } };
    say(`culprit: ${JSON.stringify(await runIfStale('synthetic_culprit', { force: true }))}`);
    await runIfStale('synthetic_bystander', { force: true });
  },
  // The budget abandons a job, and the same job starts again. runIfStale's
  // in-flight guard lets it, because that guard ends when the budget gives up.
  // The second copy returns. Then the first copy blocks the thread.
  async 'abandoned-then-rerun'() {
    let calls = 0;
    JOBS.synthetic_culprit = { ...CULPRIT, run: async () => {
      calls += 1;
      if (calls === 1) { await tierMovedOn; block(); }
      return { call: calls };
    } };
    say(`first: ${JSON.stringify(await runIfStale('synthetic_culprit', { force: true }))}`);
    say(`second: ${JSON.stringify(await runIfStale('synthetic_culprit', { force: true }))}`);
    releaseCulprit();
  },
  // An off-thread job is in flight in its worker while something else blocks
  // this thread. It has no `run`, so if it were ever run inline it would fail
  // at once and the status line below would say 'error', not 'running'.
  async 'off-thread-while-main-blocks'() {
    JOBS.synthetic_worker = { ...INLINE, offThread: true,
      worker: { module: new URL('./watchdog-worker-sleep.mjs', import.meta.url).href, fn: 'sleepFor', args: [20_000] } };
    runIfStale('synthetic_worker', { force: true })
      .then(r => say(`worker job settled early: ${JSON.stringify(r)}`));
    await sleep(500);
    say(`worker job status: ${lastRun('synthetic_worker')?.last_status}`);
    block();
  }
};

if (!scenarios[scenario]) throw new Error(`unknown scenario '${scenario}'`);
await scenarios[scenario]();
await sleep(HOLD_MS + 4000);
say('survived');
process.exit(0);
