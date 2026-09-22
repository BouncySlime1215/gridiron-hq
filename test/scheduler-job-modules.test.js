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
const build = (src) => {
  const { code, text } = scan(src);
  return schedulerJobs(code, SCHED, moduleEdges(text).imports);
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
    import { refreshLines } from './nfl-lines.js';
    export const JOBS = { nfl_lines: { run: refreshLines, tier: 'live', label: 'lines' } };
  `);
  const j = job(jobs, 'nfl_lines');
  assert.equal(j.runModule, 'server/services/nfl-lines.js');
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
      const { other } = await import('./other.js');
      return other();
    }
    export const JOBS = {
      direct: { run: () => import('./direct.js').then(m => m.go()), tier: 'live', label: 'direct' },
    };
  `);
  const j = job(jobs, 'direct');
  assert.equal(j.runModule, 'server/services/direct.js');
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
  // refreshMlbLogs destructures two names from one module; a body with two
  // different modules is resolved to the first, and runImports carries both so
  // the row can say so rather than implying there is only one.
  const jobs = build(`
    async function refreshTwo() {
      const { a } = await import('./first.js');
      const { b } = await import('./second.js');
      return a() + b();
    }
    export const JOBS = { two: { run: refreshTwo, tier: 'heavy', label: 'two' } };
  `);
  const j = job(jobs, 'two');
  assert.equal(j.runModule, 'server/services/first.js');
  assert.deepEqual(j.runImports, ['server/services/first.js', 'server/services/second.js']);
});

test('every job in the real scheduler resolves to something', async () => {
  const src = await readFile(new URL(`../${SCHED}`, import.meta.url), 'utf8');
  const jobs = build(src);
  const unresolved = jobs.filter((j) => !j.runModule).map((j) => j.name);
  assert.equal(unresolved.length, 0, `unresolved: ${unresolved.join(', ')}`);
  assert.ok(jobs.length >= 60, `expected the full registry, got ${jobs.length}`);
  assert.equal(job(jobs, 'espn_depth_chart').runModule, 'server/routes/nfldata.js');
});
