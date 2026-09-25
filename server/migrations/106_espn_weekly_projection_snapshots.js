export const name = '106_espn_weekly_projection_snapshots';
/**
 * E-XGB phase 1: frozen, pre-kickoff ESPN weekly projections. Additive: two new tables.
 *
 * `espn_weekly_projection_captures` - one row per fetch (window, scoring config): when,
 * the SHA-256 of the request URL (never the cookies), the SHA-256 of the raw response
 * body, and a gzip of the slim payload the rows were parsed from, so a number can be
 * re-derived from what ESPN actually sent.
 *
 * `espn_weekly_projection_snapshots` - one row per player per capture. `late` = 1 when
 * the row was captured at or after that player's own kickoff (the leakage guard); such
 * rows are kept as a record but never graded (see frozenEspnForGrading in
 * server/services/espn-weekly-projection-capture.js).
 *
 * Both tables are APPEND-ONLY: the primary keys include captured_at, and triggers
 * refuse every UPDATE and DELETE, so a frozen number can never be rewritten after the
 * game. Written only by server/services/espn-weekly-projection-capture.js.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS espn_weekly_projection_captures (
      capture_id TEXT PRIMARY KEY,
      season INTEGER NOT NULL, week INTEGER NOT NULL,
      scoring_key TEXT NOT NULL, window_key TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      source_url_hash TEXT NOT NULL, payload_sha256 TEXT, payload_gz BLOB,
      n_players INTEGER NOT NULL DEFAULT 0, n_rows INTEGER NOT NULL DEFAULT 0, n_late INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('ok', 'error')), error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_espn_wp_captures_week
      ON espn_weekly_projection_captures (season, week, scoring_key, window_key);

    CREATE TABLE IF NOT EXISTS espn_weekly_projection_snapshots (
      season INTEGER NOT NULL, week INTEGER NOT NULL,
      player_id INTEGER, espn_id INTEGER NOT NULL,
      position TEXT, pro_team TEXT, injury_status TEXT,
      projected_pts REAL NOT NULL,
      scoring_key TEXT NOT NULL,
      captured_at TEXT NOT NULL, kickoff_at TEXT,
      late INTEGER NOT NULL CHECK (late IN (0, 1)),
      window_key TEXT NOT NULL, capture_id TEXT NOT NULL,
      source_url_hash TEXT NOT NULL,
      PRIMARY KEY (season, week, scoring_key, espn_id, captured_at)
    );
    CREATE INDEX IF NOT EXISTS idx_espn_wp_snapshots_grade
      ON espn_weekly_projection_snapshots (season, week, scoring_key, late);

    CREATE TRIGGER IF NOT EXISTS espn_wp_snapshots_no_update BEFORE UPDATE ON espn_weekly_projection_snapshots
      BEGIN SELECT RAISE(ABORT, 'espn_weekly_projection_snapshots is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS espn_wp_snapshots_no_delete BEFORE DELETE ON espn_weekly_projection_snapshots
      BEGIN SELECT RAISE(ABORT, 'espn_weekly_projection_snapshots is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS espn_wp_captures_no_update BEFORE UPDATE ON espn_weekly_projection_captures
      BEGIN SELECT RAISE(ABORT, 'espn_weekly_projection_captures is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS espn_wp_captures_no_delete BEFORE DELETE ON espn_weekly_projection_captures
      BEGIN SELECT RAISE(ABORT, 'espn_weekly_projection_captures is append-only'); END;
  `);
}

export function down(db) {
  db.exec(`
    DROP TABLE IF EXISTS espn_weekly_projection_snapshots;
    DROP TABLE IF EXISTS espn_weekly_projection_captures;
  `);
}
