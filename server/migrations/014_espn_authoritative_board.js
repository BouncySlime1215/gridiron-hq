export const name = '014_espn_authoritative_board';

function addColumn(db, table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
  if (!columns.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

export function up(db) {
  // These pick columns were historically added when espn-draft.js was imported.
  // Declare them here so an offline/fresh migration has deterministic ordering.
  addColumn(db, 'draft_picks', 'espn_team_id', 'INTEGER');
  addColumn(db, 'draft_picks', 'keeper', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'drafts', 'espn_snapshot_hash', 'TEXT');
  addColumn(db, 'drafts', 'espn_snapshot_pick_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'drafts', 'espn_board_revision', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_draft_picks_espn_board
    ON draft_picks(draft_id, pick_number, espn_team_id)`);
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_draft_picks_espn_board;
    ALTER TABLE drafts DROP COLUMN espn_board_revision;
    ALTER TABLE drafts DROP COLUMN espn_snapshot_pick_count;
    ALTER TABLE drafts DROP COLUMN espn_snapshot_hash;`);
}
