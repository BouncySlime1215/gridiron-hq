export const name = '087_weekly_autopsy';
/**
 * AUTOPSY-01 Monday Autopsy, team-week table. Additive only: one new table.
 *
 * `weekly_autopsy` — one row per (league, season, week, team): what the team
 * scored, what its started lineup was expected to score before the games, and
 * what the best lineup its own roster allowed was expected to score. From those:
 *
 *   decision_points = expected_points - optimal_expected_points   (<= 0)
 *   luck_points     = actual_points   - expected_points
 *
 * so actual_points = optimal_expected_points + decision_points + luck_points
 * exactly. Written by server/services/weekly-autopsy.js#runWeeklyAutopsy (run by
 * scripts/build-weekly-autopsy.mjs); read by EVAL E7 (server/services/eval/e7.js,
 * PR #235/#266), whose contract is season, week, league_id, team_id,
 * actual_points, expected_points, optimal_expected_points.
 *
 * `optimal_actual_points` is the hindsight best lineup (what the bench cost after
 * the fact, `bench_points_lost`); it is reporting only and never part of the
 * decision/luck split, because hindsight is not a decision anyone could make.
 * `projection_basis` names which pregame number the expectation used, `preview`
 * is 1 when the row was written only because preview mode was on, and a row whose
 * optimal lineup could not be solved keeps optimal_expected_points NULL with the
 * reason in `status` (E7 skips it rather than grading a guess).
 *
 * Numbered 087: main tops at 074; 071, 074-086 are held by open PRs or the plan.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_autopsy (
      league_id INTEGER NOT NULL,
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      actual_points REAL NOT NULL,
      expected_points REAL NOT NULL,
      optimal_expected_points REAL,
      optimal_actual_points REAL,
      decision_points REAL,
      luck_points REAL NOT NULL,
      bench_points_lost REAL,
      starters INTEGER NOT NULL,
      missing_projections INTEGER NOT NULL DEFAULT 0,
      projection_basis TEXT NOT NULL,
      status TEXT NOT NULL,
      line TEXT NOT NULL,
      detail_json TEXT,
      preview INTEGER NOT NULL DEFAULT 0 CHECK (preview IN (0, 1)),
      computed_at TEXT NOT NULL,
      PRIMARY KEY (league_id, season, week, team_id)
    );
  `);
}

export function down(db) {
  db.exec('DROP TABLE IF EXISTS weekly_autopsy');
}
