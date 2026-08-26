export const name = '015_espn_durable_sync';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS espn_draft_sync_state (
      draft_id INTEGER PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
      health_state TEXT NOT NULL DEFAULT 'pending',
      last_attempt_at TEXT,
      last_success_at TEXT,
      last_failure_at TEXT,
      failure_category TEXT,
      failure_code TEXT,
      failure_message TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      retry_status TEXT NOT NULL DEFAULT 'ready',
      recovery_state TEXT NOT NULL DEFAULT 'none',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (health_state IN ('pending','syncing','healthy','retrying','auth_required','invalid_data','failed','complete')),
      CHECK (retry_status IN ('ready','scheduled','stopped','complete')),
      CHECK (recovery_state IN ('none','catch_up','manual_retry','recovered','action_required'))
    );
    CREATE INDEX IF NOT EXISTS idx_espn_sync_due
      ON espn_draft_sync_state(retry_status, next_retry_at);

    INSERT OR IGNORE INTO espn_draft_sync_state
      (draft_id, health_state, last_success_at, retry_status)
      SELECT id,
        CASE WHEN status='complete' THEN 'complete'
             WHEN last_synced_at IS NOT NULL THEN 'healthy' ELSE 'pending' END,
        last_synced_at,
        CASE WHEN status='complete' THEN 'complete' ELSE 'ready' END
      FROM drafts WHERE type='live' AND espn_league_id IS NOT NULL;
  `);
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_espn_sync_due;
    DROP TABLE IF EXISTS espn_draft_sync_state;`);
}
