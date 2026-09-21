/**
 * The two tables the manager layer stands on had one writer between them, and
 * it was a script somebody had to remember to run (2026-09-19).
 *
 * `league_season_teams` is read on the trades surface — manager-archetypes.js
 * attributes draft picks with it (:243), names a member with it (:819) and
 * keys a league's managers by roster id with it (:831) — and nothing on any
 * server ever wrote a row into it. On a box where nobody had run
 * scripts/backfill-league-history.mjs the table did not even exist, so those
 * reads threw rather than returning nothing, and where it did exist it held
 * whatever a person had last filled in.
 *
 * These tests pin the three things that fix has to keep true: the schema is a
 * migration rather than a side effect of running a script, the writer is on a
 * timer, and it runs ahead of the archetype build that consumes it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-league-history-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { JOBS, statusFromDetail, runIfStale } = await import('../server/services/scheduler.js');
const { backfillLeagueHistory, seasonsToFetch } = await import('../server/services/league-history.js');
const { FANTASY_LIVE_JOBS } = await import('../scripts/refresh-live-data.mjs');

const realFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = realFetch;
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

run(`INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid)
     VALUES ('espn', '4242', 2026, 'Test League', 's2-cookie', 'swid-cookie')`);
const LEAGUE = row(`SELECT id FROM leagues WHERE league_id='4242'`).id;

/** ESPN's shape, reduced to the fields the two savers actually read. */
const payload = (season, { teams = 2 } = {}) => ({
  settings: { scheduleSettings: { matchupPeriodCount: 14 } },
  members: [{ id: 'MEM-A', firstName: 'Ada', lastName: 'Byron' },
    { id: 'MEM-B', firstName: 'Grace', lastName: 'Hopper' }],
  teams: Array.from({ length: teams }, (_, i) => ({
    id: i + 1, name: `Team ${i + 1}`, owners: [i === 0 ? 'MEM-A' : 'MEM-B'],
    record: { overall: { wins: 9, losses: 5, ties: 0, pointsFor: 1500 + season, pointsAgainst: 1400 } },
    rankCalculatedFinal: i + 1, playoffSeed: i + 1,
  })),
  schedule: [{ matchupPeriodId: 1, home: { teamId: 1, totalPoints: 101.5 }, away: { teamId: 2, totalPoints: 99.5 } }],
});

test('both tables exist from a migration, not from having run a script', () => {
  for (const table of ['league_season_teams', 'league_week_scores']) {
    assert.ok(row(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table),
      `${table} must exist on a fresh database — manager-archetypes.js reads it on the trades surface`);
  }
  assert.ok(row(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_league_season_teams_member'`),
    'managerProfile() looks a member up across every league-season, which the primary key does not serve');
});

test('the writer is on a timer, and ahead of the archetype build that reads its rows', () => {
  assert.ok(JOBS.league_history, 'league_season_teams had no scheduled writer at all');
  assert.ok(Number.isFinite(JOBS.league_history.maxAgeMinutes), 'it needs a cadence');
  assert.equal(JOBS.league_history.tier, 'growth',
    'the heavy tier is gated behind AUTO_HEAVY_SYNC, and a history layer that only builds behind a flag is the failure being fixed');
  assert.ok(FANTASY_LIVE_JOBS.indexOf('league_history') > -1,
    'the deployed box runs with SCHEDULER_DISABLED=1, so a job missing from this list never runs there');
  assert.ok(FANTASY_LIVE_JOBS.indexOf('league_history') < FANTASY_LIVE_JOBS.indexOf('manager_archetypes'),
    'manager_archetypes replays league-seasons out of the rows this writes');
});

test('a scheduled run fills standings and weekly scores for the current season', async () => {
  globalThis.fetch = async url => {
    assert.match(String(url), /seasons\/2026\/segments\/0\/leagues\/4242/,
      'the current season lives at the seasons endpoint, not leagueHistory');
    return { ok: true, status: 200, json: async () => payload(2026) };
  };

  const result = await runIfStale('league_history', { force: true });
  assert.equal(result.ran, true, 'the job must actually run, not skip');
  assert.equal(result.error, undefined, `must not error: ${result.error}`);

  const teams = rows('SELECT * FROM league_season_teams WHERE league_id=? AND season=2026 ORDER BY roster_id', LEAGUE);
  assert.equal(teams.length, 2);
  assert.equal(teams[0].espn_member_id, 'MEM-A', 'the roster -> ESPN member map is the whole point of the table');
  assert.equal(teams[0].owner_name, 'Ada Byron');
  assert.equal(rows('SELECT * FROM league_week_scores WHERE league_id=? AND season=2026', LEAGUE).length, 2);
});

test('a prior season already stored is not fetched again; the current season always is', () => {
  const lg = row('SELECT id,season FROM leagues WHERE id=?', LEAGUE);
  // 2026 was just written by the test above, and it is the current season.
  assert.ok(seasonsToFetch(lg).includes(2026), 'standings and scores move every week of the live season');

  db.prepare(`INSERT INTO league_season_teams
    (league_id,season,roster_id,captured_at) VALUES (?,2024,'1',datetime('now'))`).run(LEAGUE);
  assert.ok(!seasonsToFetch(lg).includes(2024), 'a finished season cannot change, so re-reading it is a wasted ESPN request');
  assert.ok(seasonsToFetch(lg).includes(2025), 'a prior season with nothing stored is still filled in');
  assert.ok(seasonsToFetch(lg, { force: true }).includes(2024), '--force re-reads the whole window');
  assert.deepEqual(seasonsToFetch(lg, { seasons: [2019], force: true }), [2019], 'an explicit season list wins');
});

test('ESPN is not touched at all while a draft is live', async () => {
  // Same gate, and the same reason, as league_rosters: this reads the espn_s2
  // and SWID out of the `leagues` row that Nick's own browser is drafting with.
  db.prepare(`INSERT INTO drafts (name,team_count,league_row_id,status,draft_at)
    VALUES ('Live', 2, ?, 'active', ?)`).run(LEAGUE, new Date().toISOString());

  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not reach ESPN'); };
  const out = await backfillLeagueHistory();
  assert.ok(out.skipped, 'a live draft has to skip the whole run');
  assert.equal(called, false);
  assert.equal(statusFromDetail(out), 'skipped', 'a skip must not be logged as a healthy run');

  db.exec('DELETE FROM drafts');
});

test('one league-season failing is counted, not swallowed and not fatal', async t => {
  run(`INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid)
       VALUES ('espn', '5150', 2026, 'Second League', 's2-cookie', 'swid-cookie')`);
  const second = row(`SELECT id FROM leagues WHERE league_id='5150'`).id;
  t.after(() => run('DELETE FROM leagues WHERE id=?', second));

  globalThis.fetch = async url => (String(url).includes('5150')
    ? { ok: false, status: 500, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => payload(2026) });

  const out = await backfillLeagueHistory({ seasons: [2026], force: true, paceMs: 0, checkLiveDraft: false });
  assert.equal(out.failed, 1);
  assert.equal(out.ok, 1, 'the healthy league still wrote its rows');
  assert.equal(out.attempted, 2, 'the total has to be the whole batch, or one failure of two reads as total failure');
  assert.equal(statusFromDetail(out), 'partial', 'half a batch is not a healthy run and is not a dead one');
  assert.ok(out.league_seasons.find(l => l.league_id === second)?.error?.includes('ESPN 500'));
});

test('a season the league did not exist in is reported as absent, not as a failure', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const out = await backfillLeagueHistory({ seasons: [2019], force: true, paceMs: 0, checkLiveDraft: false });
  assert.equal(out.not_existing, 1);
  assert.equal(out.failed, 0, 'leagues 3, 4 and 5 are newer than the window — that is coverage, not breakage');
  assert.equal(statusFromDetail(out), 'ok');
});
