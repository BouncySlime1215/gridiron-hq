/**
 * A dynamic import inside a function body is a different edge from one at module
 * scope, and script reach must not walk it.
 *
 * Found empirically, not by inspection. The map said
 * `scripts/diagnose-passing-components.mjs` reaches
 * `server/services/model-governance.js` at 6 hops, through
 * `nfl-props.js -> nfl-pbp.js -> scheduler.js -> nfl-pick-watch.js`. Running the
 * script against a migrated copy of the database seeded nothing, while
 * `scripts/nfl-blind-audit.mjs` -- whose chain to the same module is entirely
 * static -- seeded 32 rows into `model_feature_contracts` and 11 into
 * `model_registry` from `model-governance.js:88-89`. The difference is
 * `scheduler.js:1002`, `await import('./nfl-pick-watch.js')` inside a job body:
 * importing the scheduler does not import pick-watch.
 *
 * The edge is REAL, so it is labelled, not deleted. What changes is which walk
 * follows it (Auditor R17: reach is of kinds and is never summed):
 *
 *   script reach   "running `npm run X` loads this module"  -> load edges only
 *   route reach    "this endpoint can execute this module"  -> a handler's own
 *                                                              dynamic import counts
 *   job reach      "this job body can execute this module"  -> same
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { build, moduleEdges, surfaceFamilies, CLOSE_HOPS } =
  await import('../scripts/wiring-map.mjs');

test('moduleEdges separates a function-body dynamic import from a module-scope one', () => {
  const { imports } = moduleEdges([
    "import { a } from './static.js';",
    "const top = await import('./module-scope.js');",
    'async function later() {',
    "  const { b } = await import('./in-a-function.js');",
    '  return b;',
    '}',
  ].join('\n'));
  const by = (spec) => imports.find((i) => i.spec === spec);
  assert.equal(by('./static.js').deferred, false, 'a static import always runs on load');
  assert.equal(by('./module-scope.js').deferred, false,
    'top-level await runs when the module is imported, so it is a load edge');
  assert.equal(by('./in-a-function.js').deferred, true,
    'this one runs only if the function is called');
});

const model = build();
const { reachNames } = model;
const GOV = 'server/services/model-governance.js';
const scriptsFor = (file) => surfaceFamilies(reachNames, [file], CLOSE_HOPS).scripts.map((s) => s.name);

test('a script does not reach through a job body', () => {
  // The measured case. Its only path to GOV crosses scheduler.js:1002.
  assert.ok(!scriptsFor(GOV).includes('scripts/diagnose-passing-components.mjs'),
    'running diagnose:nfl-passing seeds nothing; the map must not claim it reaches the seeder');
});

test('a script still reaches through a fully static chain', () => {
  // The control: nfl-blind-audit.js -> nfl-ensemble.js -> nfl-player-value.js
  // -> nfl-pregame.js -> model-governance.js, every edge a plain import. This
  // run really does write the 43 seed rows.
  assert.ok(scriptsFor(GOV).includes('scripts/nfl-blind-audit.mjs'),
    'audit:nfl demonstrably seeds model_feature_contracts and model_registry');
});

test('a route handler keeps the reach its own dynamic import gives it', () => {
  // betting-hub.js:598/:606/:614 import nfl-pick-watch.js inside handlers. That
  // is request reach: hitting the endpoint executes the module.
  const w = surfaceFamilies(reachNames, ['server/services/nfl-pick-watch.js'], CLOSE_HOPS);
  assert.ok(w.route_families.some((r) => r.name === '/api/betting'),
    `pick-watch lost its route reach: ${JSON.stringify(w.route_families)}`);
});

test('a job keeps the reach its own dynamic import gives it', () => {
  const w = surfaceFamilies(reachNames, ['server/services/nfl-pick-watch.js'], CLOSE_HOPS);
  assert.ok(w.jobs.some((j) => j.name === 'nfl_pick_watch'),
    `pick-watch lost its job reach: ${JSON.stringify(w.jobs)}`);
});

test('dropping deferred edges from script reach does not empty the bucket', () => {
  let withScripts = 0;
  for (const f of model.files.values()) {
    if (f.tree === 'test') continue;
    if (scriptsFor(f.path).length) withScripts++;
  }
  assert.ok(withScripts > 200,
    `only ${withScripts} modules keep a script reach; the walk is over-pruned`);
});
