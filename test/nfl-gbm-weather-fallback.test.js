import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// buildGbmDataset (boosted_tree, one of the 18 game-level spread experts)
// silently defaulted temp/wind to a fixed calm-60F/5mph day whenever
// game_lines.temp/wind (nflverse's schedule CSV) was null -- which happens
// for a real fraction of outdoor games (86 of 193 outdoor games in season
// 2022 alone). nfl_game_weather (nfl-weather.js) already stores the actual
// kickoff-hour Open-Meteo reading for exactly these games. This test proves
// the dataset now prefers that real reading over the fabricated default.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-gbm-weather-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
await import('../server/services/nfl-weather.js');
await import('../server/services/nfl-pbp.js');
const { buildGbmDataset } = await import('../server/services/nfl-gbm.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT OR IGNORE INTO nfl_teams (abbr,name,conference,division) VALUES
  ('GB','Green Bay Packers','NFC','North'),('CHI','Chicago Bears','NFC','North')`);

// buildGbmDataset requires every KEYS feature to be non-null for both teams
// (falling back to the prior season when the current season has no history
// yet); seed a trivial prior-season (2021) feature row for each team so the
// 2022 week 1/2 games under test are not silently dropped as unusable.
const FEATURE_KEYS = ['off_epa_per_play', 'def_epa_per_play', 'off_success_rate', 'def_success_rate',
  'off_explosive_play_rate', 'def_explosive_play_rate', 'off_turnover_rate', 'def_turnover_rate',
  'off_sack_rate', 'def_sack_rate', 'off_yards_per_play', 'def_yards_per_play',
  'off_third_down_rate', 'def_third_down_rate', 'off_red_zone_td_rate', 'def_red_zone_td_rate',
  'off_drive_td_rate', 'def_drive_td_rate', 'off_plays_per_drive', 'off_seconds_per_drive',
  'off_pass_rate', 'off_proe', 'off_epa_volatility', 'off_early_down_epa', 'def_early_down_epa',
  'off_pressure_epa', 'def_pressure_epa', 'off_havoc_rate', 'def_havoc_rate'];
const flatFeatures = Object.fromEntries(FEATURE_KEYS.map(k => [k, 0.01]));
for (const team of ['GB', 'CHI']) {
  run(`INSERT INTO nfl_team_week_features (season,week,team,opponent,home,features) VALUES (2021,10,?,?,?,?)`,
    team, team === 'GB' ? 'CHI' : 'GB', team === 'GB' ? 1 : 0, JSON.stringify(flatFeatures));
}

// An outdoor game where nflverse's schedule CSV never carried a temp/wind
// reading (temp/wind left NULL), but the Open-Meteo kickoff-hour archive
// (nfl_game_weather) has the real number for this exact season/week/home.
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score,
     temp,wind,roof,div_game,rest_days,source,fetched_at,gameday,gametime)
     VALUES (2022,1,'GB','CHI',1,-3,44,24,17,NULL,NULL,'outdoors',1,7,'test',datetime('now'),'2022-09-11','13:00')`);
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score,
     temp,wind,roof,div_game,rest_days,source,fetched_at,gameday,gametime)
     VALUES (2022,1,'CHI','GB',0,3,44,17,24,NULL,NULL,'outdoors',1,7,'test',datetime('now'),'2022-09-11','13:00')`);
run(`INSERT INTO nfl_game_weather (season,week,home,kickoff,temp_c,wind_kmh,gust_kmh,precip_mm,source,fetched_at)
     VALUES (2022,1,'GB','2022-09-11T17:00:00Z',10,32.2,45,0,'open-meteo-archive',datetime('now'))`);

test('a game missing schedule-CSV temp/wind uses the real Open-Meteo reading, not the fixed 60F/5mph default', () => {
  const data = buildGbmDataset({ fromSeason: 2021, throughSeason: 2022, includeUnsettled: true });
  const row = data.meta.findIndex(m => m.season === 2022 && m.week === 1 && m.home === 'GB');
  assert.ok(row >= 0, 'expected the seeded GB game to appear in the dataset');
  const tempIdx = data.featureNames.indexOf('temp'), windIdx = data.featureNames.indexOf('wind');
  const gbTemp = data.X[row][tempIdx], gbWind = data.X[row][windIdx];
  // 10C -> 50F, 32.2 km/h -> ~20 mph. Neither matches the old fallback (60, 5).
  assert.notEqual(gbTemp, 60, 'temp fell back to the fixed 60F default instead of the real archive reading');
  assert.notEqual(gbWind, 5, 'wind fell back to the fixed 5mph default instead of the real archive reading');
  assert.ok(Math.abs(gbTemp - 50) < 0.5, `expected ~50F from 10C, got ${gbTemp}`);
  assert.ok(Math.abs(gbWind - 20.01) < 0.5, `expected ~20mph from 32.2km/h, got ${gbWind}`);
});

test('a game with no weather anywhere still falls back to the 60F/5mph default (no crash, no fabricated precision)', () => {
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score,
       temp,wind,roof,div_game,rest_days,source,fetched_at,gameday,gametime)
       VALUES (2022,2,'GB','CHI',1,-3,44,24,17,NULL,NULL,'outdoors',1,7,'test',datetime('now'),'2022-09-18','13:00')`);
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score,
       temp,wind,roof,div_game,rest_days,source,fetched_at,gameday,gametime)
       VALUES (2022,2,'CHI','GB',0,3,44,17,24,NULL,NULL,'outdoors',1,7,'test',datetime('now'),'2022-09-18','13:00')`);
  const data = buildGbmDataset({ fromSeason: 2021, throughSeason: 2022, includeUnsettled: true });
  const row = data.meta.findIndex(m => m.season === 2022 && m.week === 2 && m.home === 'GB');
  assert.ok(row >= 0);
  const tempIdx = data.featureNames.indexOf('temp'), windIdx = data.featureNames.indexOf('wind');
  assert.equal(data.X[row][tempIdx], 60);
  assert.equal(data.X[row][windIdx], 5);
});
