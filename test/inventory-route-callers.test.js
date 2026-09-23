/**
 * A route file whose only caller is a script is not "wired".
 *
 * The inventory decided a route file's status from one subtraction: routes
 * registered, minus routes carrying a `route-no-caller` finding, and anything
 * left over counted as "with callers". That treats the absence of a finding as
 * evidence of a consumer, and it is not. The wiring map has a second rule,
 * `route-called-from-outside-the-app`, for a route that no page calls but a
 * script in this repository dials over HTTP — and a route in that state is
 * reported by that rule INSTEAD of the no-caller rule, not as well as it.
 *
 * So three route files came out `wired` on the strength of callers that were
 * all scripts: nfl-betting (170 routes, 168 no-caller, 2 outbound), stats (3,
 * 2, 1) and tradelab (5, 4, 1). Every one accounted for, no residue. The model
 * audit thread reported the same three as half_done from the other direction —
 * "no file under client/src requests this prefix at all" — which is true at the
 * same time, because they were counting pages and this was counting callers of
 * any kind.
 *
 * Neither reading was wrong. Collapsing them was. A route a script syncs and a
 * route a page renders are not the same kind of alive, and an inventory whose
 * whole purpose is to say what is really wired cannot spend that distinction
 * one rule after the map took the trouble to draw it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { buildRows } = await import('../scripts/inventory.mjs');

// The smallest map that reproduces stats.js: three routes, two nobody calls,
// one a script dials. Shaped like the real thing — the outbound rule is
// `kind: 'context'` and carries its explanation in `detail`, the no-caller rule
// is `kind: 'orphan'` — because the generator reads those fields.
const mapWith = (findings) => ({
  generated_at: '2026-09-22T00:00:00Z',
  modules: [],
  tables: [],
  surfaces: [
    { kind: 'route', name: 'POST /api/stats/sync', file: 'server/routes/stats.js', line: 77 },
    { kind: 'route', name: 'GET /api/stats/projections', file: 'server/routes/stats.js', line: 135 },
    { kind: 'route', name: 'GET /api/stats/teams', file: 'server/routes/stats.js', line: 164 },
  ],
  findings,
});

const NO_CALLER = [
  { kind: 'orphan', rule: 'route-no-caller', subject: 'GET /api/stats/projections',
    detail: 'no page or extension calls it', weight: 24, evidence: ['server/routes/stats.js:135'] },
  { kind: 'orphan', rule: 'route-no-caller', subject: 'GET /api/stats/teams',
    detail: 'no page or extension calls it', weight: 24, evidence: ['server/routes/stats.js:164'] },
];
const OUTBOUND = {
  kind: 'context', rule: 'route-called-from-outside-the-app', subject: 'POST /api/stats/sync',
  detail: 'no page calls it; a script in this repository dials it over HTTP', weight: 0,
  evidence: ['server/routes/stats.js:77'],
};
const LOCAL = { readable: false, dbPath: '/nonexistent', tables: 0, nonEmpty: 0, counts: new Map() };

const statsRow = (findings) =>
  buildRows(mapWith(findings), LOCAL).find((r) => r.id === 'route:stats');

test('a route file whose only caller is a script is not wired', () => {
  const row = statsRow([...NO_CALLER, OUTBOUND]);
  assert.notEqual(row.status, 'wired', 'a script dialling the server is not a page using the feature');
  assert.equal(row.status, 'half_done');
  // The reason has to name the consumer. "2 of 3 with callers" is the sentence
  // that hid this for as long as it was there.
  assert.match(`${row.evidence ?? ''}${row.reason ?? ''}`, /script/i);
});

test('a route file with a real page caller is still wired', () => {
  // Same file, same two dead routes, but the third has no finding at all —
  // which in the real map means a page calls it. The fix must not turn every
  // route file half_done by simply deleting the wired branch.
  const row = statsRow(NO_CALLER);
  assert.equal(row.status, 'wired');
});

test('a page caller and a script caller in the same file still reads wired', () => {
  // The mixed case, and the one an over-correction loses: flipping any file
  // that has a script caller to half_done passed every other test here, and
  // would have downgraded aggregates.js, which two pages really do call.
  const row = statsRow([NO_CALLER[0], OUTBOUND]);
  assert.equal(row.status, 'wired');
  assert.match(row.evidence, /1 called by a page and 1 dialled only by a script/);
});

test('a route file where nothing at all calls any route stays half_done', () => {
  const row = statsRow([...NO_CALLER, { ...OUTBOUND, rule: 'route-no-caller', kind: 'orphan',
    detail: 'no page or extension calls it' }]);
  assert.equal(row.status, 'half_done');
  assert.match(`${row.evidence ?? ''}${row.reason ?? ''}`, /nothing calls them/);
});
