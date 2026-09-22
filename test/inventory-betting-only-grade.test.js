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
