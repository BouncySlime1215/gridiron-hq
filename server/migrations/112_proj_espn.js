export const name = '112_proj_espn';
/**
 * PROJ-ESPN (testbench #446): the served weekly projection is frozen pre-kickoff ESPN.
 * Additive: four new tables, nothing existing changes.
 *
 * `weekly_projection_shadow` - our own weekly projection, kept as a SHADOW beside the
 *   ESPN number that is served, one row per (season, week, player, scoring). Written by
 *   trade-engine.js#buildAssetUniverse through espn-week-projection.js#logWeeklyShadow;
 *   a row stops updating once its kickoff has passed, so it holds the pre-kickoff pair.
 * `range_calibration` - every fit of the weekly-range width multiplier k (range-calibration.js),
 *   with its fit date, the weeks it was fitted on and the pre-registered rule's decision.
 * `range_coverage_log` - realised p10-p90 coverage of the weekly lineup range, per league-week.
 * `offer_value_gain_log` - per offer, the counterparty's FantasyCalc gain, positional need met,
 *   blue chip given and days to the deadline (offer-value-gain.js; the pre-registered n>=100 test).
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_projection_shadow (
      season INTEGER NOT NULL, week INTEGER NOT NULL, player_id INTEGER NOT NULL,
      scoring_key TEXT NOT NULL,
      ours REAL, espn REAL, captured_at TEXT, kickoff_at TEXT,
      served TEXT NOT NULL,
      first_logged_at TEXT NOT NULL, logged_at TEXT NOT NULL,
      PRIMARY KEY (season, week, player_id, scoring_key)
    );

    CREATE TABLE IF NOT EXISTS range_calibration (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      k REAL NOT NULL, fitted_at TEXT NOT NULL, fit_date TEXT NOT NULL,
      season INTEGER, fit_weeks TEXT NOT NULL,
      coverage_before REAL, coverage_after REAL, n_team_weeks INTEGER,
      decision TEXT NOT NULL CHECK (decision IN ('initial', 'kept', 'refit', 'skipped')),
      rule TEXT NOT NULL, note TEXT
    );

    CREATE TABLE IF NOT EXISTS range_coverage_log (
      season INTEGER NOT NULL, week INTEGER NOT NULL, league_id INTEGER NOT NULL,
      n_team_weeks INTEGER NOT NULL, covered INTEGER NOT NULL, coverage REAL,
      below_p10 INTEGER NOT NULL DEFAULT 0, above_p90 INTEGER NOT NULL DEFAULT 0,
      k REAL NOT NULL, source TEXT NOT NULL, logged_at TEXT NOT NULL,
      PRIMARY KEY (season, week, league_id)
    );

    CREATE TABLE IF NOT EXISTS offer_value_gain_log (
      offer_id TEXT PRIMARY KEY,
      league_id INTEGER NOT NULL, season INTEGER,
      counterparty_team_id TEXT, proposed_at TEXT,
      fc_gain REAL, need_met INTEGER, blue_chip_given INTEGER, days_to_deadline REAL,
      outcome INTEGER, features_as_of TEXT NOT NULL, logged_at TEXT NOT NULL
    );
  `);
}

export function down(db) {
  db.exec(`
    DROP TABLE IF EXISTS offer_value_gain_log;
    DROP TABLE IF EXISTS range_coverage_log;
    DROP TABLE IF EXISTS range_calibration;
    DROP TABLE IF EXISTS weekly_projection_shadow;
  `);
}
