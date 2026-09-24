export const name = '082_projection_autopsy';
/**
 * PROJ-04-a Monday Autopsy. Additive only: three new tables, nothing altered.
 *
 * `projection_autopsy` — one row per league, player, link, week: the points that
 * link moved (actual - projection, split; the links of one player-week sum to his
 * miss exactly), whether that link is outcome luck, and which projection sat
 * closer to the actual (ours or ESPN's). Written by
 * server/services/monday-autopsy.js#runMondayAutopsy.
 *
 * `projection_autopsy_player` — the player-week header: projection, actual, miss,
 * the plain line, whether he started, and the basis the split used (PROJ-02-a
 * links, prior weeks, or none).
 *
 * `projection_autopsy_week` — the week's summary sentence and its start/sit calls,
 * each graded decision vs luck.
 *
 * Numbered 082: main tops at 073; 071, 074, 075 are held by open PRs, 076-081 are
 * claimed by the ENGINE-SPECS migration plan.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_autopsy (
      league_id INTEGER NOT NULL,
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      link TEXT NOT NULL,
      points REAL NOT NULL,
      is_luck INTEGER NOT NULL CHECK (is_luck IN (0, 1)),
      source_right TEXT CHECK (source_right IN ('ours', 'espn', 'tie')),
      detail_json TEXT,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (league_id, season, week, player_id, link)
    );
    CREATE TABLE IF NOT EXISTS projection_autopsy_player (
      league_id INTEGER NOT NULL,
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      team_id INTEGER,
      is_starter INTEGER NOT NULL CHECK (is_starter IN (0, 1)),
      position TEXT,
      projected REAL NOT NULL,
      actual REAL NOT NULL,
      miss REAL NOT NULL,
      espn_projected REAL,
      basis TEXT NOT NULL,
      line TEXT NOT NULL,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (league_id, season, week, player_id)
    );
    CREATE TABLE IF NOT EXISTS projection_autopsy_week (
      league_id INTEGER NOT NULL,
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,
      team_id INTEGER,
      summary TEXT NOT NULL,
      calls_json TEXT NOT NULL,
      totals_json TEXT NOT NULL,
      links_error TEXT,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (league_id, season, week)
    );
  `);
}

export function down(db) {
  db.exec('DROP TABLE IF EXISTS projection_autopsy');
  db.exec('DROP TABLE IF EXISTS projection_autopsy_player');
  db.exec('DROP TABLE IF EXISTS projection_autopsy_week');
}
