export const name = '022_scottfree_game_features';

/**
 * Scottfree Sports' historical odds + rolling-feature panel (per-sport CSV,
 * vendor docs at https://scottfreellc.github.io/alphapy-sports).
 *
 * Nick downloaded the free sample package (server/data/vendor-samples if kept
 * locally; the importer at scripts/import-scottfree.mjs reads it from
 * wherever it was downloaded). The free sample is one season per sport; the
 * paid product goes back to 2007 for NFL (5,164 rows per the package's own
 * coverage matrix) with opening-line coverage this project's own odds-archive
 * does not reliably have that far back.
 *
 * ONE ROW MIXES LABELS AND FEATURES. This is a vendor research/backtest
 * product, not a pregame decision feed: home_score, away_score,
 * point_margin_game, won_on_points, cover_margin_game, won_on_spread,
 * overunder_margin, over, under and every home_total_points/away_total_points
 * column are THIS GAME'S OWN OUTCOME. Every "season state" and "streak"
 * column (wins/losses/margins/ATS records) is documented by the vendor as
 * computed from games strictly BEFORE the current row, which is the right
 * shape for a pregame feature — but the vendor does not stamp a per-row
 * observed_at/decision_at the way this project's own bitemporal store
 * (nfl-bitemporal.js) does. Treat this table as RECONSTRUCTED historical
 * research data (Package A's provenance vocabulary), never as a captured,
 * point-in-time-safe feed. Anything trained against it must explicitly
 * exclude the outcome columns from its feature set and must not claim the
 * decision-time guarantees nfl-evidence-dataset.js's quarantine report gives
 * the quote tape.
 *
 * The canonical game key per the vendor's own docs is
 * (date, time_est, away_team, home_team) — stored verbatim as
 * source_game_key alongside a best-effort match to this project's own
 * canonical team codes (via team-codes.js's teamResolver) and contract-key
 * event format, which can be NULL when a team name doesn't resolve (an
 * unresolved row is kept, never silently dropped or guessed).
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfl_scottfree_game_features (
      source_game_key TEXT PRIMARY KEY,
      event_key TEXT,
      season TEXT NOT NULL, date TEXT NOT NULL, time_est TEXT NOT NULL,
      away_team_raw TEXT NOT NULL, home_team_raw TEXT NOT NULL,
      away_team_abbr TEXT, home_team_abbr TEXT,
      away_score INTEGER, home_score INTEGER,
      away_point_spread REAL, away_point_spread_line INTEGER, away_money_line INTEGER,
      home_point_spread REAL, home_point_spread_line INTEGER, home_money_line INTEGER,
      over_under REAL, over_line INTEGER, under_line INTEGER,
      open_home_money_line INTEGER, open_away_money_line INTEGER,
      open_home_point_spread REAL, open_away_point_spread REAL, open_over_under REAL,
      -- Outcome columns (this game's own result -- evaluation labels, never a pregame input):
      total_points INTEGER, point_margin_game INTEGER, won_on_points INTEGER, lost_on_points INTEGER,
      cover_margin_game REAL, won_on_spread INTEGER, lost_on_spread INTEGER,
      overunder_margin REAL, over INTEGER, under INTEGER,
      -- Season-state / streak / rolling features (vendor-documented as pre-row-only):
      features_json TEXT NOT NULL,
      source_release TEXT NOT NULL, csv_sha256 TEXT NOT NULL, ingested_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scottfree_nfl_date ON nfl_scottfree_game_features(date);
    CREATE INDEX IF NOT EXISTS idx_scottfree_nfl_event ON nfl_scottfree_game_features(event_key);
  `);
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_scottfree_nfl_event;
    DROP INDEX IF EXISTS idx_scottfree_nfl_date;
    DROP TABLE IF EXISTS nfl_scottfree_game_features;`);
}
