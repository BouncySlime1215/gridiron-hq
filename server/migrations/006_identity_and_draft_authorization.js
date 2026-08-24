export const name = '006_identity_and_draft_authorization';

export function up(db) {
  const draftCols = db.prepare('PRAGMA table_info(drafts)').all().map(c => c.name);
  if (!draftCols.includes('league_row_id')) db.exec('ALTER TABLE drafts ADD COLUMN league_row_id INTEGER REFERENCES leagues(id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL UNIQUE CHECK(length(trim(subject)) > 0),
      display_name TEXT, disabled_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
      expires_at TEXT NOT NULL, revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
    CREATE TABLE IF NOT EXISTS league_memberships (
      league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member', 'commissioner')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (league_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS draft_team_ownership (
      draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
      team_slot INTEGER NOT NULL CHECK(team_slot > 0),
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (draft_id, team_slot), UNIQUE (draft_id, user_id)
    );
    CREATE TRIGGER IF NOT EXISTS validate_draft_team_owner_insert
    BEFORE INSERT ON draft_team_ownership BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM drafts d JOIN league_memberships lm
          ON lm.league_id = d.league_row_id AND lm.user_id = NEW.user_id
        WHERE d.id = NEW.draft_id AND NEW.team_slot <= d.team_count
      ) THEN RAISE(ABORT, 'draft owner must be a league member with a valid slot') END;
    END;
    -- The legacy database runner does not yet enable PRAGMA foreign_keys.
    -- These triggers make the owned identity relationships enforce and cascade
    -- today, while the REFERENCES clauses remain ready for the global FK audit.
    CREATE TRIGGER IF NOT EXISTS validate_auth_session_user
    BEFORE INSERT ON auth_sessions WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
    BEGIN SELECT RAISE(ABORT, 'auth session user not found'); END;
    CREATE TRIGGER IF NOT EXISTS validate_league_membership_refs
    BEFORE INSERT ON league_memberships WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
      OR NOT EXISTS (SELECT 1 FROM leagues WHERE id = NEW.league_id)
    BEGIN SELECT RAISE(ABORT, 'league membership reference not found'); END;
    CREATE TRIGGER IF NOT EXISTS cascade_user_identity_delete
    AFTER DELETE ON users BEGIN
      DELETE FROM auth_sessions WHERE user_id = OLD.id;
      DELETE FROM league_memberships WHERE user_id = OLD.id;
      DELETE FROM draft_team_ownership WHERE user_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS cascade_league_membership_delete
    AFTER DELETE ON leagues BEGIN DELETE FROM league_memberships WHERE league_id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS cascade_draft_ownership_delete
    AFTER DELETE ON drafts BEGIN DELETE FROM draft_team_ownership WHERE draft_id = OLD.id; END;
  `);
}

// Take a database backup before this intentionally data-destructive rollback.
// league_row_id remains because dropping columns is unsafe on older SQLite builds.
export function down(db) {
  db.exec(`DROP TRIGGER IF EXISTS cascade_draft_ownership_delete;
    DROP TRIGGER IF EXISTS cascade_league_membership_delete;
    DROP TRIGGER IF EXISTS cascade_user_identity_delete;
    DROP TRIGGER IF EXISTS validate_league_membership_refs;
    DROP TRIGGER IF EXISTS validate_auth_session_user;
    DROP TRIGGER IF EXISTS validate_draft_team_owner_insert;
    DROP TABLE IF EXISTS draft_team_ownership; DROP TABLE IF EXISTS league_memberships;
    DROP TABLE IF EXISTS auth_sessions; DROP TABLE IF EXISTS users;
    ALTER TABLE drafts DROP COLUMN league_row_id;`);
}
