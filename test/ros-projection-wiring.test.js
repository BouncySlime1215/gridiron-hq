/**
 * trade-engine.js#buildAssetUniverse takes rest-of-season value from
 * ros-projection.js, and ONLY rest-of-season value.
 *
 * Journey J3 of the ros-projection TDD run: this week's number stays the weekly
 * blend (Start/Sit is untouched), while ros_ppg, playoff_ppg and the adj_ppg that
 * trades, waiver stashes and roster risk read come from the ROS model. The ROS module
 * is mocked here so the test isolates the wiring; its own behaviour is covered by
 * test/ros-projection.test.js.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ros-wiring-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
// PROJ-ESPN: this file tests OUR weekly producer (the path GRIDIRON_PROJ_ESPN=0 serves; with
// the flag on, ours is the shadow and test/proj-espn.test.js covers the served ESPN number).
process.env.GRIDIRON_PROJ_ESPN = '0';

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { seedIfEmpty } = await import('../server/db/seed/index.js');
seedIfEmpty();
// Every seeded team plays every week, so this week's game and the playoff weeks exist
// (matchupModel() caches the slate per process: this lands before the first build).
run(`INSERT OR IGNORE INTO schedule_games (season, team_id, week, opponent_abbr, home)
     SELECT 2026, t.id, w.week, t.abbr, 1 FROM nfl_teams t
     JOIN (WITH RECURSIVE n(week) AS (SELECT 1 UNION ALL SELECT week + 1 FROM n WHERE week < 18) SELECT week FROM n) w`);

// The mock is registered BEFORE the route imports below: routes/tradelab.js imports
// trade-engine.js, which would otherwise bind the real ros-projection.js first.
const rosCalls = [];
let rosMap = new Map();
// FIX-318-1: keep the real module's other exports (projection-asof.js imports ROS_PARAMS, rosUpdate, ...).
const realRos = await import('../server/services/ros-projection.js');
mock.module('../server/services/ros-projection.js', {
  namedExports: {
    ...realRos,
    buildRosProjections: args => { rosCalls.push(args); return rosMap; }
  }
});

// Side-effect imports: assetUniverse() reads tables these route files create on import.
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const { assetUniverse } = await import('../server/services/trade-engine.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('ros_ppg, playoff_ppg and adj_ppg come from the ROS model; this week stays the weekly number', () => {
  const [hot, plain] = rows(`SELECT p.id, p.name FROM players p JOIN nfl_teams t ON t.id = p.team_id
                             WHERE p.position = 'WR' AND p.fantasy_relevant = 1 ORDER BY p.id LIMIT 2`);
  assert.ok(hot && plain, 'the seed needs two fantasy-relevant WRs on NFL teams');
  // vorBoard's season projection: 300/17 = 17.65 per game for the weekly fallback.
  run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games) VALUES (?,2026,'projected',300,17)`, hot.id);
  run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games) VALUES (?,2026,'projected',170,17)`, plain.id);
  rosMap = new Map([[hot.id, {
    ros_ppg: 9.5, games: 1, season_to_date: 29.9, prior: 8.4, prior_source: 'c_mkt',
    structural: 11, weight_in_season: 0.1, alpha: 0.3, k: 6
  }]]);

  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, roster_positions, connection_status)
       VALUES (901, 'espn', 'ros-wiring', 2026, 'ROS wiring', ?, 10, '1', ?, 'connected')`,
  JSON.stringify({ teams: [] }), JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));
  const lg = row('SELECT * FROM leagues WHERE id = 901');
  const assets = assetUniverse(lg, 'rd_sf1_t10_ppr1', { season: 2026, week: 2 });

  // The ROS model is asked once, for this league-week, with the weekly engine's map.
  assert.equal(rosCalls.length, 1);
  assert.equal(rosCalls[0].season, 2026);
  assert.equal(rosCalls[0].week, 2);
  assert.ok(rosCalls[0].weekly instanceof Map, 'the weekly engine map is passed through');
  assert.ok(rosCalls[0].scoring, 'the league scoring is passed through');

  const a = assets.get(hot.id);
  assert.equal(a.ppg, 17.65, 'the weekly number is unchanged');
  assert.equal(a.ros_ppg, 9.5, 'rest-of-season comes from ros-projection.js');
  assert.ok(Math.abs(a.adj_ppg - (0.25 * a.current_week_ppg + 0.75 * 9.5)) <= 0.011,
    `adj_ppg ${a.adj_ppg} should be 0.25*${a.current_week_ppg} + 0.75*9.5`);
  assert.ok(a.playoff_game_share > 0, 'fixture teams play in the playoff weeks');
  assert.ok(Math.abs(a.playoff_ppg - 9.5 * a.playoff_game_share) <= 0.011, 'playoff_ppg is on the ROS basis');
  assert.equal(a.ros_basis.games, 1);
  assert.equal(a.ros_basis.prior, 8.4);
  assert.equal(a.ros_basis.prior_source, 'c_mkt');

  // No ROS entry (outside the graded population): the existing weekly basis is kept.
  const b = assets.get(plain.id);
  assert.equal(b.ros_ppg, b.ppg);
  assert.equal(b.ros_basis, null);
});
