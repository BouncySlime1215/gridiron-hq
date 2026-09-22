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
});
