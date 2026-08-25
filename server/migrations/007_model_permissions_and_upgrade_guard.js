export const name = '007_model_permissions_and_upgrade_guard';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_permissions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL CHECK(permission IN ('model:train','model:promote','model:execute','model:cancel','model:*')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, permission)
    );
    CREATE TABLE IF NOT EXISTS legacy_draft_quarantine (
      draft_id INTEGER PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      quarantined_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS draft_team_grades (
      draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
      team_slot INTEGER NOT NULL CHECK(team_slot > 0),
      grade TEXT, summary TEXT, strengths TEXT, weaknesses TEXT,
      best_pick TEXT, reach TEXT, generated_at TEXT,
      PRIMARY KEY (draft_id, team_slot)
    );
    INSERT OR IGNORE INTO legacy_draft_quarantine (draft_id, reason)
      SELECT id, 'league and owner assignment required' FROM drafts WHERE league_row_id IS NULL;
    CREATE TRIGGER IF NOT EXISTS model_audit_log_no_update
      BEFORE UPDATE ON model_audit_log BEGIN SELECT RAISE(ABORT, 'model audit log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS model_audit_log_no_delete
      BEFORE DELETE ON model_audit_log BEGIN SELECT RAISE(ABORT, 'model audit log is append-only'); END;
  `);
}

export function down(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS model_audit_log_no_delete;
    DROP TRIGGER IF EXISTS model_audit_log_no_update;
    DROP TABLE IF EXISTS legacy_draft_quarantine;
    DROP TABLE IF EXISTS draft_team_grades;
    DROP TABLE IF EXISTS model_permissions;
  `);
}
