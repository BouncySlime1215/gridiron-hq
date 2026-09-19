/**
 * The engine's audit record reports the weight vector that actually ran.
 *
 * W0 (early-week blend, docs/tdd/early-week-blend.tdd.md, known gap 1): weeks 2-4
 * price a player with 1-3 in-season games on the early bucket's vector, and
 * weeklyEnsembleMode already says `early_week_bucket_1`, but
 * player-week-engine.js recorded `engine.weights = weightChampion.weights[position]`
 * — fit-1's weeks 5-18 vector, which did not produce the number. The explanation
 * built from it (explainPlayerWeek().weights) therefore described the wrong blend.
 *
 * The weight store and the structural head are mocked; the engine itself is real.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-engine-weights-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const LIVE = [0.2, 0.3, 0.2, 0.1, 0.2];
const EARLY_1 = [0.6, 0.4, 0, 0, 0];
const WEIGHTS = {
  QB: LIVE, RB: LIVE, WR: LIVE, TE: LIVE,
  early: { weeks: [2, 4], buckets: { 1: { QB: EARLY_1, RB: EARLY_1, WR: EARLY_1, TE: EARLY_1 } } }
};

const realStore = await import('../server/services/weekly-weight-store.js');
const realProjections = await import('../server/services/projections.js');
mock.module('../server/services/weekly-weight-store.js', {
  namedExports: {
    ...realStore,
    activeWeeklyWeightSet: () => ({ id: 'fit-test', weights: WEIGHTS, source: 'adaptive' })
  }
});
const structural = (id, name, position, ppg) => [id, {
  player_id: id, name, position, ppg, team: null, gsis_id: null, evidence_games: 17, params: null
}];
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: () => new Map([
      structural(1, 'Early Receiver', 'WR', 10),
      structural(2, 'Veteran Receiver', 'WR', 12)
    ])
  }
});

const { buildPlayerWeekEngine } = await import('../server/services/player-week-engine.js');
const E = await import('../server/services/weekly-ensemble.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Player 1 has one 2026 game before week 2 (early bucket 1); player 2 has five
// games before week 6 (live vector).
run(`INSERT INTO players (id, name, position) VALUES (1, 'Early Receiver', 'WR'), (2, 'Veteran Receiver', 'WR')`);
run(`INSERT INTO player_week_usage (player_id, season, week, team, position, targets, receptions, receiving_yards)
     VALUES (1, 2026, 1, 'AAA', 'WR', 8, 6, 80)`);
for (let w = 1; w <= 5; w++) {
  run(`INSERT INTO player_week_usage (player_id, season, week, team, position, targets, receptions, receiving_yards)
       VALUES (2, 2026, ?, 'BBB', 'WR', 7, 5, 60)`, w);
}

test('an early-week player records the early bucket vector that produced his number', () => {
  const engine = buildPlayerWeekEngine({ season: 2026, week: 2, useCache: false });
  const rec = engine.get(1).player_week_engine;
  assert.equal(rec.mode, 'early_week_bucket_1');
  assert.deepEqual(rec.weights, EARLY_1);
  assert.deepEqual(rec.weights, E.weeklyEnsembleWeightsFor(rec.heads, WEIGHTS));
  const explained = engine.get(1).model_reasoning.weights;
  assert.equal(explained.structural, 0.6);
  assert.equal(explained.season_to_date, 0.4);
});

test('a player with four or more games records the live position vector, as before', () => {
  const engine = buildPlayerWeekEngine({ season: 2026, week: 6, useCache: false });
  const rec = engine.get(2).player_week_engine;
  assert.equal(rec.mode, 'position_ensemble');
  assert.deepEqual(rec.weights, LIVE);
});
