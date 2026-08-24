export const name = '009_authoritative_actor_and_ownership_guards';

const actorColumns = [
  ['model_experiments', 'created_by_user_id'],
  ['model_dataset_versions', 'created_by_user_id'],
  ['model_feature_versions', 'created_by_user_id'],
  ['model_promotion_history', 'actor_user_id'],
  ['model_audit_log', 'actor_user_id']
];

// Migration 008 introduced real foreign keys, but its compatibility columns
// remained nullable. Preserve pre-identity rows in an explicit quarantine and
// reject any new or rewritten provenance that does not identify a persisted
// user. Triggers are used instead of destructive table rebuilds so upgrades do
// not disturb registry history or child foreign-key relationships.
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_actor_provenance_quarantine (
      source_table TEXT NOT NULL,
      source_key TEXT NOT NULL,
      actor_value TEXT,
      reason TEXT NOT NULL,
      quarantined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source_table, source_key)
    );
  `);

  for (const [table, column] of actorColumns) {
    const legacyActor = column === 'actor_user_id' ? 'actor_id'
      : table === 'model_experiments' ? "COALESCE(promoted_by, '')" : 'created_by';
    db.exec(`INSERT OR IGNORE INTO model_actor_provenance_quarantine
      (source_table, source_key, actor_value, reason)
      SELECT '${table}', CAST(id AS TEXT), CAST(${legacyActor} AS TEXT), 'persisted user identity required'
      FROM ${table} WHERE ${column} IS NULL;`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_${column}_required_insert
      BEFORE INSERT ON ${table}
      WHEN NEW.${column} IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.${column})
      BEGIN SELECT RAISE(ABORT, '${table}.${column} must reference a persisted user'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_${column}_required_update
      BEFORE UPDATE OF ${column} ON ${table}
      WHEN NEW.${column} IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.${column})
      BEGIN SELECT RAISE(ABORT, '${table}.${column} must reference a persisted user'); END;
    `);
  }

  db.exec(`
    INSERT OR IGNORE INTO model_actor_provenance_quarantine
      (source_table, source_key, actor_value, reason)
      SELECT 'model_experiments.promoted_by', id, promoted_by, 'persisted promotion user identity required'
      FROM model_experiments WHERE promoted_at IS NOT NULL AND promoted_by_user_id IS NULL;
    CREATE TRIGGER IF NOT EXISTS model_experiments_promoter_required_update
    BEFORE UPDATE OF promoted_at, promoted_by_user_id ON model_experiments
    WHEN NEW.promoted_at IS NOT NULL AND (NEW.promoted_by_user_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.promoted_by_user_id))
    BEGIN SELECT RAISE(ABORT, 'model_experiments.promoted_by_user_id must reference a persisted user'); END;
  `);

  // Databases which had already recorded migration 006 still need its UPDATE
  // protection; CREATE IF NOT EXISTS also leaves fresh installs idempotent.
  db.exec(`CREATE TRIGGER IF NOT EXISTS validate_draft_team_owner_update
    BEFORE UPDATE OF draft_id, team_slot, user_id ON draft_team_ownership BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM drafts d JOIN league_memberships lm
          ON lm.league_id = d.league_row_id AND lm.user_id = NEW.user_id
        WHERE d.id = NEW.draft_id AND NEW.team_slot > 0 AND NEW.team_slot <= d.team_count
      ) THEN RAISE(ABORT, 'draft owner must be a league member with a valid slot') END;
    END;
    CREATE TRIGGER IF NOT EXISTS cascade_draft_ownership_membership_delete
    AFTER DELETE ON league_memberships BEGIN
      DELETE FROM draft_team_ownership
      WHERE user_id = OLD.user_id
        AND draft_id IN (SELECT id FROM drafts WHERE league_row_id = OLD.league_id);
    END;
    CREATE TRIGGER IF NOT EXISTS validate_draft_ownership_parent_update
    BEFORE UPDATE OF team_count, league_row_id ON drafts
    WHEN EXISTS (
      SELECT 1 FROM draft_team_ownership dto
      WHERE dto.draft_id = OLD.id AND (
        dto.team_slot > NEW.team_count OR NOT EXISTS (
          SELECT 1 FROM league_memberships lm
          WHERE lm.league_id = NEW.league_row_id AND lm.user_id = dto.user_id
        )
      )
    ) BEGIN
      SELECT RAISE(ABORT, 'draft update would invalidate team ownership');
    END;`);
}

export function down(db) {
  for (const [table, column] of actorColumns) {
    db.exec(`DROP TRIGGER IF EXISTS ${table}_${column}_required_update;
      DROP TRIGGER IF EXISTS ${table}_${column}_required_insert;`);
  }
  db.exec(`DROP TRIGGER IF EXISTS model_experiments_promoter_required_update;
    DROP TRIGGER IF EXISTS validate_draft_ownership_parent_update;
    DROP TRIGGER IF EXISTS cascade_draft_ownership_membership_delete;
    DROP TABLE IF EXISTS model_actor_provenance_quarantine;`);
}
