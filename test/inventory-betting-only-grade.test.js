/**
 * A `wired` count that includes betting-only reach overstates the fantasy product.
 *
 * `docs/inventory/CONTRACT.md` (§`wired-betting-only`, added on PR #99 at
 * `ea7a208`) defines the grade: reachable, and reachable ONLY through
 * `routes/nfl-market.js`, `routes/nfl-betting.js` or `routes/betting-hub.js`.
 * Betting is out of scope for this product, so such a row is genuinely served,
 * and served somewhere the product is not meant to be using. It is counted
 * separately and never inside the fantasy `wired` total.
 *
 * The contract's test is ALL paths, not the first one found. Its worked example
 * is both halves: `role-scenario-engine.js` reaches an entry point only through
 * `routes/nfl-market.js` and takes the grade; `player-week-engine.js` has a
 * betting path too but also reaches `routes/model.js` directly, so it stays
 * `wired`. One non-betting path is enough.
 *
 * TWO PSEUDO-ENTRY-POINTS THAT MAKE THIS SUBTLE, both measured on the real map:
 *
 *   1. `boot:server/index.js` appears in the `pages` bucket of 140+ modules.
 *      It is the app root, and it mounts every route — including the three
 *      betting ones — so it reaches every reachable module in the repository.
 *      Counting it as a non-betting entry point makes the grade unassignable:
 *      it silently graded 13 of the 19 real betting-only rows back to `wired`.
 *      It has to be excluded, and excluded by name, not by guessing at shapes.
 *
 *   2. Everything else in that bucket is real and DOES disqualify: `client:`
 *      (App.tsx, main.tsx), `extension:`, and the 63 `migration:` surfaces.
 *      Jobs disqualify too — `nfl-weather-response.js` reaches only betting
 *      route families and is still `wired`, because three scheduled jobs run it.
 *
 * These are the grade's two failure directions: too loose (boot counted, nothing
 * qualifies) and too tight (a job or a client reach ignored, a fantasy-reachable
 * module wrongly demoted out of the wired total).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, check, tally } from '../scripts/inventory.mjs';

const at = (name, hops = 2) => ({ name, hops });
const call = (wiring) => classify({
  modPath: 'server/services/x.js', wiring, findingsFor: [],
  tables: [], local: { readable: true, counts: new Map() },
});

test('reachable only through betting routes takes the betting-only grade', () => {
  const c = call({ route_families: [at('/api/nfl-market')], jobs: [], scripts: [], pages: [] });
  assert.equal(c.status, 'wired-betting-only',
    'this is the role-scenario-engine.js half of the contract\'s worked example');
  assert.match(c.evidence, /nfl-market/);
});

test('every betting family counts, and only those three', () => {
  for (const fam of ['/api/nfl-market', '/api/nfl-betting', '/api/betting']) {
    assert.equal(call({ route_families: [at(fam)], jobs: [], pages: [] }).status,
      'wired-betting-only', `${fam} is a betting surface`);
  }
  assert.equal(call({ route_families: [at('/api/model')], jobs: [], pages: [] }).status,
    'wired', '/api/model is the fantasy product');
});

test('one non-betting path is enough to stay wired', () => {
  const c = call({ route_families: [at('/api/nfl-betting'), at('/api/model', 1)], jobs: [], pages: [] });
  assert.equal(c.status, 'wired',
    'the player-week-engine.js half: a betting path AND routes/model.js directly. '
    + 'Grading on the first path found is exactly what the contract forbids.');
});

test('a scheduled job is a non-betting entry point', () => {
  const c = call({ route_families: [at('/api/betting'), at('/api/nfl-market')],
    jobs: [at('nfl_model_growth')], pages: [] });
  assert.equal(c.status, 'wired',
    'nfl-weather-response.js, measured: betting route families only, run by three '
    + 'jobs. A job reaches it without a betting route being involved at all.');
});

test('client and extension and migration reaches are non-betting entry points', () => {
  for (const p of ['client:client/src/App.tsx', 'extension:chrome-extension/popup.js',
    'migration:024_candidate_findings.js']) {
    assert.equal(call({ route_families: [at('/api/nfl-market')], jobs: [], pages: [at(p)] }).status,
      'wired', `${p} is a real entry point that is not a betting route`);
  }
});

test('the app root does not disqualify, because it reaches everything', () => {
  const c = call({ route_families: [at('/api/nfl-market')], jobs: [],
    pages: [at('boot:server/index.js', 1)] });
  assert.equal(c.status, 'wired-betting-only',
    'server/index.js mounts every route including the three betting ones, so it '
    + 'reaches every reachable module and distinguishes nothing. Counting it as a '
    + 'non-betting entry point graded 13 of the 19 real rows back to wired.');
});

test('no route reach at all is not betting-only', () => {
  const c = call({ route_families: [], jobs: [at('nfl_t60_runner')], pages: [] });
  assert.equal(c.status, 'wired',
    'the grade is about what serves the row. A job-only module is not served '
    + 'through a betting route; it is not served through a route at all.');
});

test('the grade is legal, and is not inside the fantasy wired total', () => {
  const rows = [
    { id: 'a', kind: 'pipeline', status: 'wired', evidence: 'e' },
    { id: 'b', kind: 'pipeline', status: 'wired-betting-only', evidence: 'e' },
    { id: 'c', kind: 'route', status: 'wired-betting-only', evidence: 'e' },
  ];
  assert.deepEqual(check(rows), [], 'the new status must pass the gate');
  const t = tally(rows);
  assert.equal(t.wired, 1, 'the whole point of the grade: betting-only reach must '
    + 'not be counted inside the number a reader takes for the fantasy product');
  assert.equal(t['wired-betting-only'], 2);
});

/*
 * Route FILES take the grade differently from modules. Asking what reaches
 * `nfl-market.js` is circular -- it is reached through `nfl-market.js` -- so the
 * route row qualifies by being one of the three, not by a reach test. Only a
 * route that would otherwise be `wired` moves: a betting route no page calls is
 * still `half_done`, because the grade refines reach and does not manufacture it.
 *
 * Asserted against the committed artifact rather than a synthetic wiring object,
 * because the route branch reads the map's own route/finding counts and a
 * hand-built stand-in for those would be asserting my own fixture. This is the
 * row a reader actually gets.
 */
import fs from 'node:fs';

const INVENTORY = JSON.parse(fs.readFileSync('docs/inventory/inventory.json', 'utf8'));
const row = (id) => INVENTORY.rows.find((r) => r.id === id);

test('the committed inventory grades the betting routes out of the fantasy total', () => {
  assert.equal(row('route:betting-hub').status, 'wired-betting-only',
    'betting-hub.js has a page caller, so it was counted as fantasy product');
  for (const id of ['route:nfl-market', 'route:nfl-betting']) {
    assert.equal(row(id).status, 'half_done',
      `${id} reaches no page; the grade refines reach and must not manufacture it`);
  }
});

test('the committed inventory carries the regraded modules and a separate count', () => {
  assert.equal(row('pipeline:trial-statistics').status, 'wired-betting-only');
  assert.equal(row('pipeline:nfl-weather-response').status, 'wired',
    'betting route families only, but three scheduled jobs run it');
  const t = tally(INVENTORY.rows);
  assert.ok(t['wired-betting-only'] > 0, 'the grade must appear in the artifact');
  assert.equal(t.wired + t['wired-betting-only'], 72,
    'the 72 rows previously counted as wired must all still be accounted for; '
    + 'this grade moves rows between buckets, it never drops one');
});

/*
 * TWO DEFECTS IN THE FIRST VERSION OF THIS RULE, both found by Opportunity
 * measuring the set rather than accepting the total. 52 of the sets agreed;
 * the 15 rows only I called betting-only were mostly mine being wrong.
 *
 *   1. A SCRIPT IN package.json IS AN ENTRY POINT. CONTRACT.md's `wired` test
 *      names "a route, a scheduled job, a script in package.json, or the
 *      client". The first version ignored the map's `scripts` bucket entirely,
 *      because `reachesLiveSurface()` ignores it -- correctly, since a script is
 *      not a live SURFACE. But the betting-only question is not "what surface
 *      serves this", it is "is every way in a betting route", and
 *      `npm run build:role-scenario-lab` is a way in. 12 rows measured wrong.
 *
 *   2. A BETTING PREFIX IS A PREFIX. `server/routes/wong.js` is mounted at
 *      `/api/betting/wong`, under the betting hub. Comparing family names for
 *      equality against the three prefixes makes a sub-path of a betting
 *      surface look like a fourth thing.
 *
 * A HAND-RUN SCRIPT STILL DOES NOT DISQUALIFY, and that is the same contract
 * speaking: "Record it as `reached from: hand-run script`, never as `wired`."
 * Nothing in the repository causes it to run. So the test is package.json
 * membership, not the existence of a script.
 */

test('a script named in package.json is a non-betting way in', () => {
  const c = classify({
    modPath: 'server/services/role-scenario-engine.js',
    wiring: { route_families: [at('/api/nfl-market')], jobs: [], pages: [],
      scripts: [at('scripts/build-role-scenario-lab.mjs', 2)] },
    findingsFor: [], tables: [], local: { readable: true, counts: new Map() },
    packageScripts: new Set(['scripts/build-role-scenario-lab.mjs']),
  });
  assert.equal(c.status, 'wired',
    'npm run build:role-scenario-lab reaches it without a betting route. '
    + 'CONTRACT.md\'s own worked example says this file takes the betting-only '
    + 'grade, and the example is wrong on its own rule.');
});

test('a hand-run script does not disqualify', () => {
  const c = classify({
    modPath: 'server/services/x.js',
    wiring: { route_families: [at('/api/nfl-market')], jobs: [], pages: [],
      scripts: [at('scripts/some-one-off.mjs', 2)] },
    findingsFor: [], tables: [], local: { readable: true, counts: new Map() },
    packageScripts: new Set(['scripts/build-role-scenario-lab.mjs']),
  });
  assert.equal(c.status, 'wired-betting-only',
    'nothing in the repository causes a hand-run script to run, and the '
    + 'contract says never to record that as wired');
});

test('a mount under a betting prefix is still betting', () => {
  // server/routes/wong.js is mounted at /api/betting/wong.
  const c = classify({
    modPath: 'server/services/y.js',
    wiring: { route_families: [at('/api/betting/wong')], jobs: [], pages: [], scripts: [] },
    findingsFor: [], tables: [], local: { readable: true, counts: new Map() },
  });
  assert.equal(c.status, 'wired-betting-only',
    'a sub-path of the betting hub is the betting hub; comparing prefixes for '
    + 'equality invents a fourth surface');
});

test('a near-miss prefix is not a betting surface', () => {
  const c = classify({
    modPath: 'server/services/z.js',
    wiring: { route_families: [at('/api/bettingsomething')], jobs: [], pages: [], scripts: [] },
    findingsFor: [], tables: [], local: { readable: true, counts: new Map() },
  });
  assert.equal(c.status, 'wired',
    'prefix matching must respect the path boundary, or /api/bettingsomething '
    + 'silently joins the betting family');
});
