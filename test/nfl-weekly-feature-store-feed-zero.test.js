/**
 * The FTN charting/formations feed writes a LITERAL 0 (not a blank cell)
 * for `defenders_in_box` and `defense_box` on plays it did not measure —
 * confirmed against real 2024 FTN data (see coordinator evidence, 11,601
 * such rows out of 48,031, zero blank cells among them). `num()` in
 * nfl-formations.js correctly parses that literal "0" as the number 0, not
 * null, since a real box count of 0 is indistinguishable from an unmeasured
 * one at the ingest layer. That means an unguarded `AVG(defenders_in_box)`
 * here silently averages sentinel zeros in with real box counts, dragging
 * the mean down. `AVG(c.contested)` is deliberately left alone: 0 there is
 * a genuine measured "not contested", not a sentinel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-feed-zero-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { __test: featureTest } = await import('../server/services/nfl-weekly-feature-store.js');

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
// Participation for a season is published only after its post-season, so a
// team history sees it from the next season on (teamHistory; see
// team-history-participation-as-of.test.js). The 2025 week-1 plays below are
// therefore read from a 2026 week-1 history, not a 2025 week-2 one.
const TARGET = [2026, 1, 'KC'];
// Real box counts: 6, 7, 8. Sentinel "uncounted" plays: two literal zeros.
const BOXES = [6, 7, 8, 0, 0];
// Real charted defense_box counts: 5, 9. One sentinel zero.
const CHARTED_BOX = [5, 9, 0];
// contested is a real boolean measurement: two "not contested" (0), one "contested" (1).
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

test('defenders_in_box history excludes literal-zero sentinel plays from the average', () => {
  const history = featureTest.teamHistory(...TARGET);
  const week1 = history.find(item => item.season === 2025 && item.week === 1);
  assert.ok(week1, 'week 1 formation history must be present');
  // Sentinel-contaminated average would be (6+7+8+0+0)/5 = 4.2.
  // Correctly-guarded average of only the real counts is (6+7+8)/3 = 7.
  assert.equal(week1.values.formation_defenders_in_box, 7);
});

test('charted defense_box history excludes literal-zero sentinel plays from the average', () => {
  const history = featureTest.teamHistory(...TARGET);
  const week1 = history.find(item => item.season === 2025 && item.week === 1);
  assert.ok(week1, 'week 1 charting history must be present');
  // Sentinel-contaminated average would be (5+9+0)/3 = 4.667.
  // Correctly-guarded average of only the real counts is (5+9)/2 = 7.
  assert.equal(week1.values.charting_charted_box, 7);
});

test('contested stays a real rate over every charted play, sentinel guard untouched', () => {
  const history = featureTest.teamHistory(...TARGET);
  const week1 = history.find(item => item.season === 2025 && item.week === 1);
  // contested_share must still be measured over all 3 charted plays: 1/3.
  assert.equal(week1.values.charting_contested_share, 1 / 3);
});
