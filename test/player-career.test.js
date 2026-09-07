import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-player-career-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { careerLine, careerLines, warmCareerCache, _resetCareerCache, weekPoints } = await import('../server/services/player-career.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026; // upcoming season; 2023-2025 are the completed ones we seed

// Two WRs (a star and a mid-tier) plus a rookie with no completed season.
run(`INSERT INTO players (id, name, position, gsis_id, fantasy_relevant) VALUES
     (1, 'Star Receiver', 'WR', '00-0000001', 1),
     (2, 'Solid Receiver', 'WR', '00-0000002', 1),
     (3, 'Rookie Receiver', 'WR', '00-0000003', 1),
     (4, 'Unlinked Guy', 'RB', NULL, 1)`);

const insert = db.prepare(`INSERT INTO nfl_player_week_features (season, week, player_id, player_name, team, opponent, position, features)
                           VALUES (?, ?, ?, ?, 'CIN', 'CLE', ?, ?)`);
function seedSeason(gsis, name, position, season, weeks, perWeek) {
  for (let w = 1; w <= weeks; w++) {
    insert.run(season, w, gsis, name, position, JSON.stringify(perWeek(w)));
  }
}
const wrWeek = (targets, rec, yds, td) => ({ targets, receptions: rec, receiving_yards: yds, receiving_tds: td, carries: 0, rushing_yards: 0, rushing_tds: 0, pass_attempts: 0, passing_yards: 0, passing_tds: 0, interceptions: 0 });

// Star: 17 games x 100 yds = 1700 rec yds every season; 3 straight 1,000+ seasons,
// 8 targets/game = 136 targets, 6 catches/game = 102, TD every other week.
for (const yr of [2023, 2024, 2025]) seedSeason('00-0000001', 'Star Receiver', 'WR', yr, 17, w => wrWeek(8, 6, 100, w % 2));
// Solid: 2023 had 1,000+ (16 x 70 = 1120), 2024 dipped (12 x 50 = 600), 2025 back over (16 x 70 = 1120)
seedSeason('00-0000002', 'Solid Receiver', 'WR', 2023, 16, () => wrWeek(6, 4, 70, 0));
seedSeason('00-0000002', 'Solid Receiver', 'WR', 2024, 12, () => wrWeek(5, 3, 50, 0));
seedSeason('00-0000002', 'Solid Receiver', 'WR', 2025, 16, () => wrWeek(6, 4, 70, 0));
// Playoff week must be ignored.
insert.run(2025, 19, '00-0000002', 'Solid Receiver', 'WR', JSON.stringify(wrWeek(10, 10, 200, 3)));

test('weekly points use the PPR weights from scoring.js', () => {
  assert.equal(weekPoints({ passing_yards: 300, passing_tds: 2, interceptions: 1, rushing_yards: 20, rushing_tds: 1, receptions: 5, receiving_yards: 50, receiving_tds: 1 }),
    300 * 0.04 + 8 - 2 + 2 + 6 + 5 + 5 + 6);
});

test('season totals, ppg and positional rank are rebuilt from weekly rows', () => {
  _resetCareerCache();
  const line = careerLine(1, { season: SEASON, seasons: 3 });
  assert.equal(line.position, 'WR');
  assert.equal(line.seasons.length, 3);
  assert.deepEqual(line.seasons.map(s => s.season), [2025, 2024, 2023]); // newest first
  const s = line.seasons[0];
  assert.equal(s.games, 17);
  assert.equal(s.rec_yds, 1700);
  assert.equal(s.targets, 136);
  assert.equal(s.rec, 102);
  assert.equal(s.rec_td, 9); // TD on each odd week, 1..17
  // 102 rec + 170 yds pts + 54 td pts
  assert.equal(s.ppr_points, 102 + 170 + 54);
  assert.equal(s.ppg, +((102 + 170 + 54) / 17).toFixed(2));
  assert.equal(s.pos_rank, 1);
  assert.equal(s.fumbles_lost, null);

  const solid = careerLine(2, { season: SEASON, seasons: 3 });
  assert.equal(solid.seasons[0].pos_rank, 2);
  assert.equal(solid.seasons[0].games, 16, 'week 19 (playoffs) must not count');
  assert.equal(solid.seasons[0].rec_yds, 1120);
});

test('an unbroken 3-season 1,000+ rec yds streak is detected', () => {
  const line = careerLine(1, { season: SEASON, seasons: 3 });
  const st = line.streaks.find(x => x.stat === 'rec_yds' && x.threshold === 1000);
  assert.deepEqual(st, { stat: 'rec_yds', threshold: 1000, seasons: 3, streak: 3, consecutive: true, values: [1700, 1700, 1700] });
  const tg = line.streaks.find(x => x.stat === 'targets' && x.threshold === 130);
  assert.equal(tg.streak, 3);
  const g = line.streaks.find(x => x.stat === 'games');
  assert.equal(g.streak, 3);
  assert.equal(line.consistency.seasons_counted, 3);
  assert.equal(line.consistency.seasons_top12, 3);
  assert.equal(line.consistency.min_games, 17);
  assert.equal(line.consistency.cv_points, 0);
});

test('a broken streak counts only the current run', () => {
  const line = careerLine(2, { season: SEASON, seasons: 3 });
  const st = line.streaks.find(x => x.stat === 'rec_yds' && x.threshold === 1000);
  assert.equal(st.seasons, 2, 'met in 2 of the 3 window seasons');
  assert.equal(st.streak, 1, 'only 2025 is in the current run');
  assert.equal(st.consecutive, false);
  assert.deepEqual(st.values, [1120]);
  assert.equal(line.consistency.min_games, 12);
  assert.equal(line.consistency.max_games, 16);
});

test('headline reads as hard evidence', () => {
  const star = careerLine(1, { season: SEASON, seasons: 3 });
  assert.match(star.headline, /1,[24]00\+ rec yds in 3 straight seasons/);
  assert.match(star.headline, /WR top-12 finish 3 of 3 years/);
  const solid = careerLine(2, { season: SEASON, seasons: 3 });
  assert.match(solid.headline, /1,000\+ rec yds in 2 of 3 seasons/);
});

test('trend compares the two most recent seasons', () => {
  const solid = careerLine(2, { season: SEASON, seasons: 3 });
  // 2025: 16*(4+7) = 176 pts; 2024: 12*(3+5) = 96 pts
  assert.equal(solid.trend.points_yoy_pct, Math.round((176 - 96) / 96 * 100));
  assert.equal(solid.trend.role_yoy, 'targets +60%'); // 96 -> 60 targets... (6*16=96 vs 5*12=60)
  const star = careerLine(1, { season: SEASON, seasons: 3 });
  assert.equal(star.trend.points_yoy_pct, 0);
  assert.equal(star.trend.role_yoy, 'targets +0%');
});

test('rookies and unlinked players get an empty line with a null headline', () => {
  const rookie = careerLine(3, { season: SEASON, seasons: 3 });
  assert.equal(rookie.position, 'WR');
  assert.deepEqual(rookie.seasons, []);
  assert.equal(rookie.headline, null);
  assert.deepEqual(rookie.streaks, []);
  assert.equal(rookie.consistency.seasons_counted, 0);
  assert.equal(rookie.trend.points_yoy_pct, null);
  const unlinked = careerLine(4, { season: SEASON, seasons: 3 });
  assert.equal(unlinked.gsis_id, null);
  assert.equal(unlinked.headline, null);
});

test('careerLines batches and the warm cache is reused', () => {
  const c1 = warmCareerCache(SEASON, 3);
  const map = careerLines([1, 2, 3], { season: SEASON, seasons: 3 });
  assert.equal(map.size, 3);
  assert.equal(map.get(1).headline !== null, true);
  assert.equal(warmCareerCache(SEASON, 3), c1, 'same cache object, not rebuilt');
  assert.notEqual(warmCareerCache(SEASON, 5), c1, 'a wider window rebuilds');
  // A raw gsis id also resolves.
  assert.equal(careerLine('00-0000001', { season: SEASON, seasons: 3 }).seasons.length, 3);
});
