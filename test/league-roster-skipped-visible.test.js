/**
 * A sweep that deliberately did nothing must not report itself as a sweep that
 * synced everything (2026-09-20).
 *
 * `refreshLeagueRosters` pauses ESPN leagues while a draft is live, because on
 * 2026-09-06 the hourly sweep hit ESPN with the same espn_s2/SWID Nick's
 * browser was drafting on and ESPN treated it as concurrent use of one
 * session. That pause is correct.
 *
 * What was wrong is what it recorded. Each paused league pushed
 * `{ ok: true, skipped: true }` into the results, and the return read only
 * `leagues` and `failed` — so a sweep that touched nothing wrote
 * `{ leagues: 7, failed: 0 }`, character for character what a sweep that
 * synced all seven writes. That object is the `sync_log` detail, which is what
 * `schedulerStatus()` serves, so the one case where this job deliberately does
 * no work was the one case no reader could see. The field was attached and
 * never read — the project's signature shape, healthy-looking and not working.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-roster-skip-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
// `drafts` is one of the ad-hoc tables created at import time by this route
// rather than by a migration, and liveDraftActive() reads it. Importing the
// route is how a test gets the real table instead of inventing its own.
await import('../server/routes/drafts.js');
const { refreshLeagueRosters } = await import('../server/services/scheduler.js');

after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function reset() {
  // Drafts first: a trigger refuses to delete a league that still has draft
  // history ("league has draft history; disconnect or delete drafts first"),
  // so the other order fails on the second test rather than the first.
  db.exec('DELETE FROM drafts');
  db.exec('DELETE FROM leagues');
}

const addEspnLeague = id => db.prepare(
  `INSERT INTO leagues (platform, league_id, season, name) VALUES ('espn', ?, 2026, ?)`)
  .run(id, `league ${id}`);

/** A draft scheduled now, which is what liveDraftActive() looks for. */
const startDraftNow = () => db.prepare(
  `INSERT INTO drafts (name, type, status, league_row_id, draft_at) VALUES (?,?,?,?,?)`)
  .run('live one', 'real', 'active',
    db.prepare(`SELECT id FROM leagues LIMIT 1`).get().id, new Date().toISOString());

test('a sweep paused by a live draft reports the pause, not a clean run', async () => {
  reset();
  addEspnLeague('111');
  addEspnLeague('222');
  startDraftNow();

  const detail = await refreshLeagueRosters();

  assert.equal(detail.leagues, 2);
  assert.equal(detail.skipped, 2, 'both ESPN leagues were paused and the count must say so');
  assert.equal(detail.synced, 0, 'and nothing was actually synced');
  assert.equal(detail.failed, 0, 'a deliberate pause is not a failure — it must not back the job off');
});

test('the paused sweep is distinguishable from a sweep that did the work', async () => {
  reset();
  addEspnLeague('111');
  addEspnLeague('222');
  startDraftNow();
  const paused = await refreshLeagueRosters();

  reset();
  addEspnLeague('333');
  addEspnLeague('444');
  const attempted = await refreshLeagueRosters();   // no draft: these are really tried

  // This is the whole point. Before the fix both of these were
  // `{ leagues: 2, failed: 0 }` and `{ leagues: 2, failed: N }` was the only
  // signal available — a pause and a success were the same row.
  assert.notDeepEqual(paused, attempted,
    'a sweep that paused and a sweep that ran must not produce the same detail');
  assert.equal(paused.skipped, 2);
  assert.equal(attempted.skipped, 0, 'with no draft live, nothing is skipped');
});

test('every league is accounted for exactly once', async () => {
  reset();
  addEspnLeague('111');
  addEspnLeague('222');
  addEspnLeague('333');

  const detail = await refreshLeagueRosters();

  // Whatever the outcome per league, the three counts must partition the set —
  // otherwise a reader adding them up gets a number that is not the truth.
  assert.equal(detail.synced + detail.failed + detail.skipped, detail.leagues,
    'synced + failed + skipped must equal the league count, or the detail is not a report');
});
