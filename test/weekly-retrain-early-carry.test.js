/**
 * The scheduled weekly retrain must not undo the early-week blend.
 *
 * fit-2 stores the weeks 5-18 vector plus an `early` block (weeks 2-4: structural only
 * for 1-3 prior games). retrainWeeklyWeights() builds a candidate from the four
 * per-position vectors only. Two defects follow:
 *   1. a promoted retrain was saved without `early`, so from the next week on
 *      activeWeeklyWeightSet() served no early buckets and weeks 2-4 went back to the
 *      blend that puts 80% on one game;
 *   2. settled week 2-4 rows were used to fit AND grade the per-position vector,
 *      although production never serves that vector there (the early buckets do). On
 *      the live table — whose only settled rows will be 2026 week 2 — the champion was
 *      graded as fit-1's vector, the blend that is known to lose at week 2, so a
 *      candidate fit on week-2 rows could be promoted and then served at weeks 5-18.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-retrain-early-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows } = await import('../server/db/index.js');
const S = await import('../server/services/weekly-weight-store.js');
const L = await import('../server/services/weekly-learning.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const LIVE = [0.2, 0.4, 0.15000000000000002, 0.05, 0.2];
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const perPosition = vector => Object.fromEntries(POSITIONS.map(p => [p, [...vector]]));
// saveWeeklyFit binds every ledger column; a seeded fit has no evaluation numbers.
const LEDGER = { sample_size: 0, validation_size: 0, candidate_mae: null, champion_mae: null,
  candidate_spearman: null, champion_spearman: null, coverage_80: null };
const EARLY = {
  weeks: [2, 4],
  buckets: {
    1: perPosition([1, 0, 0, 0, 0]),
    2: perPosition([1, 0, 0, 0, 0]),
    3: perPosition([1, 0, 0, 0, 0])
  }
};

function reset() {
  db.exec('DELETE FROM weekly_prediction_snapshots; DELETE FROM weekly_ensemble_fits;');
}

function seedEarlyChampion() {
  S.saveWeeklyFit({
    ...LEDGER, data_hash: `seed-early-${Math.random()}`, through_season: 2025, through_week: 18, promoted: true,
    weights: { ...perPosition(LIVE), early: EARLY }
  });
}

// Deterministic pseudo-random numbers, so the gate outcome is reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/**
 * Settled snapshots where `actual` equals the head named by `truth`. Exactly one row
 * in five has an 80% interval that misses (shifted or not), so a candidate that
 * predicts `truth` exactly has coverage 0.80 on any whole number of weeks.
 */
function insertSettled({ season, weeks, players, truth, served = 'live' }) {
  const next = rng(season * 100 + weeks[0]);
  const insert = db.prepare(`INSERT INTO weekly_prediction_snapshots
    (season,week,player_id,position,as_of,cutoff,engine_version,structural,season_to_date,last3,last1,median,
     prediction,lower_80,upper_80,weights_json,weight_fit,actual,settled_at)
    VALUES (?,?,?,?,'2026-09-01','2026-09-01','test',?,?,?,?,?,?,?,?,'[]','test',?,datetime('now'))`);
  db.exec('BEGIN');
  for (const week of weeks) {
    for (let i = 0; i < players; i++) {
      const h = {
        structural: 4 + 16 * next(), season_to_date: 4 + 16 * next(), last3: 4 + 16 * next(),
        last1: 4 + 16 * next(), median: 4 + 16 * next()
      };
      const actual = h[truth];
      const prediction = served === 'structural' ? h.structural
        : LIVE.reduce((sum, w, k) => sum + w * h[['structural', 'season_to_date', 'last3', 'last1', 'median'][k]], 0);
      const miss = i % 5 === 0;
      const lower = miss ? prediction + 40 : prediction - 40;
      const upper = miss ? prediction + 60 : prediction + 40;
      insert.run(season, week, `p${String(i).padStart(3, '0')}`, POSITIONS[i % 4],
        h.structural, h.season_to_date, h.last3, h.last1, h.median, prediction, lower, upper, actual);
    }
  }
  db.exec('COMMIT');
}

test('a promoted weekly retrain keeps the stored early-week buckets', () => {
  reset();
  seedEarlyChampion();
  insertSettled({ season: 2026, weeks: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], players: 50, truth: 'last1' });
  const out = L.retrainWeeklyWeights();
  assert.equal(out.trained, true, JSON.stringify(out));
  assert.equal(out.promoted, true, `the last1-truth candidate must clear the gate: ${out.rejection_reason}`);
  const served = S.activeWeeklyWeightSet({ season: 2027, week: 2 });
  assert.notEqual(served.id, 'fit-1', 'the retrain fit must be the one served');
  assert.deepEqual(served.weights.early, EARLY, 'weeks 2-4 must keep the structural-only buckets');
  // Weeks 5-18 are served the retrained vector, early stripped as always.
  const late = S.activeWeeklyWeightSet({ season: 2027, week: 6 });
  assert.equal(late.weights.early, undefined);
  assert.deepEqual(late.weights.WR, [0, 0, 0, 1, 0]);
});

test('saveWeeklyFit carries the newest stored early block onto a promoted fit that has none', () => {
  reset();
  seedEarlyChampion();
  S.saveWeeklyFit({ ...LEDGER, data_hash: 'no-early', through_season: 2026, through_week: 10, promoted: true,
    weights: perPosition([0, 1, 0, 0, 0]) });
  const stored = JSON.parse(rows("SELECT weights_json FROM weekly_ensemble_fits WHERE data_hash LIKE '%:no-early'")[0].weights_json);
  assert.deepEqual(stored.early, EARLY);
  assert.deepEqual(stored.WR, [0, 1, 0, 0, 0]);
  // A rejected fit is ledger-only and is stored exactly as evaluated.
  S.saveWeeklyFit({ ...LEDGER, data_hash: 'rejected', through_season: 2026, through_week: 11, promoted: false,
    weights: perPosition([0, 0, 1, 0, 0]) });
  const rejected = JSON.parse(rows("SELECT weights_json FROM weekly_ensemble_fits WHERE data_hash LIKE '%:rejected'")[0].weights_json);
  assert.equal(rejected.early, undefined);
});

test('settled rows inside the early-week window neither fit nor grade the per-position vector', () => {
  reset();
  seedEarlyChampion();
  // What the live table will hold once 2026 week 2 settles: ~1,200 week-2 rows, served
  // by the structural-only bucket. Actual tracks structural, so a candidate fit on these
  // rows beats fit-1's vector easily — and would then be served at weeks 5-18.
  insertSettled({ season: 2026, weeks: [2], players: 1200, truth: 'structural', served: 'structural' });
  const out = L.retrainWeeklyWeights();
  assert.equal(out.trained, false, `no per-position fit may come from week 2-4 rows: ${JSON.stringify(out)}`);
  assert.match(out.reason, /early-week/);
  assert.equal(rows('SELECT COUNT(*) AS n FROM weekly_ensemble_fits')[0].n, 1, 'nothing new is stored');
  assert.deepEqual(S.activeWeeklyWeightSet({ season: 2026, week: 6 }).weights.WR, LIVE);
});

test('rows outside the window still train when week 2-4 rows are also present', () => {
  reset();
  seedEarlyChampion();
  insertSettled({ season: 2026, weeks: [2, 3, 4], players: 60, truth: 'structural', served: 'structural' });
  insertSettled({ season: 2026, weeks: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], players: 50, truth: 'last1' });
  const out = L.retrainWeeklyWeights();
  assert.equal(out.trained, true);
  assert.equal(out.sample_size, 650, 'only the 650 week 5-17 rows are used');
  assert.equal(out.promoted, true, out.rejection_reason);
  assert.deepEqual(S.activeWeeklyWeightSet({ season: 2027, week: 3 }).weights.early, EARLY);
});
