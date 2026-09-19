export const name = '20260919213000_league_history_tables';
/**
 * `league_season_teams` and `league_week_scores` — the historical league facts
 * the manager layer is built on.
 *
 * Both tables were created at run time by scripts/backfill-league-history.mjs,
 * which is also the only thing that ever wrote them. That made the schema
 * conditional on somebody having run a script by hand: on a box where nobody
 * had, `SELECT ... FROM league_season_teams` in manager-archetypes.js (:243,
 * :819, :831 — all reached from the trades surface) did not return an empty
 * result, it threw `no such table`. Moving the DDL here makes the tables exist
 * on every box, which is the precondition for server/services/league-history.js
 * being able to fill them on a timer.
 *
 * Deliberately identical to what the script created, column for column, so a
 * database that already has them (the live app has, since 2026-09-17) takes
 * this as a no-op rather than a second, differently shaped copy.
 *
 * league_draft_picks is NOT created here: it is owned by
 * scripts/collect-league-transactions.mjs's sibling collector, which keeps
 * ESPN's raw autoDraftTypeId and already holds its own rows.
 */
export function up(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS league_week_scores (
    league_id INTEGER NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
    roster_id TEXT NOT NULL, points REAL, opponent_roster_id TEXT, is_playoff INTEGER,
    captured_at TEXT NOT NULL,
    PRIMARY KEY (league_id, season, week, roster_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS league_season_teams (
    league_id INTEGER NOT NULL, season INTEGER NOT NULL, roster_id TEXT NOT NULL,
    team_name TEXT, owner_name TEXT, espn_member_id TEXT,
    wins INTEGER, losses INTEGER, ties INTEGER, points_for REAL, points_against REAL,
    final_rank INTEGER, playoff_seed INTEGER, captured_at TEXT NOT NULL,
    PRIMARY KEY (league_id, season, roster_id))`);
  // managerProfile() looks a member up across every league-season he has played
  // in; archetypesFor() reads one league-season at a time. The primary key
  // serves the second, not the first.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_league_season_teams_member
    ON league_season_teams (espn_member_id)`);
}

export function down(db) {
  // The two tables predate this migration on any box where the backfill script
  // ran, and they hold seasons ESPN will not serve again from the transaction
  // window (see league-history.js, note 3). Dropping them to "undo" a CREATE
  // IF NOT EXISTS would destroy data this migration never created, so the
  // rollback removes only the index this file genuinely added.
  db.exec('DROP INDEX IF EXISTS idx_league_season_teams_member');
}
