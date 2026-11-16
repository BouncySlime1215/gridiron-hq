export const name = '093_live_inactive_claims';

/**
 * `live_inactive_claims`: "player X is inactive / active for this week's game", as
 * posted before kickoff by a watched public Bluesky account and received through
 * Jetstream. Written only by server/services/live-inactive-monitor.js
 * (`recordClaim`), read by lineup-brain.js `lineupCall` warnings through
 * `liveInactiveClaims`. Additive: a new table, nothing existing is touched.
 *
 * Why not `nfl_news_events`? That table's `source_kind` CHECK allows only
 * 'news_item' | 'press_conference' (migration 019), and SQLite cannot widen a CHECK
 * without rebuilding the table. It also stores claim text, and this source's text is
 * third-party (NBC/Rotoworld, reporters), so only claim fields and the at:// URI are
 * kept here. The page links out.
 *
 * One row per (post URI, player). Jetstream is at-least-once, so re-delivery upserts
 * the same row. An author deleting the post sets `retracted_at` (Bluesky's developer
 * guidelines ask services to honour deletions). The row itself is never deleted.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_inactive_claims (
      source_uri     TEXT NOT NULL,
      player_id      INTEGER NOT NULL,
      player_name    TEXT NOT NULL,
      status         TEXT NOT NULL CHECK(status IN ('inactive','active')),
      season         INTEGER NOT NULL,
      week           INTEGER NOT NULL,
      source_handle  TEXT NOT NULL,
      source_did     TEXT NOT NULL,
      posted_at      TEXT,
      first_seen_at  TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      retracted_at   TEXT,
      PRIMARY KEY (source_uri, player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_live_inactive_claims_week ON live_inactive_claims(season, week, player_id);
  `);
}

export function down(db) {
  db.exec('DROP TABLE IF EXISTS live_inactive_claims');
}
