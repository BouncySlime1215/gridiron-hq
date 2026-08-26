export const name = '013_espn_live_draft_setup';

function addColumn(db, table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
  if (!columns.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

export function up(db) {
  // These columns predate versioned migrations and were historically created when
  // espn-draft.js happened to be imported. Declare them here as well so migrations
  // are deterministic for fresh databases and offline migration commands.
  addColumn(db, 'drafts', 'espn_league_id', 'TEXT');
  addColumn(db, 'drafts', 'season', 'INTEGER');
  addColumn(db, 'drafts', 'pick_order', 'TEXT');
  addColumn(db, 'drafts', 'roster_slots', 'TEXT');
  addColumn(db, 'drafts', 'last_synced_at', 'TEXT');
  addColumn(db, 'drafts', 'draft_at', 'TEXT');
  addColumn(db, 'drafts', 'espn_draft_status', 'TEXT');
  addColumn(db, 'drafts', 'espn_draft_type', 'TEXT');
  addColumn(db, 'drafts', 'espn_team_id', 'TEXT');
  addColumn(db, 'drafts', 'espn_ownership_source', 'TEXT');
  addColumn(db, 'drafts', 'setup_synced_at', 'TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS espn_team_confirmations (
      league_row_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      espn_team_id TEXT NOT NULL CHECK(length(trim(espn_team_id)) > 0),
      confirmed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (league_row_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS espn_live_draft_identity (
      league_row_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      season INTEGER NOT NULL,
      draft_id INTEGER NOT NULL UNIQUE REFERENCES drafts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (league_row_id, season)
    );
    INSERT OR IGNORE INTO espn_live_draft_identity (league_row_id, season, draft_id)
      SELECT league_row_id, season, MIN(id)
      FROM drafts
      WHERE type='live' AND league_row_id IS NOT NULL AND season IS NOT NULL
      GROUP BY league_row_id, season;
  `);
}

export function down(db) {
  db.exec(`
    DROP TABLE IF EXISTS espn_live_draft_identity;
    DROP TABLE IF EXISTS espn_team_confirmations;
    ALTER TABLE drafts DROP COLUMN setup_synced_at;
    ALTER TABLE drafts DROP COLUMN espn_ownership_source;
    ALTER TABLE drafts DROP COLUMN espn_team_id;
    ALTER TABLE drafts DROP COLUMN espn_draft_type;
    ALTER TABLE drafts DROP COLUMN espn_draft_status;
  `);
}
