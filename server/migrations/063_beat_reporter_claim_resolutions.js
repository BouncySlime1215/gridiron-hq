export const name = '063_beat_reporter_claim_resolutions';

/**
 * `beat_reporter_claim_resolutions` — did the reporter's injury-status claim
 * actually happen?
 *
 * `nfl_news_events` (migration 019) stores the claim as text. This stores the
 * verdict once the game it was about has been played: the direction the claim
 * text committed to, what actually happened per `player_week_snaps`, and
 * whether they matched — plus a printed reason for every row that could not be
 * checked, so "unresolved" always says why rather than reading as a zero.
 *
 * One row per event_id, upserted. A claim about a game that has not been
 * played yet is 'unresolved' today and gets overwritten with a real verdict
 * once `player_week_snaps` has that week's data — the same event_id, not a
 * new row, so history does not accumulate stale duplicates.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS beat_reporter_claim_resolutions (
      event_id             TEXT PRIMARY KEY REFERENCES nfl_news_events(event_id),
      reporter_handle      TEXT,
      claim_type           TEXT NOT NULL,
      predicted_direction  TEXT,
      resolved_state       TEXT NOT NULL CHECK(resolved_state IN ('confirmed','contradicted','unresolved')),
      resolved_reason      TEXT NOT NULL,
      resolved_at          TEXT NOT NULL,
      season                INTEGER,
      week                  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_beat_reporter_resolutions_handle
      ON beat_reporter_claim_resolutions(reporter_handle, claim_type, resolved_state);
  `);
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_beat_reporter_resolutions_handle;
    DROP TABLE IF EXISTS beat_reporter_claim_resolutions;
  `);
}
