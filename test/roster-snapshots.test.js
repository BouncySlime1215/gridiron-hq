/**
 * Weekly roster snapshots: every team's roster and lineup slots, per league per
 * ESPN scoring period, so "what did I start" and bench points have a history.
 *
 * Why (docs/FANTASY-ENGINE-MASTER-PLAN.md section 00, [WA-ess]): `leagues.payload`
 * is overwritten by every hourly ESPN sync, so until now last week's lineups were
 * gone the moment the scoring period rolled over.
 *
 * Guarantees (docs/tdd/infra-essentials.tdd.md, gate G2):
 *  - migration 058 creates the table and its index; down() drops them.
 *  - the live capture reads the stored payload (no network), maps slot, starter,
 *    projection and actual points for THIS period only, and our player id.
 *  - idempotent: the same payload twice writes nothing and moves no timestamp.
 *  - a slot change updates one row, a dropped player is kept with on_roster = 0.
 *  - a pre-draft fallback payload (last season's) is never captured as this season.
 *  - a completed period is finalized once from ESPN's boxscore (source 'final');
 *    live captures never overwrite it; the team's starters sum to ESPN's score.
 *  - a network failure keeps the live capture and is recorded as 'partial'.
 * No test reaches the network: ESPN is a mocked fetch, and the one end-to-end run of
 * the script goes through the offline guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-roster-snapshots-'));
const DB_FILE = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_PATH = DB_FILE;
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const RS = await import('../scripts/collect-roster-snapshots.mjs');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const SEASON = 2026;
const MIGRATION = path.join(REPO, 'server', 'migrations', '058_league_roster_snapshots.js');

// ---------------------------------------------------------------- fixtures
function stat(period, source, points, season = SEASON, split = 1) {
  return { seasonId: season, scoringPeriodId: period, statSourceId: source, statSplitTypeId: split, appliedTotal: points };
}

/** One ESPN mRoster entry. Stats that must be ignored ride along on purpose. */
function entry(pid, slot, { period = 2, proj = 10, actual = null, injury = 'ACTIVE', locked = false, pos = 3 } = {}) {
  const stats = [stat(period, 1, proj), stat(0, 0, 999, SEASON, 0), stat(period, 0, 555, SEASON - 1)];
  if (actual != null) stats.push(stat(period, 0, actual));
  return {
    playerId: pid, lineupSlotId: slot, injuryStatus: injury, acquisitionType: 'DRAFT',
    playerPoolEntry: {
      id: pid, appliedStatTotal: 999, lineupLocked: locked,
      player: { id: pid, fullName: `Player ${pid}`, defaultPositionId: pos, proTeamId: 26, injuryStatus: injury, stats }
    }
  };
}

function leaguePayload({ season = SEASON, period = 2, teams, decided = {} }) {
  const schedule = [];
  for (const p of [1, 2, 3]) {
    schedule.push({ matchupPeriodId: p, winner: decided[p] ?? (p < period ? 'HOME' : 'UNDECIDED'),
      home: { teamId: 1 }, away: { teamId: 2 } });
  }
  return {
    seasonId: season, scoringPeriodId: period,
    status: { currentMatchupPeriod: period, latestScoringPeriod: period, firstScoringPeriod: 1, finalScoringPeriod: 17 },
    settings: { scheduleSettings: { matchupPeriods: { 1: [1], 2: [2], 3: [3] } } },
    schedule,
    teams: teams.map(([id, entries]) => ({ id, roster: { entries } }))
  };
}

/** ESPN's completed-period boxscore: each side's final lineup with that period's points. */
function boxscore(period, sides) {
  const side = ([teamId, list]) => {
    const entries = list.map(([pid, slot, pts]) => ({
      lineupSlotId: slot, playerId: pid,
      playerPoolEntry: { id: pid, appliedStatTotal: pts,
        player: { id: pid, fullName: `Player ${pid}`, defaultPositionId: 3, proTeamId: 26,
          stats: [stat(period, 0, pts), stat(period, 1, 12)] } }
    }));
    const total = +list.filter(([, slot]) => slot !== 20 && slot !== 21).reduce((s, [, , p]) => s + p, 0).toFixed(2);
    return { teamId, totalPoints: total, rosterForCurrentScoringPeriod: { appliedStatTotal: total, entries } };
  };
  return { scoringPeriodId: period, schedule: [{ matchupPeriodId: period, winner: 'HOME', home: side(sides[0]), away: side(sides[1]) }] };
}

function mockFetch(byPeriod, calls) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers ?? {} });
    const period = Number(new URL(url).searchParams.get('scoringPeriodId'));
    const body = byPeriod[period];
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
}

function resetLeague(payload, { season = SEASON } = {}) {
  run('DELETE FROM league_roster_snapshots');
  run('DELETE FROM leagues');
  run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, espn_s2, swid, fetched_at)
       VALUES (1, 'espn', '111', ?, 'Test league', ?, 2, 'test-s2', '{TEST-SWID}', datetime('now'))`,
  season, JSON.stringify(payload));
}

function setPayload(payload) {
  run(`UPDATE leagues SET payload = ?, fetched_at = datetime('now') WHERE id = 1`, JSON.stringify(payload));
}

const snapshot = () => rows(`SELECT * FROM league_roster_snapshots
  ORDER BY league_id, season, scoring_period_id, team_id, espn_player_id`);

const TEAM1 = [entry(101, 0, { proj: 20, actual: 7.5 }), entry(102, 2), entry(103, 20), entry(104, 21, { injury: 'INJURY_RESERVE' })];
const TEAM2 = [entry(201, 0), entry(202, 23), entry(203, 20)];

// Our own player rows, so the ESPN id maps to players.id.
run(`INSERT OR IGNORE INTO players (id, name, position, espn_id) VALUES (900101, 'Player 101', 'QB', 101)`);
run(`INSERT OR IGNORE INTO players (id, name, position, espn_id) VALUES (900202, 'Player 202', 'WR', 202)`);

// ---------------------------------------------------------------- migration
test('G2a: migration 058 creates the snapshot table and index, and down() drops them', async () => {
  const mod = await import(pathToFileURL(MIGRATION).href);
  assert.equal(mod.name, '058_league_roster_snapshots');
  const scratch = new DatabaseSync(':memory:');
  mod.up(scratch);
  mod.up(scratch); // idempotent
  const has = kind => scratch.prepare(`SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = 'league_roster_snapshots'`)
    .all(kind).map(r => r.name);
  assert.deepEqual(has('table'), ['league_roster_snapshots']);
  assert.ok(has('index').includes('idx_league_roster_snapshots_period'), 'period index');
  mod.down(scratch);
  assert.deepEqual(has('table'), []);
  scratch.close();
  // The real runner applied it to the test database.
  assert.equal(rows(`SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '058_league_roster_snapshots'`)[0].n, 1);
});

// ---------------------------------------------------------------- live capture
test('G2: the live capture stores every rostered player with slot, starter flag and this period\'s points', async () => {
  resetLeague(leaguePayload({ teams: [[1, TEAM1], [2, TEAM2]] }));
  const out = await RS.collectRosterSnapshots({ network: false, now: () => '2026-09-18T15:00:00.000Z' });
  assert.equal(out.status, 'ok', JSON.stringify(out));
  const lg = out.leagues[0];
  assert.equal(lg.live.period, 2);
  assert.equal(lg.live.teams, 2);
  assert.equal(lg.live.inserted, 7);
  const all = snapshot();
  assert.equal(all.length, 7);
  const p101 = all.find(r => r.espn_player_id === 101);
  assert.equal(p101.season, SEASON);
  assert.equal(p101.scoring_period_id, 2);
  assert.equal(p101.team_id, 1);
  assert.equal(p101.player_id, 900101, 'mapped to players.id through espn_id');
  assert.equal(p101.position, 'QB');
  assert.equal(p101.lineup_slot_id, 0);
  assert.equal(p101.lineup_slot, 'QB');
  assert.equal(p101.is_starter, 1);
  assert.equal(p101.projected_points, 20, 'this period\'s projection, not the season total');
  assert.equal(p101.actual_points, 7.5, 'this period\'s actual, not last season\'s or the season total');
  assert.equal(p101.on_roster, 1);
  assert.equal(p101.source, 'live');
  const bench = all.find(r => r.espn_player_id === 103);
  assert.equal(bench.is_starter, 0);
  assert.equal(bench.lineup_slot, 'BENCH');
  assert.equal(bench.actual_points, null, 'no game yet: no actual, never a season total');
  const ir = all.find(r => r.espn_player_id === 104);
  assert.equal(ir.is_starter, 0);
  assert.equal(ir.lineup_slot, 'IR');
  assert.equal(ir.injury_status, 'INJURY_RESERVE');
  const flex = all.find(r => r.espn_player_id === 202);
  assert.equal(flex.lineup_slot, 'FLEX');
  assert.equal(flex.is_starter, 1);
});

test('G2b: capturing the same payload again writes nothing and moves no timestamp', async () => {
  resetLeague(leaguePayload({ teams: [[1, TEAM1], [2, TEAM2]] }));
  await RS.collectRosterSnapshots({ network: false, now: () => '2026-09-18T15:00:00.000Z' });
  const before = snapshot();
  const again = await RS.collectRosterSnapshots({ network: false, now: () => '2026-09-18T15:15:00.000Z' });
  assert.equal(again.writes, 0, JSON.stringify(again));
  assert.deepEqual(again.leagues[0].live, { period: 2, teams: 2, inserted: 0, updated: 0, dropped: 0 });
  assert.deepEqual(snapshot(), before, 'every row, changed_at included, is identical');
});

test('G2c: a slot change updates one row; a dropped player is kept with on_roster = 0; an add is inserted', async () => {
  resetLeague(leaguePayload({ teams: [[1, TEAM1], [2, TEAM2]] }));
  await RS.collectRosterSnapshots({ network: false, now: () => '2026-09-18T15:00:00.000Z' });
  // 103 moves from the bench into the lineup, 102 is dropped, 105 is picked up.
  const team1 = [entry(101, 0, { proj: 20, actual: 7.5 }), entry(103, 2), entry(104, 21, { injury: 'INJURY_RESERVE' }), entry(105, 20)];
  setPayload(leaguePayload({ teams: [[1, team1], [2, TEAM2]] }));
  const out = await RS.collectRosterSnapshots({ network: false, now: () => '2026-09-18T16:00:00.000Z' });
  assert.deepEqual(out.leagues[0].live, { period: 2, teams: 2, inserted: 1, updated: 1, dropped: 1 });
  const all = snapshot();
  const moved = all.find(r => r.espn_player_id === 103);
  assert.equal(moved.lineup_slot_id, 2);
  assert.equal(moved.is_starter, 1);
  assert.equal(moved.changed_at, '2026-09-18T16:00:00.000Z');
  assert.equal(moved.first_seen_at, '2026-09-18T15:00:00.000Z');
  const dropped = all.find(r => r.espn_player_id === 102);
  assert.equal(dropped.on_roster, 0, 'kept: he may have scored for this team before the drop');
  assert.equal(dropped.lineup_slot_id, 2, 'his last slot is kept');
  assert.equal(all.find(r => r.espn_player_id === 105).on_roster, 1);
  assert.equal(all.find(r => r.espn_player_id === 101).changed_at, '2026-09-18T15:00:00.000Z', 'untouched');
});

test('G2d: a pre-draft fallback payload (last season) is never captured as this season', async () => {
  resetLeague(leaguePayload({ season: SEASON - 1, period: 17, teams: [[1, TEAM1]] }));
  const out = await RS.collectRosterSnapshots({ network: false });
  assert.equal(snapshot().length, 0);
  assert.match(out.leagues[0].live.skipped, /season/);
  assert.equal(out.status, 'ok', 'a pre-draft league is not an error');
});

// ---------------------------------------------------------------- finalization
const WEEK1 = boxscore(1, [
  [1, [[101, 0, 18.4], [102, 2, 11.1], [103, 20, 25.0], [104, 21, 0]]],
  [2, [[201, 0, 22.2], [202, 23, 9.35], [203, 20, 3.0]]]
]);

test('G2e: a completed period is finalized once from ESPN\'s boxscore; starters sum to ESPN\'s score', async () => {
  resetLeague(leaguePayload({ teams: [[1, TEAM1], [2, TEAM2]] }));
  const calls = [];
  const out = await RS.collectRosterSnapshots({ fetchImpl: mockFetch({ 1: WEEK1 }, calls), now: () => '2026-09-18T15:00:00.000Z' });
  assert.equal(out.status, 'ok', JSON.stringify(out));
  assert.equal(calls.length, 1, 'one request: period 1 is the only completed period');
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('scoringPeriodId'), '1');
  assert.deepEqual(url.searchParams.getAll('view').sort(), ['mBoxscore', 'mMatchupScore']);
  assert.match(url.pathname, /\/seasons\/2026\/segments\/0\/leagues\/111$/);
  assert.deepEqual(JSON.parse(calls[0].headers['x-fantasy-filter']), { schedule: { filterMatchupPeriodIds: { value: [1] } } });
  assert.match(calls[0].headers.Cookie, /espn_s2=test-s2; SWID=\{TEST-SWID\}/);
  const fin = out.leagues[0].final;
  assert.deepEqual(fin, [{ period: 1, teams: 2, inserted: 7, updated: 0, dropped: 0, mismatched_teams: [] }]);
  const week1 = rows(`SELECT * FROM league_roster_snapshots WHERE scoring_period_id = 1 ORDER BY espn_player_id`);
  assert.equal(week1.length, 7);
  assert.ok(week1.every(r => r.source === 'final'));
  const starters = team => week1.filter(r => r.team_id === team && r.is_starter === 1)
    .reduce((s, r) => s + r.actual_points, 0);
  assert.equal(+starters(1).toFixed(2), 29.5);
  assert.equal(+starters(2).toFixed(2), 31.55);
  assert.equal(week1.find(r => r.espn_player_id === 103).actual_points, 25, 'bench points are kept');

  // Finalized once: the next tick asks ESPN for nothing and writes nothing.
  const calls2 = [];
  const again = await RS.collectRosterSnapshots({ fetchImpl: mockFetch({ 1: WEEK1 }, calls2), now: () => '2026-09-18T15:15:00.000Z' });
  assert.equal(calls2.length, 0);
  assert.equal(again.writes, 0);
});

test('G2e: finalizing overwrites the live rows of that period and marks players gone by period end', async () => {
  // Captured live during period 1 (102 was still rostered then) ...
  resetLeague(leaguePayload({ period: 1, teams: [[1, [entry(101, 0, { period: 1 }), entry(102, 2, { period: 1 }), entry(109, 20, { period: 1 })]],
    [2, TEAM2.map(e => ({ ...e }))]] }));
  await RS.collectRosterSnapshots({ network: false, now: () => '2026-09-13T15:00:00.000Z' });
  assert.equal(rows(`SELECT COUNT(*) AS n FROM league_roster_snapshots WHERE scoring_period_id = 1`)[0].n, 6);
  // ... then the period rolls over; 109 was cut before the period ended.
  setPayload(leaguePayload({ period: 2, teams: [[1, TEAM1], [2, TEAM2]] }));
  const out = await RS.collectRosterSnapshots({ fetchImpl: mockFetch({ 1: WEEK1 }, []), now: () => '2026-09-16T15:00:00.000Z' });
  const fin = out.leagues[0].final[0];
  assert.equal(fin.period, 1);
  assert.equal(fin.dropped, 1, '109 was on the roster in a live capture but not at the end of the period');
  const week1 = rows(`SELECT * FROM league_roster_snapshots WHERE scoring_period_id = 1 ORDER BY espn_player_id`);
  assert.equal(week1.find(r => r.espn_player_id === 101).source, 'final');
  assert.equal(week1.find(r => r.espn_player_id === 101).actual_points, 18.4);
  assert.equal(week1.find(r => r.espn_player_id === 109).on_roster, 0);
});

test('G2e: a live payload for an already finalized period never overwrites the final rows', async () => {
  resetLeague(leaguePayload({ teams: [[1, TEAM1], [2, TEAM2]] }));
  await RS.collectRosterSnapshots({ fetchImpl: mockFetch({ 1: WEEK1 }, []), now: () => '2026-09-18T15:00:00.000Z' });
  const before = rows(`SELECT * FROM league_roster_snapshots WHERE scoring_period_id = 1 ORDER BY espn_player_id`);
  // A stale or replayed payload that still says period 1.
  setPayload(leaguePayload({ period: 1, teams: [[1, [entry(101, 20, { period: 1 })]], [2, TEAM2]] }));
  const out = await RS.collectRosterSnapshots({ network: false, now: () => '2026-09-18T15:30:00.000Z' });
  assert.match(out.leagues[0].live.skipped, /final/);
  assert.deepEqual(rows(`SELECT * FROM league_roster_snapshots WHERE scoring_period_id = 1 ORDER BY espn_player_id`), before);
});

test('G2e: a starter total that disagrees with ESPN\'s score is reported, not hidden', async () => {
  resetLeague(leaguePayload({ teams: [[1, TEAM1], [2, TEAM2]] }));
  const bad = structuredClone(WEEK1);
  bad.schedule[0].home.totalPoints = 99.99;
  const out = await RS.collectRosterSnapshots({ fetchImpl: mockFetch({ 1: bad }, []) });
  assert.deepEqual(out.leagues[0].final[0].mismatched_teams, [{ team_id: 1, starters: 29.5, espn_total: 99.99 }]);
  assert.equal(out.status, 'partial');
});

test('G2f: a network failure keeps the live capture and is recorded as partial with the reason', async () => {
  resetLeague(leaguePayload({ teams: [[1, TEAM1], [2, TEAM2]] }));
  const out = await RS.collectRosterSnapshots({ fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(out.status, 'partial');
  assert.equal(out.leagues[0].live.inserted, 7, 'live capture still written');
  assert.match(out.leagues[0].final[0].error, /ECONNRESET/);
  RS.recordRosterSnapshotRun(out);
  const log = rows(`SELECT last_status, last_detail FROM sync_log WHERE job = 'roster_snapshots'`)[0];
  assert.equal(log.last_status, 'partial');
  assert.match(log.last_detail, /ECONNRESET/);
  assert.doesNotMatch(log.last_detail, /test-s2|TEST-SWID/, 'credentials never reach the log');
});

test('G2: an ESPN error status is a failure of that period, and the next tick retries it', async () => {
  resetLeague(leaguePayload({ teams: [[1, TEAM1], [2, TEAM2]] }));
  const first = await RS.collectRosterSnapshots({ fetchImpl: mockFetch({}, []) });
  assert.match(first.leagues[0].final[0].error, /404/);
  const calls = [];
  const second = await RS.collectRosterSnapshots({ fetchImpl: mockFetch({ 1: WEEK1 }, calls) });
  assert.equal(calls.length, 1);
  assert.equal(second.leagues[0].final[0].inserted, 7);
});

test('G2: a period is complete once every matchup in it is decided, even before ESPN rolls the period over', async () => {
  resetLeague(leaguePayload({ period: 2, decided: { 2: 'AWAY' }, teams: [[1, TEAM1], [2, TEAM2]] }));
  const calls = [];
  await RS.collectRosterSnapshots({ fetchImpl: mockFetch({ 1: WEEK1, 2: boxscore(2, [[1, [[101, 0, 5]]], [2, [[201, 0, 6]]]]) }, calls) });
  assert.deepEqual(calls.map(c => new URL(c.url).searchParams.get('scoringPeriodId')).sort(), ['1', '2']);
});

// ---------------------------------------------------------------- the script
const scriptEnv = () => ({ ...process.env, GRIDIRON_DB_PATH: DB_FILE, SCHEDULER_DISABLED: '1' });

test('G2: the script end to end — migrations, capture, sync_log row, exit 0 with --no-network', () => {
  resetLeague(leaguePayload({ teams: [[1, TEAM1], [2, TEAM2]] }));
  const offline = spawnSync(process.execPath, ['scripts/collect-roster-snapshots.mjs', '--no-network'],
    { cwd: REPO, env: scriptEnv(), encoding: 'utf8', timeout: 60_000 });
  assert.equal(offline.status, 0, offline.stdout + offline.stderr);
  assert.match(offline.stdout, /roster_snapshots: ok/);
  assert.equal(rows(`SELECT last_status FROM sync_log WHERE job = 'roster_snapshots'`)[0].last_status, 'ok');
  assert.equal(rows(`SELECT COUNT(*) AS n FROM league_roster_snapshots`)[0].n, 7);
});

// Only under the suite's offline guard (NODE_OPTIONS carries it into the child), so this
// never sends the fixture's fake cookies to ESPN.
test('G2f: the script exits 1 and records partial when ESPN cannot be reached',
  { skip: /offline-guard/.test(process.env.NODE_OPTIONS ?? '') ? false : 'needs the offline guard in NODE_OPTIONS' }, () => {
    resetLeague(leaguePayload({ teams: [[1, TEAM1], [2, TEAM2]] }));
    const online = spawnSync(process.execPath, ['scripts/collect-roster-snapshots.mjs'],
      { cwd: REPO, env: scriptEnv(), encoding: 'utf8', timeout: 60_000 });
    assert.equal(online.status, 1, online.stdout + online.stderr);
    assert.match(online.stdout, /roster_snapshots: partial/);
    assert.doesNotMatch(online.stdout + online.stderr, /test-s2|TEST-SWID/);
    assert.equal(rows(`SELECT last_status FROM sync_log WHERE job = 'roster_snapshots'`)[0].last_status, 'partial');
  });
