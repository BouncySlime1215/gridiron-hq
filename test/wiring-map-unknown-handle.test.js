/**
 * TWO PLACES THE MAP ANSWERED A QUESTION IT HAD NOT ASKED.
 *
 * Both landed main red the day the gate arrived, and both are the shape this
 * branch keeps finding: an unknown resolved to a confident default.
 *
 * 1. A DATABASE HANDLE PASSED IN AS A PARAMETER.
 *    `td-features.js` is handed both handles by its caller —
 *    `buildTdFeatures({ appDb, nflDb, seasons })` — and queries the nflverse
 *    one as `nflDb.prepare(...)`. The file opens no handle of its own, so it is
 *    not a foreign-only file, and `handleFor` fell through to 'app'. That is
 *    defensible for a bare `run(...)` with no receiver, which is the case its
 *    comment is about; it is not defensible for an EXPLICIT receiver the
 *    resolver simply does not recognise. The map has a rule for exactly this
 *    case — table-in-another-database, which is context and does not gate — and
 *    the wrong default is what stopped it applying, so two nflverse tables were
 *    reported as read by a live surface and written by nothing.
 *
 *    An unrecognised receiver is UNKNOWN, and unknown is not 'app'. Measured
 *    across the whole repository before this was written: 24 query sites use an
 *    explicit non-`db` receiver and are attributed to the app, and naming them
 *    honestly moves exactly two tables — the two that were wrong. `appDb`,
 *    `app` and `rdb` sites change nothing, because every table they touch is
 *    also read through the app's own handle somewhere else, which is what the
 *    every() in the foreign-only rule is for.
 *
 * 2. A FUNCTION A JOB REGISTRY CALLS.
 *    `producer-with-no-caller` counts syntactic calls, `name(`. A scheduler job
 *    is registered as `run: refreshLeagueRosters` and invoked by the runner as
 *    `job.run()`, so the name is never followed by a paren anywhere and the
 *    producer read as uncalled. It was not, before: #95 moved that work off the
 *    request thread and removed the direct call, and a real product change
 *    turned a rule that had always been incomplete into a red build.
 *
 *    A registration is a call. The rule counts it as one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { handleFor, callSites } = await import('../scripts/wiring-map.mjs');

const fileWith = (text, foreignOnly = false) => ({ text, foreignOnlyFile: foreignOnly });
const at = (text, needle) => text.indexOf(needle) + needle.length;

test('an unrecognised receiver is named, not claimed as the app', () => {
  const text = 'const plays = nflDb.prepare(`SELECT 1`)';
  const got = handleFor(fileWith(text), at(text, 'nflDb.prepare('), new Map());
  assert.equal(got.handle, 'nflDb');
  assert.notEqual(got.handle, 'app');
});

test('a receiver the file actually opened still resolves to that handle', () => {
  const text = 'const rows = hist.prepare(`SELECT 1`)';
  const foreign = new Map([['hist', 'league-history.sqlite']]);
  const got = handleFor(fileWith(text), at(text, 'hist.prepare('), foreign);
  assert.equal(got.handle, 'hist');
  assert.equal(got.where, 'league-history.sqlite');
});

test("a plain db receiver is still the app's", () => {
  const text = 'const r = db.prepare(`SELECT 1`)';
  assert.equal(handleFor(fileWith(text), at(text, 'db.prepare('), new Map()).handle, 'app');
});

test('a bare helper call with no receiver is still the app, which is what the default is for', () => {
  const text = 'const r = run(`INSERT INTO t VALUES (1)`)';
  assert.equal(handleFor(fileWith(text), at(text, 'run('), new Map()).handle, 'app');
});

test('a registration counts as a call', () => {
  assert.equal(callSites('league_rosters: { run: refreshLeagueRosters, maxAgeMinutes: 60 }',
    'refreshLeagueRosters'), 1);
});

test('an ordinary call still counts', () => {
  assert.equal(callSites('await refreshLeagueRosters()', 'refreshLeagueRosters'), 1);
});

test('a name that merely appears in prose does not count', () => {
  assert.equal(callSites('refreshLeagueRosters is the job that does it', 'refreshLeagueRosters'), 0);
});

test('a longer name sharing a prefix is not counted', () => {
  assert.equal(callSites('run: refreshLeagueRostersLater', 'refreshLeagueRosters'), 0);
});
