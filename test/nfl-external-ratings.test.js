import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The two free external power ratings (nfl-external-ratings.js), parsed
// against real payloads captured on 2026-09-02 and trimmed to four teams, so
// an upstream shape change fails here before it silently empties the table.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-external-ratings-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.NFL_SEASON = '2026';
delete process.env.NFL_WEEK;

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js'); // owns game_lines
const { clearTeamResolverCache } = await import('../server/services/team-codes.js');
const ratings = await import('../server/services/nfl-external-ratings.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Baltimore is deliberately absent so the TeamRankings fixture's fourth row
// exercises the "report, never guess" path.
const TEAMS = [['LAR', 'Los Angeles Rams', 'NFC', 'West'], ['BUF', 'Buffalo Bills', 'AFC', 'East'],
  ['SEA', 'Seattle Seahawks', 'NFC', 'West'], ['WAS', 'Washington Commanders', 'NFC', 'East'],
  ['DET', 'Detroit Lions', 'NFC', 'North'], ['KC', 'Kansas City Chiefs', 'AFC', 'West']];
for (const [abbr, name, conf, div] of TEAMS) {
  run('INSERT OR IGNORE INTO nfl_teams (abbr,name,conference,division) VALUES (?,?,?,?)', abbr, name, conf, div);
}
clearTeamResolverCache();

// 2024 Week 10 opened on Thursday 2024-11-07, so its snapshot day is Wednesday 2024-11-06 — the fixture's date.
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime,team_score,opp_score)
     VALUES (2024,10,'DET','KC',1,-3,48,25.5,'test',datetime('now'),'2024-11-07','20:15',24,20)`);
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime,team_score,opp_score)
     VALUES (2024,10,'KC','DET',0,3,48,22.5,'test',datetime('now'),'2024-11-07','20:15',20,24)`);
// The current week: 2026 Week 1, unplayed, so currentNflWeek() lands on it.
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime)
     VALUES (2026,1,'LAR','BUF',1,-1,47,24,'test',datetime('now'),'2026-09-10','20:20')`);

const fixture = name => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fpiPayload = () => JSON.parse(fixture('espn-fpi.json'));
const fpiValue = abbr => fpiPayload().teams.find(t => t.team.abbreviation === abbr).categories[0].values[0];

function mockFetch(routes) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    const u = String(url);
    calls.push(u);
    for (const [needle, body] of Object.entries(routes)) {
      if (!u.includes(needle)) continue;
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('ESPN FPI sync writes canonical team codes for the requested season and week', async () => {
  const mock = mockFetch({ 'site.web.api.espn.com': fixture('espn-fpi.json') });
  let result;
  try { result = await ratings.syncFpi({ season: 2026, week: 1 }); } finally { mock.restore(); }
  assert.equal(result.written, 4, JSON.stringify(result));
  assert.deepEqual(result.unresolved, []);
  assert.ok(mock.calls[0].includes('season=2026'), 'the season is passed through to ESPN');
  const stored = rows(`SELECT team, rating, detail_json FROM nfl_external_ratings WHERE source='espn_fpi' AND season=2026 AND week=1 ORDER BY team`);
  assert.deepEqual(stored.map(r => r.team), ['BUF', 'LAR', 'SEA', 'WAS'], 'WSH is stored as the canonical WAS');
  const was = JSON.parse(stored.find(r => r.team === 'WAS').detail_json);
  assert.equal(was.espn_abbreviation, 'WSH');
  assert.ok(Number.isFinite(was.epa_offense) && Number.isFinite(was.epa_defense) && Number.isFinite(was.epa_special_teams),
    `the EPA components ride along: ${JSON.stringify(was)}`);
  assert.equal(stored.find(r => r.team === 'LAR').rating, fpiValue('LAR'));
});

test('the FPI feature diff is home minus away and flips sign when the teams swap', () => {
  const expected = fpiValue('LAR') - fpiValue('BUF');
  assert.notEqual(expected, 0, 'fixture teams must differ for the sign check to mean anything');
  const homeLar = ratings.externalRatingsFeatures(2026, 1, 'LAR', 'BUF');
  assert.ok(Math.abs(homeLar.fpi_diff - expected) < 1e-9, `got ${homeLar.fpi_diff}, expected ${expected}`);
  const homeBuf = ratings.externalRatingsFeatures(2026, 1, 'BUF', 'LAR');
  assert.ok(Math.abs(homeBuf.fpi_diff + expected) < 1e-9, 'swapping home and away negates the diff');
  assert.equal(homeLar.teamrankings_diff, null, 'no TeamRankings snapshot for this week yet, so null rather than 0');
  assert.equal(ratings.externalRatingsFeatures(2026, 1, 'WSH', 'SEA').fpi_diff,
    fpiValue('WSH') - fpiValue('SEA'), 'ESPN spelling on the way in is canonicalised too');
});

test('syncFpi defaults to the current NFL week', async () => {
  const mock = mockFetch({ 'site.web.api.espn.com': fixture('espn-fpi.json') });
  let result;
  try { result = await ratings.syncFpi(); } finally { mock.restore(); }
  assert.equal(result.season, 2026);
  assert.equal(result.week, 1, 'Week 1 is the first unplayed week in game_lines');
  assert.equal(result.written, 4);
});

test('an unknown ESPN team is reported, never guessed, and a season mismatch writes nothing', async () => {
  const payload = fpiPayload();
  payload.teams[0].team.abbreviation = 'XXX';
  payload.teams[0].team.displayName = 'Nowhere Nobodies';
  const parsed = ratings.parseFpi(payload);
  assert.equal(parsed.teams.length, 3);
  assert.deepEqual(parsed.unresolved, [{ abbreviation: 'XXX', name: 'Nowhere Nobodies', reason: 'unknown team' }]);

  const mock = mockFetch({ 'site.web.api.espn.com': fixture('espn-fpi.json') }); // says requestedSeason 2026
  let result;
  try { result = await ratings.syncFpi({ season: 2025, week: 18 }); } finally { mock.restore(); }
  assert.equal(result.written, 0);
  assert.match(result.error, /returned season 2026/);
  assert.equal(rows(`SELECT COUNT(*) n FROM nfl_external_ratings WHERE source='espn_fpi' AND season=2025`)[0].n, 0);
});

test('TeamRankings parses the fixture with full-precision ratings, the record and the page date', () => {
  const parsed = ratings.parseTeamRankings(fixture('teamrankings-predictive.html'));
  assert.equal(parsed.as_of, '2024-11-06');
  assert.deepEqual(parsed.columns, ['Rank', 'Team', 'Rating', 'v 1-5', 'v 6-10', 'v 11-16', 'Hi', 'Lo', 'Last']);
  assert.deepEqual(parsed.teams.map(t => t.team), ['DET', 'KC', 'BUF'], 'three resolvable rows, in rank order');
  const det = parsed.teams[0];
  assert.ok(Math.abs(det.rating - 9.91156) < 1e-9, `data-sort 509.91156 minus 500, got ${det.rating}`);
  assert.equal(det.detail.rating_shown, 9.9);
  assert.equal(det.detail.rank, 1);
  assert.equal(det.detail.wins, 7);
  assert.equal(det.detail.losses, 1);
  assert.equal(det.detail.teamrankings_name, 'Detroit');
  assert.equal(det.detail.columns['v 6-10'], '2-0');
  assert.deepEqual(parsed.unresolved, [{ name: 'Baltimore', slug: 'baltimore-ravens', reason: 'unknown team' }],
    'Baltimore is not in nfl_teams here, so it is reported rather than guessed');
});

test('wednesdayOf lands on the Wednesday on or before the gameday', () => {
  assert.equal(ratings.wednesdayOf('2024-11-07'), '2024-11-06', 'Thursday opener');
  assert.equal(ratings.wednesdayOf('2024-11-10'), '2024-11-06', 'Sunday-only week');
  assert.equal(ratings.wednesdayOf('2024-11-06'), '2024-11-06', 'already Wednesday');
  assert.equal(ratings.wednesdayOf('2025-01-04'), '2025-01-01', 'Saturday opener crosses the year');
  assert.equal(ratings.wednesdayOf('not a date'), null);
});

test('TeamRankings sync snapshots the Wednesday of each game week, reports unresolved names, and does not refetch', async () => {
  const mock = mockFetch({ 'teamrankings.com': fixture('teamrankings-predictive.html') });
  let result;
  try { result = await ratings.syncTeamRankings({ seasons: [2024], current: false, pauseMs: 0 }); } finally { mock.restore(); }
  assert.deepEqual(mock.calls, ['https://www.teamrankings.com/nfl/ranking/predictive-by-other/?date=2024-11-06']);
  assert.equal(result.fetched, 1);
  assert.equal(result.written, 3, JSON.stringify(result));
  assert.equal(result.failure_count, 0);
  assert.deepEqual(result.unresolved, [{ name: 'Baltimore', slug: 'baltimore-ravens', reason: 'unknown team', weeks: ['2024 W10'] }]);

  const stored = rows(`SELECT team, rating, detail_json FROM nfl_external_ratings WHERE source='teamrankings_predictive' AND season=2024 AND week=10 ORDER BY rating DESC`);
  assert.deepEqual(stored.map(r => r.team), ['DET', 'KC', 'BUF']);
  assert.equal(JSON.parse(stored[0].detail_json).as_of, '2024-11-06');

  const f = ratings.externalRatingsFeatures(2024, 10, 'DET', 'KC');
  assert.ok(Math.abs(f.teamrankings_diff - (9.91156 - 7.04212)) < 1e-9, `home minus away, got ${f.teamrankings_diff}`);
  assert.ok(ratings.externalRatingsFeatures(2024, 10, 'KC', 'DET').teamrankings_diff < 0, 'sign flips with the venue');
  assert.equal(f.fpi_diff, null, 'no FPI snapshot for 2024 W10, so null rather than 0');

  const again = mockFetch({ 'teamrankings.com': fixture('teamrankings-predictive.html') });
  let second;
  try { second = await ratings.syncTeamRankings({ seasons: [2024], current: false, pauseMs: 0 }); } finally { again.restore(); }
  assert.deepEqual(again.calls, [], 'the Wednesday snapshot is already stored, so no request goes out');
  assert.equal(second.skipped, 1);
});

test('a page that shows a different date than requested is refused, not stored under the wrong week', async () => {
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,gameday,gametime,team_score,opp_score)
       VALUES (2024,11,'KC','BUF',0,2.5,45,21,'test',datetime('now'),'2024-11-14','20:15',21,30)`);
  const mock = mockFetch({ 'teamrankings.com': fixture('teamrankings-predictive.html') }); // still says 11/06/2024
  let result;
  try { result = await ratings.syncTeamRankings({ seasons: [2024], current: false, pauseMs: 0 }); } finally { mock.restore(); }
  assert.deepEqual(mock.calls, ['https://www.teamrankings.com/nfl/ranking/predictive-by-other/?date=2024-11-13']);
  assert.equal(result.written, 0);
  assert.equal(result.failure_count, 1);
  assert.match(result.failures[0].error, /asked for 2024-11-13, page shows 2024-11-06/);
  assert.equal(rows(`SELECT COUNT(*) n FROM nfl_external_ratings WHERE source='teamrankings_predictive' AND season=2024 AND week=11`)[0].n, 0);
});

test('a game with no snapshot at all yields nulls for both sources', () => {
  assert.deepEqual(ratings.externalRatingsFeatures(2019, 3, 'DET', 'KC'), { fpi_diff: null, teamrankings_diff: null });
  assert.deepEqual(ratings.externalRatingsFeatures(2024, 10, 'DET', 'BAL'), { fpi_diff: null, teamrankings_diff: null },
    'one side missing is still null, never a one-sided number');
});

test('status reports per-source, per-season coverage and flags short weeks', () => {
  const status = ratings.externalRatingsStatus();
  const fpi = status.by_source.find(r => r.source === 'espn_fpi' && r.season === 2026);
  assert.equal(fpi.team_weeks, 4);
  assert.equal(fpi.weeks, 1);
  const tr = status.by_source.find(r => r.source === 'teamrankings_predictive' && r.season === 2024);
  assert.equal(tr.team_weeks, 3);
  assert.ok(status.short_weeks.some(w => w.source === 'teamrankings_predictive' && w.season === 2024 && w.week === 10 && w.teams === 3),
    'a week with fewer than 32 teams is surfaced');
});
