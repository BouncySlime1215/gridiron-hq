/**
 * MLB is gone from the product (2026-09-22).
 *
 * Nick: "get rid of MLB btw". The census in
 * docs/tdd/2026-09-22-remove-mlb-preregistration.md established what that
 * reaches: 28 endpoints under /api/mlb, 8 services, 5 scheduled jobs, and no
 * user-facing surface at all -- no nav tab, no page, and not one fetch to
 * /api/mlb anywhere in client/src.
 *
 * These tests pin three things, and the third is the one worth having.
 *
 * ONE. The jobs and the router had to come out together, and a later change
 * must not be able to put half of it back. `runIfStale` on a name that is not
 * in JOBS returns `{ job, error: 'unknown job' }` -- it does not throw -- and
 * `refreshInBackground` is called fire-and-forget from two route handlers that
 * never read the result. So a job removed while a caller survives is a route
 * answering from a feed that has silently stopped, which is the exact shape
 * CLAUDE.md forbids. The test for that is not "no mlb jobs"; it is that every
 * name `refreshInBackground` can default to is a job that exists.
 *
 * TWO. The eleven mlb_* tables and every row in them STAY. Removing the code
 * that reads and writes a table is reversible; dropping the table is not, and
 * it needs Nick's own word separately. This suite asserts the tables are still
 * declared, so "no data deletion" is a test rather than a sentence in a PR.
 *
 * THREE. `MLB` is also Middle Linebacker. `client/src/components/FormationView.tsx`
 * puts it beside `LILB` in the defensive formation row, and a grep-and-delete
 * would have torn a hole in the formation diagram. That file is pinned here so
 * a future sweep for the string does not finish the job this one declined to do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JOBS, MAIN_THREAD_ONLY, ON_REQUEST_THREAD, BOOT_JOBS }
  from '../server/services/scheduler.js';
import { scan, moduleEdges } from '../scripts/wiring-map.mjs';

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('no MLB job is left in the registry or in either thread list', () => {
  const jobs = Object.keys(JOBS).filter(name => /^mlb_/.test(name));
  assert.deepEqual(jobs, [],
    'these MLB jobs are still scheduled. They fetch statsapi.mlb.com on a timer for a '
    + 'product that no longer exists');
  for (const list of [['ON_REQUEST_THREAD', ON_REQUEST_THREAD], ['MAIN_THREAD_ONLY', MAIN_THREAD_ONLY]]) {
    const [label, map] = list;
    assert.deepEqual([...map.keys()].filter(n => /^mlb_/.test(n)), [],
      `${label} still names MLB jobs. An excuse for a job that no longer exists is a `
      + 'stale sentence that reads as a current decision');
  }
  assert.deepEqual(BOOT_JOBS.filter(n => /^mlb_/.test(n)), [],
    'the boot catch-up pass still runs MLB jobs');
});

test('every job the boot pass and the background refresh name actually exists', () => {
  // The structural guard, and the reason this is not simply "no mlb_ keys".
  // runIfStale returns { error: 'unknown job' } rather than throwing, and
  // refreshInBackground's two callers never read the result, so a name that
  // outlived its job fails completely silently.
  for (const name of BOOT_JOBS) {
    assert.ok(JOBS[name], `BOOT_JOBS names '${name}', which is not a job. runIfStale will `
      + "return { error: 'unknown job' } and nothing reads it, so the boot pass would skip "
      + 'it in silence');
  }
  const src = read('server/services/scheduler.js');
  const defaulted = /refreshInBackground\(jobs = \[([^\]]*)\]\)/.exec(src);
  assert.ok(defaulted, 'refreshInBackground no longer has the shape this test reads');
  for (const name of defaulted[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean)) {
    assert.ok(JOBS[name], `refreshInBackground defaults to '${name}', which is not a job. `
      + 'It is called fire-and-forget from route handlers that never read the result');
  }
});

test('/api/mlb is not mounted and nothing imports an MLB service', () => {
  const index = read('server/index.js');
  assert.ok(!/routes\/mlb\.js/.test(index), 'server/index.js still imports the MLB router');
  assert.ok(!/['"]\/api\/mlb['"]/.test(index), 'server/index.js still mounts /api/mlb');

  const dirs = ['server/routes', 'server/services', 'scripts'];
  const offenders = [];
  for (const dir of dirs) {
    const base = new URL(`../${dir}/`, import.meta.url);
    for (const entry of fs.readdirSync(base)) {
      if (!/\.(js|mjs)$/.test(entry)) continue;
      const text = fs.readFileSync(new URL(entry, base), 'utf8');
      // The schema file keeps the eleven tables and is deliberately untouched.
      if (/mlb-model-misc/.test(entry)) continue;
      if (/from '\.\.?\/[^']*mlb[^']*\.js'|import\('\.\.?\/[^']*mlb[^']*\.js'\)/.test(text)) {
        offenders.push(path.join(dir, entry));
      }
    }
  }
  assert.deepEqual(offenders, [],
    'these files still import a deleted MLB service, which is a module that will not resolve');
});

test('the eleven mlb_ tables and their rows stay', () => {
  // The no-data-deletion promise, as a test rather than a sentence in a PR
  // body. Dropping a table is irreversible on the live volume and needs Nick's
  // own word; this unit removes readers and writers only.
  const schema = read('server/db/schema/mlb-model-misc.js');
  for (const table of ['mlb_batter_games', 'mlb_boxscore_sync', 'mlb_first_party_picks',
    'mlb_games', 'mlb_market_quotes', 'mlb_model_experiments', 'mlb_pick_decisions',
    'mlb_pitcher_games', 'mlb_pregame_snapshots', 'mlb_probability_calibrations',
    'mlb_probable_starters']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`),
      `${table} is no longer declared. The code that reads and writes an MLB table is what `
      + 'this unit removes; the table and its rows are not ours to drop');
  }
  const files = fs.readdirSync(new URL('../server/migrations/', import.meta.url), { withFileTypes: true })
    .filter(d => d.isFile()).map(d => d.name);
  for (const name of files) {
    const text = fs.readFileSync(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8');
    assert.ok(!/DROP TABLE[^;]*\bmlb_/i.test(text),
      `server/migrations/${name} drops an MLB table. That is destructive and irreversible on the `
      + "live volume, and it needs Nick's own word separately from this removal");
  }
});

test('Middle Linebacker survives the sweep', () => {
  // MLB is a football position. FormationView puts it next to LILB in the
  // linebacker row, and a grep-and-delete for the string would have removed a
  // node from the defensive formation diagram.
  const view = read('client/src/components/FormationView.tsx');
  assert.match(view, /code="MLB"/,
    'the MLB node is gone from the defensive formation diagram. That MLB is Middle '
    + 'Linebacker, a football position, and has nothing to do with baseball');
  assert.match(view, /p\(\['LILB', 'MLB'\]\)/,
    'the inside-linebacker fallback no longer reads MLB');

  // And a second file carries it five more times: the depth-chart slot maps.
  const nfldata = read('server/routes/nfldata.js');
  for (const fragment of ["LB: ['LB', 'ILB', 'MLB']", "MLB: 'LB'",
    "LB: ['MLB', 'WLB', 'SLB', 'LILB', 'RILB', 'LOLB', 'ROLB']"]) {
    assert.ok(nfldata.includes(fragment),
      `server/routes/nfldata.js no longer contains ${fragment}. That MLB is the depth-chart `
      + 'slot for a middle linebacker; removing it drops real NFL players out of the LB group');
  }
});

/*
 * THE FIRST SWEEP MISSED THREE THINGS (SY-06, 2026-09-22). All three are leftovers
 * from #128 above: dead code or a live path that should have been closed along with
 * the rest of the removal, but wasn't because nothing exercised it in a way the
 * original census would have caught.
 *
 * These pins read CODE, not comments. `scan()` is the wiring gate's own scanner: its
 * `text` view blanks comments and keeps string bodies (SQL and import specifiers live
 * in strings). A comment that documents the removal, like the one server/index.js
 * keeps where the props mounts used to be, is never mistaken for the thing it names.
 * An earlier version matched only the exact `import('./routes/props.js')` spelling in
 * server/index.js, because a broader pattern would have hit that comment, and so it
 * passed with the board mounted again from a static import or from another router.
 */

const code = p => scan(read(p)).text;

/** Every .js/.mjs/.cjs file under server/ and scripts/, repo-relative and sorted. */
function liveSources() {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(rel); }
      else if (/\.(c|m)?js$/.test(entry.name)) out.push(rel);
    }
  };
  walk('server');
  walk('scripts');
  return out.sort();
}

/**
 * The files among liveSources() that import one of `targets` (repo-relative paths) in
 * any form the wiring gate reads -- static, bare, re-export or dynamic `import()` --
 * with the specifier resolved against the importing file. It uses the gate's own
 * parser (`moduleEdges`), so this test and `check:wiring` mean the same thing by
 * "imports". The substring test is only a cheap pre-filter; the parse decides.
 */
function importersOf(targets) {
  const wanted = new Set(targets);
  const hints = [...new Set(targets.map(t => path.posix.basename(t, '.js')))];
  return liveSources().filter(file => {
    const raw = read(file);
    if (!hints.some(h => raw.includes(h))) return false;
    return moduleEdges(scan(raw).text).imports.some(({ spec }) => {
      if (!spec.startsWith('.')) return false;
      const resolved = path.posix.join(path.posix.dirname(file), spec);
      return wanted.has(resolved) || wanted.has(`${resolved}.js`);
    });
  });
}

/**
 * The files among liveSources() whose code names `word` (comments blanked, strings
 * kept, so SQL and string literals count), less any file under an `except` prefix.
 */
function codeNaming(word, except = []) {
  const re = new RegExp(`\\b${word}\\b`);
  return liveSources()
    .filter(file => !except.some(prefix => file.startsWith(prefix)))
    .filter(file => { const raw = read(file); return raw.includes(word) && re.test(scan(raw).text); });
}

/** A table's users, less the two places that declare it and so keep it on disk. */
const tableUsers = table => codeNaming(table, ['server/db/schema/', 'server/migrations/']);

const MLB_PROPS_ROUTERS = ['server/routes/props.js', 'server/routes/props-tickets.js'];

test('odds-api.js no longer exports MLB-only symbols', () => {
  // #128 deleted routes/mlb.js and every MLB service, which were the only callers of
  // mlbEvents/mlbEventOdds/MLB_MARKETS/MLB_SPORT in server/services/odds-api.js — a
  // shared betting module the removal never touched. `git grep` confirms zero callers
  // remain anywhere in server, scripts, client/src or test.
  const src = code('server/services/odds-api.js');
  for (const symbol of ['MLB_MARKETS', 'mlbEvents', 'mlbEventOdds', 'MLB_SPORT']) {
    assert.ok(!new RegExp(`\\b${symbol}\\b`).test(src),
      `odds-api.js still defines ${symbol}, a dead MLB-only export nothing calls`);
  }
  // The same dead export under a new name is still MLB code, and so is a caller in
  // another file handing odds-api.js's shared sportEvents()/eventOdds() the MLB sport.
  // Whatever either is called, it has to carry the Odds API's MLB sport key, so no live
  // file may name it. Known-live case first: the NFL key, which odds-api.js uses today.
  assert.ok(codeNaming('americanfootball_nfl').includes('server/services/odds-api.js'),
    "the scan cannot see odds-api.js name 'americanfootball_nfl', so it proves nothing");
  assert.deepEqual(codeNaming('baseball_mlb'), [],
    "these files still name the Odds API's MLB sport key 'baseball_mlb'; MLB is gone from the product (#128)");
});

test('the MLB props board and its saved-slip router are deleted, and nothing live imports or mounts them', () => {
  // server/routes/props.js ("MLB prop research board", a proxy to a private baseball
  // repo) and props-tickets.js ("Saved MLB prop slips") were still mounted at
  // /api/props and /api/props-tickets after #128, and no client page called either
  // path. Unmounting them and keeping the files left two modules that only their own
  // tests imported: what the wiring gate calls module-only-tested, "built, verified,
  // never wired in", and it passed only through an accept-list entry. #128 deleted
  // routes/mlb.js; these two go the same way. Their tables stay (see the next tests).
  for (const file of MLB_PROPS_ROUTERS) {
    assert.ok(!fs.existsSync(new URL(`../${file}`, import.meta.url)),
      `${file} is still in the tree. It is MLB code with no mount and no client caller, `
      + 'kept alive only by its own tests; MLB is gone from the product (#128)');
  }
  // Known-live case first, so an empty answer below is a finding and not a blind scan:
  // server/index.js imports the betting hub's router today.
  assert.ok(importersOf(['server/routes/betting-hub.js']).includes('server/index.js'),
    'the import scan cannot see server/index.js import routes/betting-hub.js, so it proves nothing');
  // Any file, any import form: a static import in server/index.js, or another router
  // that mounts the board under its own prefix (betting-hub.js's r.use('/props', ...)
  // would serve it at /api/betting/props), is the board back just the same.
  assert.deepEqual(importersOf(MLB_PROPS_ROUTERS), [],
    'these files import the deleted MLB props board or its saved-slip router');
  const index = code('server/index.js');
  assert.ok(!/['"`]\/api\/props['"`]/.test(index),
    'server/index.js still mounts /api/props, which no client page calls');
  assert.ok(!/['"`]\/api\/props-tickets['"`]/.test(index),
    'server/index.js still mounts /api/props-tickets, which no client page calls');
});

test('betting-hub.js no longer computes an MLB standing from the now-unmounted props route', () => {
  // Unmounting props.js above stops anything from ever writing props_auto_picks again
  // (only writer was GET /auto-picks in that router). betting-hub.js's own comment says
  // its MLB standing "needs the results feed, which the props route already proxies" --
  // so left in place, /api/betting/summary would silently freeze at whatever tracked_picks
  // existed the moment props.js came out: a route answering from a feed that has silently
  // stopped, the exact shape #128's own commit called out when it took the MLB jobs and
  // router out together rather than leaving one half standing.
  const src = code('server/routes/betting-hub.js');
  assert.ok(!/mlbStanding/.test(src),
    'betting-hub.js still defines/calls mlbStanding(), which reads props_auto_picks -- a table '
    + 'nothing writes once props.js is unmounted');
  assert.ok(!/\bmlb:\s*\{/.test(src), 'server/routes/betting-hub.js still reports an mlb key from /summary');
  // The same stopped-feed read under another name or key is the same bug.
  assert.ok(!/\bprops_auto_picks\b/.test(src),
    'betting-hub.js still reads props_auto_picks, a table nothing writes since the MLB props board was deleted');
});

test('props_auto_picks and saved_prop_tickets stay on disk, and nothing live reads or writes them', () => {
  // The two deleted routers were each table's only writer: ensureAutoPicksFor() in
  // routes/props.js wrote props_auto_picks, and POST / and DELETE /:id in
  // routes/props-tickets.js wrote saved_prop_tickets. The tables and every row in them
  // stay, as the eleven mlb_ tables did in #128: dropping one needs Nick's own word.
  assert.match(read('server/db/schema/core-and-fantasy.js'), /CREATE TABLE IF NOT EXISTS props_auto_picks\b/,
    'props_auto_picks is no longer declared. SY-06 removes its reader and writer, not the table');
  assert.match(read('server/migrations/018_saved_prop_tickets.js'), /CREATE TABLE IF NOT EXISTS saved_prop_tickets\b/,
    'saved_prop_tickets is no longer created. SY-06 removes its reader and writer, not the table');
  const migrations = fs.readdirSync(new URL('../server/migrations/', import.meta.url))
    .filter(name => /\.js$/.test(name) && name !== '018_saved_prop_tickets.js');   // 018's own rollback may drop it
  for (const name of migrations) {
    assert.ok(!/DROP TABLE[^;]*\b(props_auto_picks|saved_prop_tickets)\b/i.test(code(`server/migrations/${name}`)),
      `server/migrations/${name} drops an MLB props table. That is destructive and needs Nick's own word`);
  }
  // Known-live case first: the same scan finds the decision inbox's own table in its router.
  assert.ok(tableUsers('decision_recommendations').includes('server/routes/decision-inbox.js'),
    'the table scan cannot see decision-inbox.js use decision_recommendations, so it proves nothing');
  // A reader with no writer answers from a feed that stopped (betting-hub.js's
  // mlbStanding() was one); a writer means the MLB props board is back under another name.
  assert.deepEqual(tableUsers('props_auto_picks'), [],
    'these files read or write props_auto_picks, which has had no producer since the MLB props board was deleted');
  assert.deepEqual(tableUsers('saved_prop_tickets'), [],
    'these files read or write saved_prop_tickets, which has had no producer since the MLB saved-slip router was deleted');
});
