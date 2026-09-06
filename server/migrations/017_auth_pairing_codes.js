export const name = '017_auth_pairing_codes';

/**
 * One-time codes that let a phone (or any browser that is NOT on this Mac)
 * sign in as the local owner. A code is minted only by a caller that is
 * already authenticated over the real loopback interface, is short-lived,
 * and is burned on first use — so exposing the server through a tunnel does
 * not turn the tunnel URL itself into a credential.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_pairing_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE CHECK(length(code_hash) = 64),
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_auth_pairing_codes_user ON auth_pairing_codes(user_id, expires_at);
  `);
}

export function down(db) {
  db.exec(`DROP TABLE IF EXISTS auth_pairing_codes;`);
}
