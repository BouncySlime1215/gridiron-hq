export const name = '004_model_lab';

/**
 * Schema for the Model Lab: walk-forward experiment registry, per-observation
 * predictions (evaluation folds and the sealed final holdout), and the
 * single-pointer production/rollback record. Previously created ad-hoc at
 * module load by server/modeling/sqlite-store.js; moved here so it goes
 * through the same tracked, one-time migration path as the rest of the
 * versioned schema instead of being (re)created outside any audit trail.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_experiments (
      id TEXT PRIMARY KEY, spec_json TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      cancellation_requested INTEGER NOT NULL DEFAULT 0,
      logs_json TEXT NOT NULL DEFAULT '[]', result_json TEXT,
      promoted_at TEXT, promoted_by TEXT
    );
    CREATE TABLE IF NOT EXISTS model_predictions (
      run_id TEXT NOT NULL, player_id TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
      as_of TEXT NOT NULL, status TEXT NOT NULL, prediction REAL, lower REAL, upper REAL,
      active_probability REAL, actual REAL, error TEXT, fold_cutoff INTEGER, is_holdout INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, player_id, season, week)
    );
    CREATE TABLE IF NOT EXISTS model_production_pointer (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), experiment_id TEXT NOT NULL,
      previous_experiment_id TEXT, audit_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
}

export function down(db) {
  db.exec(`DROP TABLE IF EXISTS model_production_pointer;
    DROP TABLE IF EXISTS model_predictions;
    DROP TABLE IF EXISTS model_experiments;`);
}
