export const name = '107_exgb_shadow';
/**
 * E-XGB phase 2 (docs/tdd/EXGB-PREREG.md, addendum 1). Additive: three new tables, all
 * append-only (triggers refuse UPDATE and DELETE), written only by
 * server/services/exgb-shadow.js and server/services/exgb-grader.js while GRIDIRON_EXGB=1.
 *
 * `exgb_shadow_runs`         one row per forecast run (window, lock and artifact hashes).
 * `exgb_shadow_predictions`  one row per player per arm per run, stamped before kickoff;
 *                            `late` = 1 when predicted at or after that player's kickoff,
 *                            and such a row is never graded. Nothing reads these to serve.
 * `exgb_weekly_grades`       one row per (week, position, arm) each time its inputs change:
 *                            that week's MAE for the model, frozen ESPN and our weekly
 *                            projection, and the running pre-registered result.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exgb_shadow_runs (
      run_id TEXT PRIMARY KEY,
      season INTEGER NOT NULL, week INTEGER NOT NULL, window_key TEXT NOT NULL,
      predicted_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
      n_rows INTEGER NOT NULL DEFAULT 0, n_late INTEGER NOT NULL DEFAULT 0,
      lock_sha256 TEXT, manifest_sha256 TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_exgb_runs_week ON exgb_shadow_runs (season, week, status);

    CREATE TABLE IF NOT EXISTS exgb_shadow_predictions (
      season INTEGER NOT NULL, week INTEGER NOT NULL,
      player_id INTEGER NOT NULL, espn_id INTEGER, position TEXT NOT NULL,
      arm TEXT NOT NULL, prediction REAL NOT NULL, espn_input REAL,
      predicted_at TEXT NOT NULL, kickoff_at TEXT,
      late INTEGER NOT NULL CHECK (late IN (0, 1)),
      run_id TEXT NOT NULL,
      PRIMARY KEY (season, week, arm, player_id, predicted_at)
    );
    CREATE INDEX IF NOT EXISTS idx_exgb_pred_grade ON exgb_shadow_predictions (season, week, arm, late);

    CREATE TABLE IF NOT EXISTS exgb_weekly_grades (
      season INTEGER NOT NULL, week INTEGER NOT NULL, position TEXT NOT NULL, arm TEXT NOT NULL,
      graded_at TEXT NOT NULL, signature TEXT NOT NULL,
      n INTEGER NOT NULL,
      mae_model REAL, mae_espn REAL, mae_current REAL,
      rmse_model REAL, rmse_espn REAL, rmse_current REAL,
      n_model_fallback INTEGER NOT NULL DEFAULT 0, n_actual_fallback INTEGER NOT NULL DEFAULT 0,
      confirmatory INTEGER NOT NULL CHECK (confirmatory IN (0, 1)),
      running_weeks INTEGER, running_n INTEGER,
      running_mae_model REAL, running_mae_espn REAL, running_mae_current REAL,
      p_vs_espn REAL, p_vs_current REAL, holm_p_vs_espn REAL, holm_p_vs_current REAL,
      verdict TEXT CHECK (verdict IN ('pass', 'fail', 'not_run')),
      provisional INTEGER NOT NULL CHECK (provisional IN (0, 1)),
      PRIMARY KEY (season, week, position, arm, graded_at)
    );
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS exgb_shadow_runs_no_update BEFORE UPDATE ON exgb_shadow_runs
      BEGIN SELECT RAISE(ABORT, 'exgb_shadow_runs is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS exgb_shadow_runs_no_delete BEFORE DELETE ON exgb_shadow_runs
      BEGIN SELECT RAISE(ABORT, 'exgb_shadow_runs is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS exgb_shadow_predictions_no_update BEFORE UPDATE ON exgb_shadow_predictions
      BEGIN SELECT RAISE(ABORT, 'exgb_shadow_predictions is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS exgb_shadow_predictions_no_delete BEFORE DELETE ON exgb_shadow_predictions
      BEGIN SELECT RAISE(ABORT, 'exgb_shadow_predictions is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS exgb_weekly_grades_no_update BEFORE UPDATE ON exgb_weekly_grades
      BEGIN SELECT RAISE(ABORT, 'exgb_weekly_grades is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS exgb_weekly_grades_no_delete BEFORE DELETE ON exgb_weekly_grades
      BEGIN SELECT RAISE(ABORT, 'exgb_weekly_grades is append-only'); END;
  `);
}

export function down(db) {
  db.exec(`
    DROP TABLE IF EXISTS exgb_weekly_grades;
    DROP TABLE IF EXISTS exgb_shadow_predictions;
    DROP TABLE IF EXISTS exgb_shadow_runs;
  `);
}
