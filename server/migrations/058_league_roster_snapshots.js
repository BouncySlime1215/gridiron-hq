export const name = '058_league_roster_snapshots';
/**
 * `league_roster_snapshots` — every team's roster and lineup slots, per league per
 * ESPN scoring period, written by scripts/collect-roster-snapshots.mjs on every
 * refresh-loop tick.
 *
 * `leagues.payload` is overwritten by each hourly ESPN sync, so until 2026-09-18
 * nothing kept last week's lineups: "what did I start" and bench points had no
 * history (FANTASY-ENGINE-MASTER-PLAN.md section 00, [WA-ess]).
 *
 * One row per (league, season, scoring period, team, ESPN player), holding the
 * latest state seen for that period:
 *   - source 'live'  — from the stored payload while the period is current;
 *   - source 'final' — from ESPN's boxscore for the completed period (authoritative;
 *     a live capture never overwrites it);
 *   - on_roster 0    — the player was on this team earlier in the period but not in
 *     the latest capture (dropped or traded; kept, he may have scored for the team).
 * Points are this period's only: projected (ESPN statSourceId 1) and actual (0).
 * first_seen_at / changed_at move only when something changed, so re-capturing the
 * same payload writes nothing.
 */
export function up(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS league_roster_snapshots (
    league_id INTEGER NOT NULL,
    season INTEGER NOT NULL,
    scoring_period_id INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    espn_player_id INTEGER NOT NULL,
    player_id INTEGER,
    player_name TEXT,
    position TEXT,
    espn_position_id INTEGER,
    pro_team_id INTEGER,
    lineup_slot_id INTEGER NOT NULL,
    lineup_slot TEXT,
    is_starter INTEGER NOT NULL CHECK (is_starter IN (0, 1)),
    injury_status TEXT,
    acquisition_type TEXT,
    lineup_locked INTEGER,
    projected_points REAL,
    actual_points REAL,
    on_roster INTEGER NOT NULL DEFAULT 1 CHECK (on_roster IN (0, 1)),
    source TEXT NOT NULL CHECK (source IN ('live', 'final')),
    first_seen_at TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    PRIMARY KEY (league_id, season, scoring_period_id, team_id, espn_player_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_league_roster_snapshots_period
    ON league_roster_snapshots (league_id, season, scoring_period_id, source)`);
}

export function down(db) {
  // A new table and its index only; dropping them returns the schema to its 057 shape.
  db.exec('DROP INDEX IF EXISTS idx_league_roster_snapshots_period');
  db.exec('DROP TABLE IF EXISTS league_roster_snapshots');
}
