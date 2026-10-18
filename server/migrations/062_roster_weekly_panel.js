export const name = '062_roster_weekly_panel';
/**
 * `nfl_roster_weekly` — one row per player per regular-season week, holding the
 * roster status the NFL published for him that week (plan section 00, C: WO / O2,
 * the injury-return model).
 *
 * WHY A PANEL AND NOT THE EVENT ARCHIVE. `nfl_verified_events` already ingests the
 * same nflverse feed (`syncWeeklyRosterEvents`), but it keeps only *transitions*,
 * and only for weeks where a kickoff is on file — `gameAvailability()` returns null
 * and the row is skipped otherwise. That is the right shape for "when did this
 * become public" and the wrong shape for "was he on IR in week 7", which is a
 * question about every week, including the ones nothing changed in. Answering it
 * from transitions means reconstructing state by replaying them, and a dropped row
 * silently shifts a player's whole season. So the panel is stored as a panel.
 *
 * `status` is nflverse's coarse code (ACT active, RES reserve/injured, DEV practice
 * squad, INA inactive, CUT, RET, EXE exempt) and `status_detail` is the NFL's own
 * finer abbreviation (A01 active, R01 reserve/injured, R48 designated to return,
 * P01 practice squad, I01 inactive, and so on). Both are kept verbatim rather than
 * mapped, because the mapping is a modelling decision that belongs in the model,
 * where it can be changed without a reload — and because the codes are the only
 * place "injured reserve" and "designated to return" are distinguishable at all.
 *
 * REGULAR SEASON ONLY. The feed carries WC/DIV/CON/SB rows too; a fantasy season
 * ends at week 17 or 18, and a playoff week would put two rows on one (season,
 * week, player) key. Filtered at load, not here.
 *
 * `gsis_id` is the key because it is what `player_week_snaps`, `player_week_usage`
 * and `nfl_player_week_features` join on — the tables any availability model has to
 * be graded against. Rows with no gsis_id are dropped at load: a player who cannot
 * be joined to usage cannot be graded, so storing him would only inflate counts.
 */
export function up(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_roster_weekly (
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    gsis_id TEXT NOT NULL,
    team TEXT,
    position TEXT,
    depth_position TEXT,
    status TEXT,
    status_detail TEXT,
    player_name TEXT,
    pfr_id TEXT,
    espn_id TEXT,
    years_exp INTEGER,
    ingested_at TEXT NOT NULL,
    PRIMARY KEY (season, week, gsis_id)
  )`);
  // The model reads a player's own season in week order (how long has he been out,
  // when did he come back), and the loader reads a season-week slice to report what
  // it stored. One index per access pattern; the primary key already covers the
  // (season, week) prefix, so only the player-ordered one is new.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_nfl_roster_weekly_player
    ON nfl_roster_weekly (gsis_id, season, week)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_nfl_roster_weekly_status
    ON nfl_roster_weekly (season, status, week)`);
}

export function down(db) {
  // A new table and its two indexes only; dropping them returns the schema to 061.
  db.exec('DROP INDEX IF EXISTS idx_nfl_roster_weekly_status');
  db.exec('DROP INDEX IF EXISTS idx_nfl_roster_weekly_player');
  db.exec('DROP TABLE IF EXISTS nfl_roster_weekly');
}
