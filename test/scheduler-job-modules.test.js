/**
 * 53 of 62 scheduler jobs said "implementing module unresolved by the map".
 *
 * That sentence was wrong, not merely incomplete. `schedulerJobs` filled
 * `runModule` only from a dynamic `import('…')` written INSIDE the job's own
 * entry in the JOBS object, and no job in this repository is written that way
 * — the count of that form is zero. Every other job fell through to null, and
 * the inventory printed "unresolved" for it.
 *
 * What is actually there, at `server/services/scheduler.js:1165`:
 *
 *   async function refreshEspnDepthChart() {
 *     const { syncDepthChart } = await import('../routes/nfldata.js');
 *     return syncDepthChart();
 *   }
 *   …
 *   espn_depth_chart: { run: refreshEspnDepthChart, … }
 *
 * The job names a function defined in the scheduler, and THAT function holds
 * the dynamic import naming the real implementing module. The map was looking
 * one level too shallow and then reporting its own blind spot as a property of
 * the code — the same shape as `imported-by-nothing` being read as "unused".
 *
 * Three resolution routes, in order of precedence, each a test below: an
 * import inside the job entry, a statically imported run function, and a
 * locally defined run function whose body imports. A run function this file
 * defines and that imports nothing resolves to the scheduler itself, which is
 * a real answer; only a name that matches nothing at all stays null.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { scan, moduleEdges, schedulerJobs } = await import('../scripts/wiring-map.mjs');

const SCHED = 'server/services/scheduler.js';
// The `text` view, not `code`: scan() blanks string BODIES out of the code
// view, which would erase the very specifier this resolver reads. That is how
// build() calls it at the one production site, and a test that fed it `code`
// would be testing a call nobody makes.
const build = (src) => {
  const { text } = scan(src);
  return schedulerJobs(text, SCHED, moduleEdges(text).imports);
};
const job = (jobs, name) => jobs.find((j) => j.name === name);

test('a run function defined in the scheduler resolves through its own import', () => {
  const jobs = build(`
    async function refreshDepth() {
      const { syncDepthChart } = await import('../routes/nfldata.js');
      return syncDepthChart();
    }
    export const JOBS = {
      espn_depth_chart: { run: refreshDepth, tier: 'growth', label: 'depth charts' },
    };
  `);
  const j = job(jobs, 'espn_depth_chart');
  assert.equal(j.runModule, 'server/routes/nfldata.js');
  assert.equal(j.runVia, 'local-function');
  assert.equal(j.runFn, 'refreshDepth');
});

test('a statically imported run function resolves to the module it came from', () => {
  const jobs = build(`
    import { refreshLines } from './odds-api.js';
    export const JOBS = { nfl_lines: { run: refreshLines, tier: 'live', label: 'lines' } };
  `);
  const j = job(jobs, 'nfl_lines');
  assert.equal(j.runModule, 'server/services/odds-api.js');
  assert.equal(j.runVia, 'static-import');
});

test('an aliased import resolves under the LOCAL name, which is what run: writes', () => {
  const jobs = build(`
    import { syncAll as syncNflverse } from './nflverse.js';
    export const JOBS = { nflverse: { run: syncNflverse, tier: 'growth', label: 'nflverse' } };
  `);
  assert.equal(job(jobs, 'nflverse').runModule, 'server/services/nflverse.js');
});

test('an import written inside the job entry still wins', () => {
  // The form schedulerJobs already supported. It takes precedence because it
  // is the most specific statement of what the job runs.
  const jobs = build(`
    async function refreshBoth() {
      const { other } = await import('./nflverse.js');
      return other();
    }
    export const JOBS = {
      direct: { run: () => import('./odds-api.js').then(m => m.go()), tier: 'live', label: 'direct' },
    };
  `);
  const j = job(jobs, 'direct');
  assert.equal(j.runModule, 'server/services/odds-api.js');
  assert.equal(j.runVia, 'inline-import');
});

test('a local run function that imports nothing resolves to the scheduler itself', () => {
  // Not "unresolved". The work is done here, and saying so is a real answer.
  const jobs = build(`
    async function pruneRows() { return 1; }
    export const JOBS = { prune: { run: pruneRows, tier: 'live', label: 'prune' } };
  `);
  const j = job(jobs, 'prune');
  assert.equal(j.runModule, SCHED);
  assert.equal(j.runVia, 'local-body');
});

test('a run name that matches nothing stays null rather than guessing', () => {
  const jobs = build(`
    export const JOBS = { mystery: { run: whoKnows, tier: 'live', label: 'mystery' } };
  `);
  const j = job(jobs, 'mystery');
  assert.equal(j.runModule, null);
  assert.equal(j.runVia, null);
});

test('the first import in a run function is the one taken, and it is named', () => {
  // A run function whose body imports two different modules is resolved to the
  // first, and runImports carries both so the row can say so rather than
  // implying there is only one. (The example this was written from was
  // refreshMlbLogs, which destructured two names from one module; MLB was
  // removed from the product on 2026-09-22 and the fixture names a module that
  // still exists, because resolution returns null for one that does not.)
  const jobs = build(`
    async function refreshTwo() {
      const { a } = await import('./odds-api.js');
      const { b } = await import('./nflverse.js');
      return a() + b();
    }
    export const JOBS = { two: { run: refreshTwo, tier: 'heavy', label: 'two' } };
  `);
  const j = job(jobs, 'two');
  assert.equal(j.runModule, 'server/services/odds-api.js');
  assert.deepEqual(j.runImports, ['server/services/odds-api.js', 'server/services/nflverse.js']);
});

test('a brace inside a string does not swallow the run function body', () => {
  // server/services/scheduler.js:1471 manager_archetypes was the one job that
  // resolved to nothing, and the cause was not the job. bodyRange counts braces
  // on whatever view it is handed, and the production call hands it the `text`
  // view, where string bodies are intact. refreshManagerArchetypes contains
  // `stdout.indexOf('{')`, so the count never returned to zero, the range ran
  // past the end of the file and came back null. The resolver blanks strings
  // for the structural pass and keeps the intact view for the specifier.
  const jobs = build(`
    async function refreshBraced() {
      const { syncDepthChart } = await import('../routes/nfldata.js');
      const report = JSON.parse(stdout.slice(stdout.indexOf('{')));
      return syncDepthChart(report);
    }
    export const JOBS = { braced: { run: refreshBraced, tier: 'heavy', label: 'braced' } };
  `);
  const j = job(jobs, 'braced');
  assert.equal(j.runModule, 'server/routes/nfldata.js');
  assert.equal(j.runVia, 'local-function');
});

test('a job that spawns a script resolves to the script, not to a path helper', () => {
  // manager_archetypes imports node:child_process, node:util, node:path and
  // ../platform/paths.js, then execFiles scripts/build-manager-archetypes.mjs.
  // paths.js is path arithmetic; the script is the work. Reporting the helper
  // would be a wrong answer wearing the shape of a right one.
  const jobs = build(`
    async function refreshArchetypes() {
      const { execFile } = await import('node:child_process');
      const { PROJECT_ROOT } = await import('../platform/paths.js');
      const script = path.join(PROJECT_ROOT, 'scripts/build-manager-archetypes.mjs');
      return promisify(execFile)(process.execPath, [script, '--json']);
    }
    export const JOBS = { arch: { run: refreshArchetypes, tier: 'heavy', label: 'arch' } };
  `);
  const j = job(jobs, 'arch');
  assert.equal(j.runModule, 'scripts/build-manager-archetypes.mjs');
  assert.equal(j.runVia, 'spawned-script');
});

test('a job that hands work to a worker thread resolves to the module the worker loads', () => {
  // manager_signals was the last job reporting "the work is done in the
  // scheduler". It is not: refreshManagerSignalsOffThread starts
  // ./report-worker.js and passes workerData { module: './manager-signals.js',
  // fn: 'refreshManagerData' }. report-worker.js is a dispatcher — naming it,
  // or naming the scheduler, tells a reader nothing about what runs.
  //
  // The spec is resolved relative to the WORKER, not to the scheduler, because
  // that is where report-worker.js resolves it. Here both sit in the same
  // directory, so the two readings agree and the test cannot tell them apart;
  // it is written the correct way round on purpose rather than on the
  // coincidence.
  const jobs = build(`
    export function refreshSignalsOffThread() {
      return new Promise((resolve) => {
        const worker = new Worker(new URL('./report-worker.js', import.meta.url), {
          workerData: { module: './manager-signals.js', fn: 'refreshManagerData', args: [] },
        });
        worker.on('message', resolve);
      });
    }
    export const JOBS = { manager_signals: { run: refreshSignalsOffThread, tier: 'heavy', label: 'signals' } };
  `);
  const j = job(jobs, 'manager_signals');
  assert.equal(j.runModule, 'server/services/manager-signals.js');
  assert.equal(j.runVia, 'worker-thread');
  assert.deepEqual(j.runImports, ['server/services/manager-signals.js', 'server/services/report-worker.js']);
});

test('a run function that only wraps another local function is followed', () => {
  // The real manager_signals entry runs refreshManagerSignals, whose body
  // holds no import, no spawn and no Worker — it awaits
  // refreshManagerSignalsOffThread() and then shapes the result for a
  // sync_log row. Stopping at the first body would report the scheduler and
  // call that an answer.
  //
  // One local call is followed; two would be a guess about which one is the
  // work, so the hop stops and the row says the scheduler.
  const jobs = build(`
    export function offThread() {
      const worker = new Worker(new URL('./report-worker.js', import.meta.url), {
        workerData: { module: './manager-signals.js', fn: 'refreshManagerData' },
      });
      return worker;
    }
    async function refreshSignals() {
      const out = await offThread();
      return { leagues: out?.leagues ?? [] };
    }
    export const JOBS = { manager_signals: { run: refreshSignals, tier: 'growth', label: 'signals' } };
  `);
  const j = job(jobs, 'manager_signals');
  assert.equal(j.runModule, 'server/services/manager-signals.js');
  assert.equal(j.runVia, 'worker-thread');
  assert.deepEqual(j.runHops, ['refreshSignals', 'offThread']);
});

test('two local calls stop the hop rather than picking one', () => {
  const jobs = build(`
    async function partOne() { await import('./mlb.js'); }
    async function partTwo() { await import('./nflverse.js'); }
    async function refreshBoth() { await partOne(); await partTwo(); }
    export const JOBS = { both: { run: refreshBoth, tier: 'heavy', label: 'both' } };
  `);
  const j = job(jobs, 'both');
  assert.equal(j.runVia, 'local-body');
  assert.equal(j.runModule, 'server/services/scheduler.js');
});

test('every job in the real scheduler resolves to something', async () => {
  const src = await readFile(new URL(`../${SCHED}`, import.meta.url), 'utf8');
  const jobs = build(src);
  const unresolved = jobs.filter((j) => !j.runModule).map((j) => j.name);
  assert.equal(unresolved.length, 0, `unresolved: ${unresolved.join(', ')}`);
  // 58 since MLB was removed from the product on 2026-09-22, which took five
  // jobs (mlb_schedule, mlb_logs, mlb_boxscores, mlb_probables,
  // mlb_tomorrow_picks) out of a registry of 63. The bound is a floor against
  // the scan silently finding fewer than are there, not a target.
  assert.ok(jobs.length >= 58, `expected the full registry, got ${jobs.length}`);
  assert.equal(job(jobs, 'espn_depth_chart').runModule, 'server/routes/nfldata.js');
  assert.equal(job(jobs, 'manager_archetypes').runModule, 'scripts/build-manager-archetypes.mjs');
  assert.equal(job(jobs, 'manager_signals').runModule, 'server/services/manager-signals.js');
  // Nothing should still be answering "the work is done in the scheduler":
  // every such job examined turned out to hand off somewhere.
  assert.deepEqual(jobs.filter((j) => j.runVia === 'local-body').map((j) => j.name), []);
});
