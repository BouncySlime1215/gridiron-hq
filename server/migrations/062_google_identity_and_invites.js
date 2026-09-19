export const name = '062_google_identity_and_invites';

/**
 * Real accounts: a user can now be established by an external identity
 * provider (Google) instead of only by the loopback pairing flow in
 * `local-auth.js`.
 *
 * Nothing about sessions changes. `auth_sessions` already does tokens,
 * expiry and revocation, and `resolveAuthenticatedUser` already turns a
 * bearer token into `req.auth.userId`. What was missing was a second way to
 * decide WHICH user a new session belongs to. That is all `user_identities`
 * is: a join from (provider, provider subject) to an existing `users` row.
 *
 * Why a separate table rather than columns on `users`: one person can hold
 * several identities (a Google account today, something else later), and
 * `users.subject` is already spoken for by the local owner's fixed
 * `gridiron-local-owner` value. Keeping the provider subject out of
 * `users.subject` is what lets Nick's Google account attach to the account
 * that already owns his five leagues, instead of creating a second one.
 *
 * `auth_invites` exists because the plan is explicit that sign-up is
 * invite-only — no open registration. An email with no invite and no admin
 * match is refused at the callback, before any row is written.
 *
 * `auth_login_flows` holds the short-lived per-attempt secrets (CSRF state,
 * OIDC nonce, PKCE verifier) and the one-time handoff code the browser
 * redeems for its bearer token. They live in SQLite rather than process
 * memory so a Fly machine that restarts, or scales past one machine,
 * does not strand a sign-in that is halfway through.
 */
export function up(db) {
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  // Email is on `users`, not only on the identity, because invites and the
  // admin bootstrap both match on it before any identity exists.
  if (!userCols.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  if (!userCols.includes('avatar_url')) db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
  if (!userCols.includes('last_login_at')) db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('google')),
      -- Google's 'sub'. Stable for the life of the account and never reused,
      -- which email is not: people change the address on a Google account.
      provider_subject TEXT NOT NULL CHECK(length(trim(provider_subject)) > 0),
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1)),
      display_name TEXT,
      avatar_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT,
      UNIQUE (provider, provider_subject)
    );
    CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);
    -- One Google account cannot be attached to two local accounts. Without
    -- this, a second sign-in that raced the first would silently fork the
    -- identity and split one person's leagues across two user rows.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_provider_user
      ON user_identities(provider, user_id);

    CREATE TABLE IF NOT EXISTS auth_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Stored lowercased; the callback lowercases before comparing, so an
      -- invite to Nick@example.com matches a sign-in as nick@example.com.
      email TEXT NOT NULL,
      invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      accepted_at TEXT,
      accepted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      revoked_at TEXT
    );
    -- Only one live invite per address. Accepted and revoked rows stay as an
    -- audit trail, so the uniqueness is partial rather than on the column.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_invites_open_email
      ON auth_invites(email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS auth_login_flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Only digests are stored, same discipline as auth_sessions and
      -- auth_pairing_codes: a database read must not yield a usable secret.
      state_hash TEXT NOT NULL UNIQUE CHECK(length(state_hash) = 64),
      nonce_hash TEXT NOT NULL CHECK(length(nonce_hash) = 64),
      code_verifier TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      return_to TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      -- Set at the callback: the browser redeems this once, over its own
      -- cookie, for the bearer token. The token itself never travels in a URL.
      handoff_hash TEXT UNIQUE,
      handoff_expires_at TEXT,
      handoff_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      handoff_redeemed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auth_login_flows_expiry ON auth_login_flows(expires_at);

    CREATE TRIGGER IF NOT EXISTS validate_user_identity_user
    BEFORE INSERT ON user_identities WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
    BEGIN SELECT RAISE(ABORT, 'identity user not found'); END;
    CREATE TRIGGER IF NOT EXISTS cascade_user_identity_on_user_delete
    AFTER DELETE ON users BEGIN
      DELETE FROM user_identities WHERE user_id = OLD.id;
      DELETE FROM auth_login_flows WHERE handoff_user_id = OLD.id;
    END;
  `);
}

export function down(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS cascade_user_identity_on_user_delete;
    DROP TRIGGER IF EXISTS validate_user_identity_user;
    DROP INDEX IF EXISTS idx_auth_login_flows_expiry;
    DROP TABLE IF EXISTS auth_login_flows;
    DROP INDEX IF EXISTS idx_auth_invites_open_email;
    DROP TABLE IF EXISTS auth_invites;
    DROP INDEX IF EXISTS idx_user_identities_provider_user;
    DROP INDEX IF EXISTS idx_user_identities_user;
    DROP TABLE IF EXISTS user_identities;
  `);
  // users.email / avatar_url / last_login_at remain: dropping columns is
  // unsafe on older SQLite builds, same reasoning as migration 006's down().
}
