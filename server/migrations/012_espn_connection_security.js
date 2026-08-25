export const name = '012_espn_connection_security';

// League removal (leagues.js DELETE /:id) retains draft/model evidence for ESPN
// leagues and only clears the connection, so any isolated credential record for
// that league must be removable independently of the leagues row it references.
export function up(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS espn_credentials (
    league_id INTEGER PRIMARY KEY REFERENCES leagues(id) ON DELETE CASCADE,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL, iv TEXT NOT NULL, auth_tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

export function down(db) {
  db.exec(`DROP TABLE IF EXISTS espn_credentials;`);
}
