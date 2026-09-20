/**
 * A depth chart is a listing, not a measurement, and this app has three of them
 * that are not interchangeable.
 *
 * The trap is that the table whose name most invites use is the stale one:
 *
 *   - `nfl_depth` — weekly, with a `captured` timestamp per row.
 *   - `off_sleeper_players` — a live snapshot with `fetched_at`, current season
 *     only, no history at all.
 *   - `off_depth_chart` — 13,864 rows across 2021-2026, and
 *     `docs/reference/fantasy/OFFSEASON_DATA.md:54` documents it as
 *     **"Opening-week ordering only"**, with `:78` adding that a March chart
 *     "predates free agency and the draft".
 *
 * So `SELECT ... FROM off_depth_chart` — the obvious query, by name — renders an
 * ordering taken before the roster existed, as though it were this week's. That
 * is a listing wearing the authority of a measurement, which Coach's stat
 * lexicon already warns about for this quantity, made worse by being a listing
 * from the wrong year's roster.
 *
 * The rule these tests pin: take the freshest source that has the team, say
 * which one it is and when it was captured, never show an opening-week chart
 * without saying so, put snap share beside the rank because snap share is the
 * measurement that settles an argument with the listing, and say so plainly when
 * there is no chart rather than rendering an empty panel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-depth-chart-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { run, db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const SEASON = 2026, WEEK = 2, TEAM = 'KC';
run(`INSERT INTO nfl_teams (abbr, name, conference, division) VALUES (?, 'Kansas City', 'AFC', 'West')`, TEAM);
run(`INSERT INTO players (id, name, position, gsis_id, fantasy_relevant) VALUES (1, 'First Receiver', 'WR', '00-0000001', 1)`);
run(`INSERT INTO players (id, name, position, gsis_id, fantasy_relevant) VALUES (2, 'Second Receiver', 'WR', '00-0000002', 1)`);

const clear = () => {
  for (const t of ['nfl_depth', 'off_sleeper_players', 'off_depth_chart', 'player_week_snaps']) {
    db.prepare(`DELETE FROM ${t === 'player_week_snaps' ? 'player_week_snaps' : t}`).run();
  }
};

const seedOpening = () => run(
  `INSERT INTO off_depth_chart (season, team, gsis_id, pos_abb, pos_rank, player_name, source_dt)
   VALUES (?,?,?,?,?,?,?)`, SEASON, TEAM, '00-0000001', 'WR', 1, 'First Receiver', '2026-03-14');
const seedWeekly = (captured = '2026-09-19T12:00:00Z') => run(
  `INSERT INTO nfl_depth (season, week, team, gsis_id, player_name, pos_abb, pos_rank, captured)
   VALUES (?,?,?,?,?,?,?,?)`, SEASON, WEEK, TEAM, '00-0000002', 'Second Receiver', 'WR', 1, captured);
const seedSleeper = (fetched = '2026-09-20T06:00:00Z') => run(
  `INSERT INTO off_sleeper_players (sleeper_id, gsis_id, full_name, position, team, depth_chart_position, depth_chart_order, fetched_at)
   VALUES ('s1','00-0000001','First Receiver','WR',?,'WR',1,?)`, TEAM, fetched);

const { teamDepthChart } = await import('../server/services/depth-chart.js');

test('D1: with nothing on file the panel is told there is no chart, not handed an empty list', () => {
  clear();
  const out = teamDepthChart(TEAM, { season: SEASON, week: WEEK, currentSeason: SEASON });
  assert.equal(out.source, null);
  assert.equal(out.unavailable_reason, 'no_chart_on_file');
  assert.deepEqual(out.positions, []);
});

test('D2: an opening-week chart is served, and is labelled as one', () => {
  clear(); seedOpening();
  const out = teamDepthChart(TEAM, { season: SEASON, week: WEEK, currentSeason: SEASON });
  assert.equal(out.source, 'opening_week');
  assert.equal(out.stale, true,
    'a March ordering is being served without being marked as one');
  assert.equal(out.captured, '2026-03-14');
});

test('D3: the weekly chart beats the opening-week one', () => {
  clear(); seedOpening(); seedWeekly();
  const out = teamDepthChart(TEAM, { season: SEASON, week: WEEK, currentSeason: SEASON });
  assert.equal(out.source, 'weekly');
  assert.equal(out.stale, false);
  assert.equal(out.captured, '2026-09-19T12:00:00Z');
});

test('D4: the freshest wins on the timestamp, not on a fixed ranking of the tables', () => {
  // Sleeper fetched today, the weekly chart captured yesterday.
  clear(); seedWeekly('2026-09-19T12:00:00Z'); seedSleeper('2026-09-20T06:00:00Z');
  assert.equal(teamDepthChart(TEAM, { season: SEASON, week: WEEK, currentSeason: SEASON }).source, 'live_snapshot');
  // And the other way round, so this is a comparison and not a preference.
  clear(); seedWeekly('2026-09-20T12:00:00Z'); seedSleeper('2026-09-19T06:00:00Z');
  assert.equal(teamDepthChart(TEAM, { season: SEASON, week: WEEK, currentSeason: SEASON }).source, 'weekly');
});

test('D5: snap share rides beside the rank, as a fraction, because it is what settles the argument', () => {
  clear(); seedWeekly();
  run(`INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (2,?,?,44,0.82)`, SEASON, WEEK);
  const out = teamDepthChart(TEAM, { season: SEASON, week: WEEK, currentSeason: SEASON });
  const entry = out.positions[0].players[0];
  assert.equal(entry.rank, 1);
  assert.equal(entry.snap_share, 0.82,
    'the snap share is not a fraction — it must match every other reader of this quantity');
});

test('D6: a listed player with no snap share is null, never zero', () => {
  // Zero snaps and "we have no snap row for him" are different facts, and zero
  // is the one that makes a listed starter look benched.
  clear(); seedWeekly();
  const entry = teamDepthChart(TEAM, { season: SEASON, week: WEEK, currentSeason: SEASON }).positions[0].players[0];
  assert.equal(entry.snap_share, null);
});

test('D7: the chart says which players it is ordering, grouped by position', () => {
  clear(); seedWeekly();
  run(`INSERT INTO nfl_depth (season, week, team, gsis_id, player_name, pos_abb, pos_rank, captured)
       VALUES (?,?,?,'00-0000001','First Receiver','RB',1,'2026-09-19T12:00:00Z')`, SEASON, WEEK, TEAM);
  const out = teamDepthChart(TEAM, { season: SEASON, week: WEEK, currentSeason: SEASON });
  assert.deepEqual(out.positions.map(p => p.pos).sort(), ['RB', 'WR']);
});

test('D8: the live snapshot is not used unless the caller says this season is the current one', () => {
  // Sleeper publishes one snapshot and no history, so it carries no season of
  // its own. A caller that has not said which season is current cannot be shown
  // it — stamping today's chart onto a past year is a leak, not a fallback.
  clear(); seedOpening(); seedSleeper('2026-09-20T06:00:00Z');
  assert.equal(teamDepthChart(TEAM, { season: SEASON, week: WEEK }).source, 'opening_week',
    'the live snapshot was used without anyone establishing that it is current');
  assert.equal(teamDepthChart(TEAM, { season: SEASON, week: WEEK, currentSeason: 2025 }).source, 'opening_week',
    'a snapshot with no season was served for a season it cannot be known to cover');
  assert.equal(teamDepthChart(TEAM, { season: SEASON, week: WEEK, currentSeason: SEASON }).source, 'live_snapshot');
});
