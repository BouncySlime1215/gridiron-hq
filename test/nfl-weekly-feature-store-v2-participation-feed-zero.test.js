/**
 * nflverse's pbp_participation feed sentinel-writes a literal 0 for BOTH
 * defenders_in_box and number_of_pass_rushers on a play it did not measure,
 * exactly like FTN's own charting file -- confirmed against real 2024 data
 * (45,919 rows): 9,214 rows have defenders_in_box=0 AND
 * number_of_pass_rushers=0 simultaneously, only 14 rows are genuinely NULL
 * for both, and 0 rows show one sentinel-zero paired with a real value on
 * the other column. defenders_in_box=0 never happens on a real snap, so
 * that pairing is the "measured nothing" signature, not two independent
 * real zeros. participation()'s team-level averages (off_box_faced,
 * def_box, off_rushers_faced, def_rushers) read these two raw columns
 * straight through finite()+add(), which only skips a true SQL NULL --
 * so the sentinel zeros were silently pulling both averages down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-participation-feed-zero-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'app.sqlite');
const satellitePath = path.join(temp, 'nflverse.sqlite');
process.env.NFLVERSE_DB_PATH = satellitePath;

const satellite = new DatabaseSync(satellitePath);
satellite.exec(`CREATE TABLE pbp_participation (
  nflverse_game_id TEXT, play_id INTEGER, defense_man_zone_type TEXT,
  defense_coverage_type TEXT, defenders_in_box INTEGER, number_of_pass_rushers INTEGER,
  was_pressure INTEGER, time_to_throw REAL, offense_personnel TEXT, defense_personnel TEXT,
  offense_players TEXT, offense_positions TEXT)`);
satellite.exec(`CREATE TABLE play_by_play (
  game_id TEXT, play_id INTEGER, season INTEGER, week INTEGER, season_type TEXT,
  posteam TEXT, defteam TEXT, qb_dropback INTEGER, pass_attempt INTEGER, rush_attempt INTEGER,
  receiver_player_id TEXT, complete_pass INTEGER, receiving_yards REAL)`);

const GAME = '2025_01_KC_SF';
// Real dropback plays: pass_rushers 4,5,6 and defenders_in_box 6,7,8.
// Sentinel "measured nothing" dropback plays: both columns literally 0.
const REAL = [{ box: 6, rushers: 4 }, { box: 7, rushers: 5 }, { box: 8, rushers: 6 }];
const SENTINEL = [{ box: 0, rushers: 0 }, { box: 0, rushers: 0 }];
const rows = [...REAL, ...SENTINEL];
const insertPar = satellite.prepare(`INSERT INTO pbp_participation
  (nflverse_game_id,play_id,defenders_in_box,number_of_pass_rushers) VALUES (?,?,?,?)`);
const insertPbp = satellite.prepare(`INSERT INTO play_by_play
  (game_id,play_id,season,week,season_type,posteam,defteam,qb_dropback) VALUES (?,?,?,?,?,?,?,?)`);
rows.forEach((row, i) => {
  insertPar.run(GAME, i, row.box, row.rushers);
  insertPbp.run(GAME, i, 2025, 1, 'REG', 'KC', 'SF', 1);
});
satellite.close();

const { db } = await import('../server/db/index.js');
const { buildTeamFeatureVector } = await import('../server/services/nfl-weekly-feature-store-v2.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('participation() box and pass-rusher team averages exclude sentinel zero-writes', () => {
  const result = buildTeamFeatureVector(2025, 2, 'KC');
  assert.equal(result.error, undefined, JSON.stringify(result));
  // Sentinel-contaminated: box would be (6+7+8+0+0)/5=4.2, rushers (4+5+6+0+0)/5=3.
  // Correctly-guarded: box (6+7+8)/3=7, rushers (4+5+6)/3=5.
  assert.equal(result.vector['part_off_box_faced__latest'], 7);
  assert.equal(result.vector['part_off_rushers_faced__latest'], 5);
});
