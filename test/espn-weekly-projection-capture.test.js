// E-XGB phase 1: frozen, pre-kickoff ESPN weekly projections (docs/tdd/EXGB-PREREG.md).
// Synthetic fixtures only; fetch is injected, so nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-espn-wp-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const cap = await import('../server/services/espn-weekly-projection-capture.js');
const { JOBS, resolveOffThread } = await import('../server/services/scheduler.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2031; // a season no real fixture uses
const WEEK = 4;
const COOKIE_S2 = 'fixture-s2-value-never-stored';

// game_lines: CLE/PIT Thursday 20:15 ET, KC Sunday 13:00 ET, ATL Monday 20:15 ET.
function seedGames() {
  run(`CREATE TABLE IF NOT EXISTS game_lines (season INTEGER NOT NULL, week INTEGER NOT NULL, team TEXT NOT NULL,
       gameday TEXT, gametime TEXT, PRIMARY KEY (season, week, team))`);
  for (const [team, day, time] of [['CLE', '2031-10-02', '20:15'], ['PIT', '2031-10-02', '20:15'],
    ['KC', '2031-10-05', '13:00'], ['ATL', '2031-10-06', '20:15']]) {
    run('INSERT OR REPLACE INTO game_lines (season, week, team, gameday, gametime) VALUES (?,?,?,?,?)',
      SEASON, WEEK, team, day, time);
  }
  run(`INSERT INTO leagues (id, platform, league_id, season, espn_s2, swid, name) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO NOTHING`, 9, 'espn', '424242', SEASON, COOKIE_S2, '{fixture-swid}', 'fixture');
}

// ESPN kona_player_info shape: statSourceId 1 = projection, 0 = actual.
function stat(src, period, total) {
  return { id: `${src}1${SEASON}${period}`, statSourceId: src, scoringPeriodId: period, seasonId: SEASON,
    statSplitTypeId: 1, appliedTotal: total, stats: { 53: 5 } };
}
function payload(scale = 1) {
  const p = (id, team, pos, stats) => ({ id, onTeamId: 0, player: {
    id, fullName: `Fixture ${id}`, proTeamId: team, defaultPositionId: pos, injuryStatus: 'ACTIVE', stats } });
  return { players: [
    p(1001, 5, 2, [stat(1, WEEK, 14.2 * scale), stat(0, WEEK - 1, 30)]), // CLE RB, Thursday
    p(1002, 12, 3, [stat(1, WEEK, 11.5 * scale), stat(1, WEEK - 1, 99)]), // KC WR, Sunday
    p(1003, 1, 1, [stat(1, WEEK, 19.0 * scale)]),                         // ATL QB, Monday
    p(1004, 12, 4, [stat(0, WEEK, 7)]),                                   // no projection: skipped
  ] };
}
function fakeFetch(calls, scale = 1) {
  return async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    const body = JSON.stringify(payload(scale));
    return { ok: true, status: 200, text: async () => body };
  };
}

seedGames();

test('parseProjectionPayload keeps only this week\'s projection (statSourceId 1), never actuals', () => {
  const out = cap.parseProjectionPayload(payload(), { season: SEASON, week: WEEK });
  assert.deepEqual(out.map(r => [r.espn_id, r.projected_pts, r.position, r.pro_team]),
    [[1001, 14.2, 'RB', 'CLE'], [1002, 11.5, 'WR', 'KC'], [1003, 19, 'QB', 'ATL']]);
});

test('isLate is the leakage guard: at or after kickoff is late, before is not, unknown kickoff is not gradable', () => {
  const k = '2031-10-05T17:00:00.000Z';
  assert.equal(cap.isLate('2031-10-05T16:59:59.000Z', k), 0);
  assert.equal(cap.isLate(k, k), 1);
  assert.equal(cap.isLate('2031-10-05T17:00:01.000Z', k), 1);
  assert.equal(cap.isLate('2031-10-05T16:00:00.000Z', null), 0);
});

test('captureWindows: Tuesday after waivers, Saturday morning, and 2 h before every kickoff', () => {
  const kicks = [...new Set(cap.kickoffsByTeam(SEASON, WEEK).values())];
  const w = cap.captureWindows(kicks);
  const keys = w.map(x => x.key);
  assert.ok(keys.includes('tue_post_waivers'));
  assert.ok(keys.includes('sat_morning'));
  const pre = w.filter(x => x.key.startsWith('pre_kick_'));
  assert.equal(pre.length, 3, 'Thursday, Sunday 13:00 and Monday are three kickoff instants');
  for (const x of pre) {
    assert.equal(Date.parse(x.closes_at) - Date.parse(x.opens_at), 2 * 3600e3);
  }
  const tue = w.find(x => x.key === 'tue_post_waivers');
  assert.equal(tue.opens_at, '2031-09-30T16:00:00.000Z', 'Tuesday 12:00 ET before the Thursday game');
  const sat = w.find(x => x.key === 'sat_morning');
  assert.equal(sat.opens_at, '2031-10-04T13:00:00.000Z', 'Saturday 09:00 ET');
});

test('captureWeek appends rows, flags the already-kicked-off players late, and never stores the cookie', async () => {
  const calls = [];
  // Friday: Thursday's game has kicked off, Sunday's and Monday's have not.
  const now = new Date('2031-10-03T15:00:00.000Z');
  const r = await cap.captureWeek({ season: SEASON, week: WEEK, windowKey: 'manual', now,
    fetchImpl: fakeFetch(calls), leagueRowIds: [9] });
  assert.equal(r.captures.length, 2, 'PPR defaults and the league\'s own scoring');
  assert.deepEqual(r.captures.map(c => c.scoring_key).sort(), ['league:9', 'ppr']);
  const got = rows(`SELECT espn_id, late, kickoff_at, player_id FROM espn_weekly_projection_snapshots
                    WHERE season = ? AND scoring_key = 'ppr' ORDER BY espn_id`, SEASON);
  assert.deepEqual(got.map(g => [g.espn_id, g.late]), [[1001, 1], [1002, 0], [1003, 0]]);
  assert.ok(got.every(g => g.kickoff_at));
  const league = calls.find(c => c.url.includes('/leagues/424242'));
  assert.match(league.headers.Cookie, /espn_s2=/, 'the league call uses the league\'s own cookies');
  assert.ok(!calls.find(c => c.url.includes('leaguedefaults')).headers.Cookie, 'PPR defaults need no cookie');
  const dump = JSON.stringify(rows('SELECT capture_id, source_url_hash, payload_sha256, window_key, error FROM espn_weekly_projection_captures'))
    + JSON.stringify(rows('SELECT * FROM espn_weekly_projection_snapshots'));
  assert.ok(!dump.includes(COOKIE_S2), 'no cookie value in any stored row');
});

test('the tables are append-only: a second capture adds rows, UPDATE and DELETE are refused', async () => {
  const before = rows('SELECT COUNT(*) n FROM espn_weekly_projection_snapshots')[0].n;
  await cap.captureWeek({ season: SEASON, week: WEEK, windowKey: 'manual', now: new Date('2031-10-03T16:00:00.000Z'),
    fetchImpl: fakeFetch([], 1.1), leagueRowIds: [] });
  const after = rows('SELECT COUNT(*) n FROM espn_weekly_projection_snapshots')[0].n;
  assert.equal(after, before + 3);
  assert.throws(() => run('UPDATE espn_weekly_projection_snapshots SET projected_pts = 0'), /append-only/);
  assert.throws(() => run('DELETE FROM espn_weekly_projection_snapshots'), /append-only/);
  assert.throws(() => run('DELETE FROM espn_weekly_projection_captures'), /append-only/);
});

test('frozenEspnForGrading: the latest capture before each player\'s kickoff, never a late row', () => {
  const g = cap.frozenEspnForGrading(SEASON, WEEK, 'ppr');
  assert.deepEqual(g.map(r => r.espn_id), [1002, 1003], 'the Thursday player was only ever captured late');
  assert.equal(g.find(r => r.espn_id === 1002).projected_pts, 12.65, 'the later (16:00) pre-kickoff capture wins');
  assert.ok(g.every(r => r.captured_at < r.kickoff_at));
});

test('the scheduled job captures once per due window and does nothing outside windows', async () => {
  const calls = [];
  const opts = { fetchImpl: fakeFetch(calls), leagueRowIds: [], season: SEASON };
  // Sunday 11:30 ET: inside the 2 h window before the 13:00 kickoff.
  const inWindow = new Date('2031-10-05T15:30:00.000Z');
  const first = await cap.runEspnWeeklyProjectionCapture({ ...opts, now: inWindow });
  assert.equal(first.captured, 1);
  assert.match(first.windows.join(','), /pre_kick_/);
  const again = await cap.runEspnWeeklyProjectionCapture({ ...opts, now: new Date(inWindow.getTime() + 15 * 60e3) });
  assert.equal(again.captured, 0, 'the same window is never fetched twice');
  const outside = await cap.runEspnWeeklyProjectionCapture({ ...opts, now: new Date('2031-10-05T21:00:00.000Z') });
  assert.equal(outside.captured, 0);
  assert.equal(calls.length, 1);
});

test('a failed fetch is recorded as an error capture and reported, not swallowed', async () => {
  const bad = async () => ({ ok: false, status: 503, text: async () => 'down' });
  const r = await cap.captureWeek({ season: SEASON, week: WEEK, windowKey: 'manual-err',
    now: new Date('2031-10-03T17:00:00.000Z'), fetchImpl: bad, leagueRowIds: [] });
  assert.equal(r.failed, 1);
  const e = rows(`SELECT status, error FROM espn_weekly_projection_captures WHERE window_key = 'manual-err'`);
  assert.equal(e[0].status, 'error');
  assert.match(e[0].error, /503/);
});

test('espn_weekly_projection_capture is a live, off-thread scheduler job on the refresh loop', async () => {
  const job = JOBS.espn_weekly_projection_capture;
  assert.ok(job);
  assert.equal(job.tier, 'live');
  assert.equal(resolveOffThread(job), true);
  assert.ok(job.maxAgeMinutes <= 15, 'must tick often enough to land inside a 2 h pre-kickoff window');
  const { FANTASY_LIVE_JOBS } = await import('../scripts/refresh-live-data.mjs');
  assert.ok(FANTASY_LIVE_JOBS.includes('espn_weekly_projection_capture'));
});
