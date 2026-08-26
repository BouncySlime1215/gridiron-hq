export const name = '011_league_connection_integrity';

/**
 * Older databases received drafts.league_row_id from an import-time ALTER TABLE
 * before migration 006 could declare its REFERENCES clause. Rebuilding that hot
 * table would risk every draft child table. These triggers enforce the same
 * parent/cascade contract on both old and new databases, while the next clean
 * schema consolidation can make the declaration physical without risking data.
 */
export function up(db) {
  const cols = db.prepare('PRAGMA table_info(leagues)').all().map(c => c.name);
  if (!cols.includes('connection_status')) {
    db.exec(`ALTER TABLE leagues ADD COLUMN connection_status TEXT NOT NULL DEFAULT 'connected'`);
  }
  if (!cols.includes('sync_error')) db.exec('ALTER TABLE leagues ADD COLUMN sync_error TEXT');

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS validate_draft_league_insert
    BEFORE INSERT ON drafts
    WHEN NEW.league_row_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM leagues WHERE id=NEW.league_row_id)
    BEGIN SELECT RAISE(ABORT, 'draft league not found'); END;

    CREATE TRIGGER IF NOT EXISTS validate_draft_league_update
    BEFORE UPDATE OF league_row_id ON drafts
    WHEN NEW.league_row_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM leagues WHERE id=NEW.league_row_id)
    BEGIN SELECT RAISE(ABORT, 'draft league not found'); END;

    CREATE TRIGGER IF NOT EXISTS preserve_league_draft_history
    BEFORE DELETE ON leagues
    WHEN EXISTS (SELECT 1 FROM drafts WHERE league_row_id=OLD.id)
    BEGIN SELECT RAISE(ABORT, 'league has draft history; disconnect or delete drafts first'); END;
  `);
}

export function down(db) {
  db.exec(`DROP TRIGGER IF EXISTS preserve_league_draft_history;
    DROP TRIGGER IF EXISTS validate_draft_league_update;
    DROP TRIGGER IF EXISTS validate_draft_league_insert;`);
  const cols = db.prepare('PRAGMA table_info(leagues)').all().map(c => c.name);
  if (cols.includes('sync_error')) db.exec('ALTER TABLE leagues DROP COLUMN sync_error');
  if (cols.includes('connection_status')) db.exec('ALTER TABLE leagues DROP COLUMN connection_status');
}
