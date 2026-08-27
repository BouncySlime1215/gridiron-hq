/** Versioned champion weights for the weekly ensemble. */
import { db, rows, run } from '../db/index.js';
import { WEEKLY_ENSEMBLE_WEIGHTS } from './weekly-ensemble.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS weekly_ensemble_fits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data_hash TEXT NOT NULL UNIQUE,
    through_season INTEGER NOT NULL,
    through_week INTEGER NOT NULL,
    weights_json TEXT NOT NULL,
    sample_size INTEGER NOT NULL,
    validation_size INTEGER NOT NULL,
    candidate_mae REAL,
    champion_mae REAL,
    candidate_spearman REAL,
    champion_spearman REAL,
    coverage_80 REAL,
    promoted INTEGER NOT NULL DEFAULT 0,
    rejection_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_weekly_fits_cutoff
    ON weekly_ensemble_fits(promoted, through_season, through_week);
`);

export function activeWeeklyWeightSet({ season, week } = {}) {
  const fit = Number.isInteger(season) && Number.isInteger(week)
    ? rows(`SELECT * FROM weekly_ensemble_fits WHERE promoted=1
            AND (through_season < ? OR (through_season = ? AND through_week < ?))
            ORDER BY through_season DESC, through_week DESC, id DESC LIMIT 1`, season, season, week)[0]
    : rows(`SELECT * FROM weekly_ensemble_fits WHERE promoted=1
            ORDER BY through_season DESC, through_week DESC, id DESC LIMIT 1`)[0];
  if (!fit) return { id: 'frozen-2023', weights: WEEKLY_ENSEMBLE_WEIGHTS, source: 'frozen' };
  return { id: `fit-${fit.id}`, weights: JSON.parse(fit.weights_json), source: 'adaptive', fit };
}

export function saveWeeklyFit(fit) {
  const result = run(`INSERT INTO weekly_ensemble_fits
    (data_hash,through_season,through_week,weights_json,sample_size,validation_size,
     candidate_mae,champion_mae,candidate_spearman,champion_spearman,coverage_80,promoted,rejection_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(data_hash) DO NOTHING`,
  fit.data_hash, fit.through_season, fit.through_week, JSON.stringify(fit.weights),
  fit.sample_size, fit.validation_size, fit.candidate_mae, fit.champion_mae,
  fit.candidate_spearman, fit.champion_spearman, fit.coverage_80,
  fit.promoted ? 1 : 0, fit.rejection_reason ?? null);
  return { inserted: result.changes > 0, ...fit };
}

export function weeklyFitHistory(limit = 20) {
  return rows('SELECT * FROM weekly_ensemble_fits ORDER BY id DESC LIMIT ?', limit)
    .map(fit => ({ ...fit, weights: JSON.parse(fit.weights_json) }));
}
