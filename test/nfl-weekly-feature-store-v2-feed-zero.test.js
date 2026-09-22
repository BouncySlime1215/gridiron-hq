/**
 * Same feed-zero contamination as nfl-weekly-feature-store.js, character-for-
 * character: nfl-weekly-feature-store-v2.js's teamHistory() carries the
 * identical unguarded AVG(defenders_in_box) / AVG(c.defense_box) queries.
 * v2 is a study-only copy with no server callers (see the file's own
 * top-of-file note), but scripts/backfill-feature-store.mjs and
 * scripts/grade-feature-vector.mjs run it against the study sqlite, so the
 * same fix applies here to keep both copies correct rather than leaving one
 * silently wrong. See test/nfl-weekly-feature-store-feed-zero.test.js for
 * the full rationale.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-feed-zero-v2-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { __test: featureTest } = await import('../server/services/nfl-weekly-feature-store-v2.js');

db.exec(`CREATE TABLE IF NOT EXISTS nfl_play_formations (
  game_id TEXT NOT NULL, play_id INTEGER NOT NULL, season INTEGER,
  possession TEXT, offense_formation TEXT, offense_personnel TEXT,
  defense_personnel TEXT, defenders_in_box INTEGER, pass_rushers INTEGER,
  PRIMARY KEY (game_id, play_id))`);
db.exec(`CREATE TABLE IF NOT EXISTS nfl_play_charting (
  game_id TEXT NOT NULL, play_id INTEGER NOT NULL, season INTEGER, week INTEGER,
  qb_location TEXT, backfield INTEGER, defense_box INTEGER,
  no_huddle INTEGER, motion INTEGER, play_action INTEGER, screen INTEGER,
  rpo INTEGER, trick INTEGER, out_of_pocket INTEGER, throw_away INTEGER,
  contested INTEGER, PRIMARY KEY (game_id, play_id))`);

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const GAME = '2025_01_KC_SF';
const BOXES = [6, 7, 8, 0, 0];
const CHARTED_BOX = [5, 9, 0];
const CONTESTED = [0, 0, 1];

for (let i = 0; i < BOXES.length; i++) {
  run(`INSERT INTO nfl_play_formations
    (game_id,play_id,season,possession,offense_formation,defenders_in_box,pass_rushers)
    VALUES (?,?,?,?,?,?,?)`, GAME, i, 2025, 'KC', 'SHOTGUN', BOXES[i], 4);
}
for (let i = 0; i < CHARTED_BOX.length; i++) {
  run(`INSERT INTO nfl_play_charting
    (game_id,play_id,season,week,defense_box,contested)
    VALUES (?,?,?,?,?,?)`, GAME, i, 2025, 1, CHARTED_BOX[i], CONTESTED[i]);
}

test('v2 defenders_in_box history excludes literal-zero sentinel plays from the average', () => {
  const history = featureTest.teamHistory(2025, 2, 'KC');
  const week1 = history.find(item => item.season === 2025 && item.week === 1);
  assert.ok(week1, 'week 1 formation history must be present');
  assert.equal(week1.values.formation_defenders_in_box, 7);
});

test('v2 charted defense_box history excludes literal-zero sentinel plays from the average', () => {
  const history = featureTest.teamHistory(2025, 2, 'KC');
  const week1 = history.find(item => item.season === 2025 && item.week === 1);
  assert.ok(week1, 'week 1 charting history must be present');
  assert.equal(week1.values.charting_charted_box, 7);
});

test('v2 contested stays a real rate over every charted play, sentinel guard untouched', () => {
  const history = featureTest.teamHistory(2025, 2, 'KC');
  const week1 = history.find(item => item.season === 2025 && item.week === 1);
  assert.equal(week1.values.charting_contested_share, 1 / 3);
});
