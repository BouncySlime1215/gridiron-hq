export const name = '005_model_registry_integrity';

export function up(db) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_model_experiments_spec
      ON model_experiments(spec_json);
    CREATE INDEX IF NOT EXISTS idx_model_predictions_run
      ON model_predictions(run_id, is_holdout, season, week);

    CREATE TABLE IF NOT EXISTS model_dataset_versions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      source_uri TEXT,
      row_count INTEGER NOT NULL CHECK (row_count >= 0),
      cutoff_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_feature_versions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      contract_json TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      UNIQUE(name, version)
    );
    CREATE TABLE IF NOT EXISTS model_experiment_inputs (
      experiment_id TEXT PRIMARY KEY REFERENCES model_experiments(id) ON DELETE CASCADE,
      dataset_version_id TEXT NOT NULL REFERENCES model_dataset_versions(id) ON DELETE RESTRICT,
      feature_version_id TEXT NOT NULL REFERENCES model_feature_versions(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS model_backtests (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL REFERENCES model_experiments(id) ON DELETE CASCADE,
      protocol TEXT NOT NULL CHECK (protocol IN ('walk_forward','sealed_holdout')),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
      result_json TEXT,
      UNIQUE(experiment_id, protocol)
    );
    CREATE TABLE IF NOT EXISTS model_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id TEXT NOT NULL REFERENCES model_experiments(id) ON DELETE CASCADE,
      backtest_id TEXT REFERENCES model_backtests(id) ON DELETE CASCADE,
      split TEXT NOT NULL CHECK (split IN ('discovery','validation','holdout','forward')),
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      sample_size INTEGER NOT NULL CHECK (sample_size >= 0),
      recorded_at TEXT NOT NULL,
      UNIQUE(experiment_id, backtest_id, split, metric)
    );
    CREATE TABLE IF NOT EXISTS model_promotion_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id TEXT NOT NULL REFERENCES model_experiments(id) ON DELETE RESTRICT,
      previous_experiment_id TEXT REFERENCES model_experiments(id) ON DELETE RESTRICT,
      action TEXT NOT NULL CHECK (action IN ('promote','rollback')),
      actor_id TEXT NOT NULL,
      gate_audit_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_audit_entity
      ON model_audit_log(entity_type, entity_id, id DESC);
  `);
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_model_audit_entity;
    DROP TABLE IF EXISTS model_audit_log;
    DROP TABLE IF EXISTS model_promotion_history;
    DROP TABLE IF EXISTS model_metrics;
    DROP TABLE IF EXISTS model_backtests;
    DROP TABLE IF EXISTS model_experiment_inputs;
    DROP TABLE IF EXISTS model_feature_versions;
    DROP TABLE IF EXISTS model_dataset_versions;
    DROP INDEX IF EXISTS idx_model_predictions_run;
    DROP INDEX IF EXISTS idx_model_experiments_spec;
  `);
}
