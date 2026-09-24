export const name = '074_nfl_play_participation_players';
/**
 * PROJ-00. Additive only: one new table and one index. Nothing existing is altered.
 *
 * `nfl_play_participation_players`: one row per offense player per offensive
 * snap (kicking units and unsnapped rows are not stored; see
 * ingestParticipationFile), from
 * nflverse `pbp_participation_<season>.csv` (`offense_players`, gsis ids joined
 * by ';'). `nfl_play_formations` reads the same file but keeps only per-play
 * counts (personnel, box, rushers), so before this nothing knew *who* was on
 * the field on a play.
 *
 * `was_route_runner` is nullable and stays NULL: nflverse publishes `route`
 * only for the targeted receiver, not a per-play list of route runners.
 *
 * Writer: ingestParticipationFile, server/services/nfl-participation.js.
 * Reader: participationStatus (same file), served at
 * GET /api/nfl-betting/formations/participation.
 * Loaded by scripts/backfill-participation.mjs. The licence is CC BY-SA 4.0,
 * and only aggregates go in the repo (docs/evidence/2026-09-23/proj-00-licences.md).
 *
 * WITHOUT ROWID on the natural key keeps ~2.5M rows (2021-2025) compact.
 * Numbered 074: PROJ-00 holds 074, ENGINE-00a takes 075, 073 is #170.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfl_play_participation_players (
      game_id TEXT NOT NULL,
      play_id INTEGER NOT NULL,
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,
      gsis_id TEXT NOT NULL,
      team TEXT,
      was_route_runner INTEGER,
      PRIMARY KEY (game_id, play_id, gsis_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_participation_players_season_player
      ON nfl_play_participation_players(season, gsis_id, week);
  `);
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_participation_players_season_player');
  db.exec('DROP TABLE IF EXISTS nfl_play_participation_players');
}
