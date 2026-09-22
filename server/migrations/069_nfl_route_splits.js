export const name = '069_nfl_route_splits';

/**
 * `nfl_route_splits` — per-receiver targets broken out by route family and by
 * coverage shell, from nflsavant.com's open JSON API.
 *
 * Shaped deliberately like `nfl_ngs` (season, week, player_id, kind, stats as a
 * flat numeric JSON blob) so the weekly feature store can expand it with the
 * same transforms it already applies there, and so the two join on `player_id`
 * with no crosswalk: nfl_ngs stores the gsis id under that name
 * (server/services/nfl-advanced.js:113 writes `r.player_gsis_id`), and this
 * source hands back the same id.
 *
 * WHY `week` IS NOT NULLABLE, when "NULL = season aggregate" reads naturally:
 * SQLite permits many NULLs in a composite PRIMARY KEY. With a nullable week,
 * `PRIMARY KEY (season, week, player_id)` never fires for a season-aggregate
 * row, so `ON CONFLICT DO UPDATE` is unreachable and every re-sync appends
 * another copy of the season instead of updating one — silently, since nothing
 * errors. Season aggregates therefore carry week 0, which no real week uses
 * (nfl_ngs's own sync drops week-0 rows as aggregates, nfl-advanced.js:111), and
 * the constraint does its job. See test/route-splits.test.js.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfl_route_splits (
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,           -- 0 = season aggregate; see above
      player_id TEXT NOT NULL,         -- gsis id; joins nfl_ngs.player_id
      kind TEXT NOT NULL DEFAULT 'routes',
      player_name TEXT, team TEXT, position TEXT,
      qualifies INTEGER NOT NULL DEFAULT 0,
      stats TEXT NOT NULL,
      source_fetched_at TEXT NOT NULL,
      PRIMARY KEY (season, week, player_id, kind)
    );
    CREATE INDEX IF NOT EXISTS nfl_route_splits_player
      ON nfl_route_splits (player_id, season, week);
  `);
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS nfl_route_splits_player');
  db.exec('DROP TABLE IF EXISTS nfl_route_splits');
}
