export const name = '008_model_actor_foreign_keys';

// Keep the legacy text actor columns for upgrade compatibility, while making
// every new provenance write point to a real persisted user through an actual
// SQLite foreign key. The application writes both during this compatibility
// window; the *_user_id columns are authoritative.
export function up(db) {
  db.exec(`
    ALTER TABLE model_experiments ADD COLUMN created_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT;
    ALTER TABLE model_experiments ADD COLUMN promoted_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT;
    ALTER TABLE model_dataset_versions ADD COLUMN created_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT;
    ALTER TABLE model_feature_versions ADD COLUMN created_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT;
    ALTER TABLE model_promotion_history ADD COLUMN actor_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT;
    ALTER TABLE model_audit_log ADD COLUMN actor_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT;
    UPDATE model_dataset_versions SET created_by_user_id=CAST(created_by AS INTEGER)
      WHERE EXISTS (SELECT 1 FROM users WHERE id=CAST(created_by AS INTEGER));
    UPDATE model_feature_versions SET created_by_user_id=CAST(created_by AS INTEGER)
      WHERE EXISTS (SELECT 1 FROM users WHERE id=CAST(created_by AS INTEGER));
    UPDATE model_experiments SET promoted_by_user_id=CAST(promoted_by AS INTEGER)
      WHERE promoted_by IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE id=CAST(promoted_by AS INTEGER));
    UPDATE model_promotion_history SET actor_user_id=CAST(actor_id AS INTEGER)
      WHERE EXISTS (SELECT 1 FROM users WHERE id=CAST(actor_id AS INTEGER));
  `);

  // 007 makes `model_audit_log` append-only, so this backfill has to lift its
  // update guard and put it straight back — the same shape as 031 and 032.
  //
  // Unlike those two this one has never fired in practice: 007 and 008 ship
  // together, so on every real installation the log was empty when 008 ran.
  // That is luck, not design. An installation that reached 007 with audit rows
  // and upgraded later would abort here with "model audit log is append-only",
  // and would abort on every boot after that. Fixed for the same reason the
  // other two were, and covered by the same scan that found it.
  db.exec(`DROP TRIGGER IF EXISTS model_audit_log_no_update`);
  db.exec(`
    UPDATE model_audit_log SET actor_user_id=CAST(actor_id AS INTEGER)
      WHERE EXISTS (SELECT 1 FROM users WHERE id=CAST(actor_id AS INTEGER));
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS model_audit_log_no_update
      BEFORE UPDATE ON model_audit_log BEGIN SELECT RAISE(ABORT, 'model audit log is append-only'); END;
  `);
}

export function down(db) {
  db.exec(`
    ALTER TABLE model_audit_log DROP COLUMN actor_user_id;
    ALTER TABLE model_promotion_history DROP COLUMN actor_user_id;
    ALTER TABLE model_feature_versions DROP COLUMN created_by_user_id;
    ALTER TABLE model_dataset_versions DROP COLUMN created_by_user_id;
    ALTER TABLE model_experiments DROP COLUMN promoted_by_user_id;
    ALTER TABLE model_experiments DROP COLUMN created_by_user_id;
  `);
}
