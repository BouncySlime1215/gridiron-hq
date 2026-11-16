/**
 * A 200 that did not carry the view we asked for is a failed read, not a
 * successful empty one.
 *
 * `fetchView()` returns null only on a 404 — already counted apart as
 * `not_existing` — and throws only when `!r.ok`. A 200 whose body simply does
 * not contain the requested view therefore arrives as an ordinary payload, and
 * `saveTeams()`/`saveScores()` both open with `payload?.X ?? []` then
 * `if (!length) return 0`. `backfillLeagueHistory()` counts that as `out.ok++`.
 *
 * That is not hypothetical for this endpoint: this file's own header, note 2,
 * records exactly this shape — `view=mDraftDetail` is a separate request, and
 * `payload.draftDetail.picks` "has been empty all along" because the league
 * sync never asked for it. A 200 missing a view is the documented behaviour of
 * the API this file talks to.
 *
 * The consequence is the sharp part. `statusFromDetail()` (scheduler.js:200)
 * reads only `failed` against `attempted`, so with `failed` at 0 the scheduled
 * job records a healthy `'ok'` run — having written nothing. `league_season_teams`
 * stays empty, which is the precise state this file's header says it exists to
 * end: "on any box where nobody had run it the trades surface read an empty
 * table and every manager came back without an owner, which looks the same as a
 * league with nothing measured about it". The fixer can now produce the bug.
 *
 * Same class as #119 ("A growth cycle whose download threw no longer reports
 * itself as ok"), and fixed the same way: count it as the failure it is, so the
 * status the scheduler already computes tells the truth without scheduler.js
 * needing to know anything new.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-empty-payload-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { statusFromDetail } = await import('../server/services/scheduler.js');
const { backfillLeagueHistory } = await import('../server/services/league-history.js');

const realFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = realFetch;
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

run(`INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid)
     VALUES ('espn', '7777', 2026, 'Payload Test League', 's2-cookie', 'swid-cookie')`);
const LEAGUE = row(`SELECT id FROM leagues WHERE league_id='7777'`).id;

const ok200 = body => async () => ({ ok: true, status: 200, json: async () => body });

test('a 200 carrying none of the views we asked for is counted as a failure, not a healthy run', async () => {
  // ESPN answered, and the answer has no mTeam view in it.
  globalThis.fetch = ok200({ settings: { scheduleSettings: { matchupPeriodCount: 14 } } });

  const out = await backfillLeagueHistory({ seasons: [2026], force: true, paceMs: 0, checkLiveDraft: false });

  assert.equal(out.ok, 0, 'nothing was written, so nothing succeeded');
  assert.equal(out.failed, 1, 'a 200 without the requested view is a failed read');
  assert.equal(out.not_existing, 0, 'and it is NOT the 404 case, which is a different answer');
  assert.match(String(out.league_seasons.find(l => l.league_id === LEAGUE)?.error ?? ''), /team/i,
    'the reason has to name what was missing rather than reporting a silent zero');
  assert.equal(statusFromDetail(out), 'error',
    'a run that wrote nothing must never be logged as a healthy run — '
    + 'league_season_teams staying empty is the exact bug this file exists to end');
});

test('a season with teams but no games yet is still a healthy run', async () => {
  // A real league-season that simply has not played: mTeam is present, the
  // schedule is empty. Legitimately zero team-weeks, and the teams still land.
  globalThis.fetch = ok200({
    settings: { scheduleSettings: { matchupPeriodCount: 14 } },
    members: [{ id: 'MEM-A', firstName: 'Ada', lastName: 'Byron' }],
    teams: [{ id: 1, name: 'Team 1', owners: ['MEM-A'], record: { overall: {} } }],
    schedule: [],
  });

  const out = await backfillLeagueHistory({ seasons: [2025], force: true, paceMs: 0, checkLiveDraft: false });

  assert.equal(out.failed, 0, 'an empty schedule is a real state, not a fault');
  assert.equal(out.ok, 1);
  assert.equal(out.teams, 1, 'and the identity rows it DID carry were written');
  assert.equal(statusFromDetail(out), 'ok');
  assert.equal(rows('SELECT * FROM league_season_teams WHERE league_id=? AND season=2025', LEAGUE).length, 1);
});
