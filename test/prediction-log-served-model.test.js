/**
 * The pregame prediction log and the evidence block describe the model that served.
 *
 * review-fixes-2, finding 8 (mle-reviewer). Weeks 2-4 price a player with 1-3 games on
 * fit-2's early bucket, and engine.weights now records that vector (f60c0d2), but:
 *   - captureWeeklyPredictions() hard-coded mode 'position_ensemble' for every row with
 *     heads, so the week-3 and week-4 snapshots label every early-bucket row as the
 *     weeks 5-18 blend it was not priced on;
 *   - explainPlayerWeek() — the grounded evidence block the Coach will cite — calls the
 *     blend "the frozen ensemble" whichever fitted set served.
 *
 * The weight store and the structural head are mocked (the fixture of
 * test/player-week-engine-weights.test.js); the engine, the capture and the explanation
 * are real.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-prediction-log-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const LIVE = [0.2, 0.3, 0.2, 0.1, 0.2];
const EARLY_1 = [1, 0, 0, 0, 0];
const WEIGHTS = {
  QB: LIVE, RB: LIVE, WR: LIVE, TE: LIVE,
  early: { weeks: [2, 4], buckets: { 1: { QB: EARLY_1, RB: EARLY_1, WR: EARLY_1, TE: EARLY_1 } } }
};
let weightSet = { id: 'fit-2', weights: WEIGHTS, source: 'adaptive' };

const realStore = await import('../server/services/weekly-weight-store.js');
const realProjections = await import('../server/services/projections.js');
mock.module('../server/services/weekly-weight-store.js', {
  namedExports: { ...realStore, activeWeeklyWeightSet: () => weightSet }
});
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: () => new Map([[1, {
      player_id: 1, name: 'Early Receiver', position: 'WR', ppg: 10, team: null, gsis_id: null,
      evidence_games: 17, params: null
    }]]),
    // The capture's p10/p90 come from this sampler; its shape is not under test.
    sampleWeeks: (params, n) => new Array(n).fill(10)
  }
});

const { buildPlayerWeekEngine, explainPlayerWeek } = await import('../server/services/player-week-engine.js');
const { captureWeeklyPredictions } = await import('../server/services/weekly-learning.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// One 2026 game before week 2 (early bucket 1); a week-2 slate that has not kicked off.
run(`INSERT INTO players (id, name, position) VALUES (1, 'Early Receiver', 'WR')`);
run(`INSERT INTO player_week_usage (player_id, season, week, team, position, targets, receptions, receiving_yards)
     VALUES (1, 2026, 1, 'AAA', 'WR', 8, 6, 80)`);
run(`INSERT INTO game_lines (season, week, team, opponent, home, gameday, gametime, source, fetched_at)
     VALUES (2026, 2, 'AAA', 'BBB', 1, '2099-09-20', '13:00', 'test', datetime('now'))`);

test('the pregame snapshot records the mode that priced the row, not a hard-coded label', () => {
  const result = captureWeeklyPredictions(2026, 2, { runs: 50 });
  assert.ok(!result.blocked, JSON.stringify(result));
  const stored = rows(`SELECT mode, weight_fit, weights_json FROM weekly_prediction_snapshots
                       WHERE season = 2026 AND week = 2 AND player_id = 1`)[0];
  assert.ok(stored, 'the row is stored');
  assert.equal(stored.mode, 'early_week_bucket_1');
  assert.equal(stored.weight_fit, 'fit-2');
  assert.deepEqual(JSON.parse(stored.weights_json), EARLY_1);
});

test('the evidence block names the weight set that served, never "frozen" for a fitted set', () => {
  const projection = buildPlayerWeekEngine({ season: 2026, week: 2, useCache: false }).get(1);
  const explained = explainPlayerWeek(projection);
  assert.doesNotMatch(explained.summary, /frozen/i);
  assert.match(explained.summary, /fit-2/);
  assert.match(explained.summary, /early-week bucket 1/);
  assert.equal(explained.weight_fit, 'fit-2');
  assert.equal(explained.mode, 'early_week_bucket_1');
});

test('the frozen 2023 weights are still called frozen when they are what served', () => {
  weightSet = { id: 'frozen-2023', weights: { QB: LIVE, RB: LIVE, WR: LIVE, TE: LIVE }, source: 'frozen' };
  try {
    const projection = buildPlayerWeekEngine({ season: 2026, week: 2, useCache: false }).get(1);
    const explained = explainPlayerWeek(projection);
    assert.match(explained.summary, /frozen-2023/);
    assert.equal(explained.mode, 'position_ensemble');
  } finally { weightSet = { id: 'fit-2', weights: WEIGHTS, source: 'adaptive' }; }
});
