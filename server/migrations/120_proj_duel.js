export const name = '120_proj_duel';
/**
 * PROJ-DUEL (why the shadow model says what it says, and what happened). Additive, append-only,
 * written only by services/proj-duel/explain.js while GRIDIRON_EXGB=1. Nothing reads these to serve
 * a number: the E-XGB model is in testing (docs/tdd/EXGB-PREREG.md) and its locked artifacts and
 * stored predictions are untouched.
 *
 * `exgb_shadow_drivers`  per player per week, arm A_xgb: the TreeSHAP contributions (XGBoost
 *                        pred_contribs) of the top features, the pre-game expected usage the model
 *                        saw (trail3 carries/targets/receptions/snap %/red-zone share/xfp, team
 *                        implied total, opponent allowed), and the prediction recomputed from the
 *                        same artifacts with whether it equals the stored forecast.
 * `proj_duel_residuals`  per graded player-week: our forecast, ESPN's frozen projection, the actual,
 *                        both absolute errors, the actual usage line and the team's points scored
 *                        beside its implied total.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exgb_shadow_drivers (
      season INTEGER NOT NULL, week INTEGER NOT NULL, player_id INTEGER NOT NULL, arm TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL, computed_at TEXT NOT NULL,
      base REAL, contribs_json TEXT NOT NULL, expected_json TEXT NOT NULL,
      prediction_recomputed REAL, matches_prediction INTEGER NOT NULL CHECK (matches_prediction IN (0, 1)),
      PRIMARY KEY (season, week, arm, player_id, manifest_sha256)
    );
    CREATE TABLE IF NOT EXISTS proj_duel_residuals (
      season INTEGER NOT NULL, week INTEGER NOT NULL, player_id INTEGER NOT NULL, position TEXT,
      ours REAL NOT NULL, espn REAL NOT NULL, actual REAL NOT NULL, err_ours REAL NOT NULL, err_espn REAL NOT NULL,
      team TEXT, carries REAL, targets REAL, receptions REAL, snap_pct REAL, rz_share REAL, xfp REAL, tds REAL,
      team_points REAL, team_implied REAL, graded_at TEXT NOT NULL,
      PRIMARY KEY (season, week, player_id)
    );
    CREATE TRIGGER IF NOT EXISTS exgb_shadow_drivers_no_update BEFORE UPDATE ON exgb_shadow_drivers
      BEGIN SELECT RAISE(ABORT, 'exgb_shadow_drivers is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS proj_duel_residuals_no_update BEFORE UPDATE ON proj_duel_residuals
      BEGIN SELECT RAISE(ABORT, 'proj_duel_residuals is append-only'); END;
  `);
}

export function down(db) {
  db.exec(`DROP TRIGGER IF EXISTS proj_duel_residuals_no_update; DROP TRIGGER IF EXISTS exgb_shadow_drivers_no_update;
           DROP TABLE IF EXISTS proj_duel_residuals; DROP TABLE IF EXISTS exgb_shadow_drivers;`);
}
