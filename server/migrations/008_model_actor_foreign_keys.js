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
    UPDATE model_audit_log SET actor_user_id=CAST(actor_id AS INTEGER)
      WHERE EXISTS (SELECT 1 FROM users WHERE id=CAST(actor_id AS INTEGER));
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
