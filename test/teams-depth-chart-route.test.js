/**
 * Serving a depth chart over HTTP, where the three-source rule either survives
 * the route or is quietly undone by it.
 *
 * `server/services/depth-chart.js` already refuses to stamp Sleeper's live
 * snapshot onto a past season — but only when the caller tells it which season
 * is actually current. It fails closed on `currentSeason: null`, which means a
 * route that forgets to pass it gets an empty chart rather than a wrong one, and
 * a route that passes `season` as `currentSeason` gets the wrong one for every
 * past year with no warning at all. Both are route defects that no test of the
 * service can see, so they are pinned here.
 *
 * Three further things only the route can get wrong:
 *
 *   - **A team that does not exist.** The service answers `no_chart_on_file`,
 *     which is true and useless: a typo'd abbreviation then renders as "no depth
 *     chart for this team" on a page for a team that is not in the league.
 *   - **Which week it answered for.** The service takes `week` and does not give
 *     it back, so a caller who sent none cannot tell whether it got this week's
 *     snap shares or week 1's.
 *   - **A second query.** The whole point of the module is that
 *     `SELECT ... FROM off_depth_chart` is the wrong query by itself; a route
 *     that reaches past the module to the tables is back where it started.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-depth-chart-route-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
// Pinned so the default season is the fixture's season and not the wall clock's.
process.env.NFL_SEASON = '2026';
delete process.env.NFL_WEEK;

const { run, db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const SEASON = 2026, PAST = 2025, WEEK = 3, TEAM = 'KC';

run(`INSERT INTO nfl_teams (abbr, name, conference, division) VALUES (?, 'Kansas City', 'AFC', 'West')`, TEAM);
run(`INSERT INTO players (id, name, position, gsis_id, fantasy_relevant) VALUES (1, 'First Receiver', 'WR', '00-0000001', 1)`);
run(`INSERT INTO players (id, name, position, gsis_id, fantasy_relevant) VALUES (2, 'Second Receiver', 'WR', '00-0000002', 1)`);

// Weeks 1 and 2 played, week 3 not: currentNflWeek() resolves to week 3 with no
// help from the clock, so "the week the route picked" is a fact of the fixture.
for (const [week, score] of [[1, 24], [2, 17], [WEEK, null]]) {
  run(`INSERT INTO game_lines (season, week, team, opponent, home, team_score) VALUES (?,?,?,?,1,?)`,
    SEASON, week, TEAM, 'LV', score);
}

const clear = () => {
  for (const t of ['nfl_depth', 'off_sleeper_players', 'off_depth_chart', 'player_week_snaps']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
};
const seedOpening = (season = SEASON) => run(
  `INSERT INTO off_depth_chart (season, team, gsis_id, pos_abb, pos_rank, player_name, source_dt)
   VALUES (?,?,?,?,?,?,?)`, season, TEAM, '00-0000001', 'WR', 1, 'First Receiver', '2026-03-14');
const seedWeekly = (week = WEEK, captured = '2026-09-19T12:00:00Z') => run(
  `INSERT INTO nfl_depth (season, week, team, gsis_id, player_name, pos_abb, pos_rank, captured)
   VALUES (?,?,?,?,?,?,?,?)`, SEASON, week, TEAM, '00-0000002', 'Second Receiver', 'WR', 1, captured);
const seedSleeper = () => run(
  `INSERT INTO off_sleeper_players (sleeper_id, gsis_id, full_name, position, team, depth_chart_position, depth_chart_order, fetched_at)
   VALUES ('s1', '00-0000001', 'First Receiver', 'WR', ?, 'WR', 1, '2026-09-20T06:00:00Z')`, TEAM);

const { default: teamsRouter } = await import('../server/routes/teams.js');
const app = express();
app.use(express.json());
app.use('/api/teams', teamsRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const get = url => fetch(base + url);

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('a team that is not in the league is a 404, not an empty depth chart', async () => {
  const res = await get('/api/teams/ZZ/depth-chart');
  assert.equal(res.status, 404,
    'an unknown abbreviation answers as though the team exists and simply has no chart');
  const body = await res.json();
  assert.match(body.error ?? '', /team/i, 'the 404 does not say what was not found');
});

test('the route says which season and week it answered for', async () => {
  clear(); seedWeekly();
  const body = await (await get(`/api/teams/${TEAM}/depth-chart`)).json();
  assert.equal(body.season, SEASON, 'the season the route resolved is not in the payload');
  assert.equal(body.week, WEEK,
    'the week is not reported back, so a caller cannot tell which week the snap shares belong to');
});

test('the default week is the one the schedule is on, not week 1', async () => {
  clear(); seedWeekly(1, '2026-09-05T12:00:00Z'); seedWeekly(WEEK);
  const body = await (await get(`/api/teams/${TEAM}/depth-chart`)).json();
  assert.equal(body.week, WEEK, 'the route invented a week rather than asking the schedule');
  assert.equal(body.captured, '2026-09-19T12:00:00Z',
    'the chart served is not the one captured for the week the route reports');
});

test('an explicit season and week are honoured over the defaults', async () => {
  clear(); seedWeekly(1, '2026-09-05T12:00:00Z');
  const body = await (await get(`/api/teams/${TEAM}/depth-chart?season=${SEASON}&week=1`)).json();
  assert.equal(body.week, 1);
  assert.equal(body.captured, '2026-09-05T12:00:00Z');
});

test('the live snapshot is offered for the current season', async () => {
  clear(); seedOpening(); seedSleeper();
  const body = await (await get(`/api/teams/${TEAM}/depth-chart`)).json();
  assert.equal(body.source, 'live_snapshot',
    'the route did not tell the service which season is current, so the freshest source was withheld');
  assert.equal(body.stale, false);
});

test('a past season is never answered from the live snapshot', async () => {
  clear(); seedSleeper();
  const body = await (await get(`/api/teams/${TEAM}/depth-chart?season=${PAST}&week=1`)).json();
  assert.equal(body.source, null,
    "today's Sleeper snapshot was served as a past season's depth chart");
  assert.equal(body.unavailable_reason, 'no_chart_on_file');
});

test('a past season still gets that year’s own opening chart, labelled stale', async () => {
  clear(); seedOpening(PAST); seedSleeper();
  const body = await (await get(`/api/teams/${TEAM}/depth-chart?season=${PAST}&week=1`)).json();
  assert.equal(body.source, 'opening_week');
  assert.equal(body.stale, true, 'an opening-week chart was served without saying it is one');
});

test('the route reads the depth chart through the module, not around it', () => {
  const src = fs.readFileSync(new URL('../server/routes/teams.js', import.meta.url), 'utf8');
  assert.ok(!/off_depth_chart|off_sleeper_players|nfl_depth\b/.test(src),
    'the route queries a depth table directly, which is the mistake the module exists to prevent');
  assert.match(src, /teamDepthChart/,
    'the depth-chart route does not go through teamDepthChart');
});
