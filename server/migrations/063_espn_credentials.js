/**
 * ESPN credentials get an owner (2026-09-19).
 *
 * Until now there was exactly one ESPN identity per install: a global
 * `espn_s2`/`swid` pair in `app_settings` that every code path treated as the
 * account of record, plus a single `espn_connect_token` that any holder could
 * use to overwrite it. That was survivable while the only person who could
 * reach the app was the person who owned the machine. PR #14 made a second
 * account possible, so it is not survivable any more: the first invited person
 * who connects ESPN takes over the one slot, and every sync afterwards runs
 * against their ESPN identity with no error anywhere.
 *
 * It is also not a purely hypothetical harm. `server/services/scheduler.js`
 * carries an investigation from 2026-09-06: Nick's ESPN session kept being
 * kicked during a live draft, and the cause was the hourly roster sweep
 * hitting ESPN with the same cookies his browser was drafting with, precisely
 * because `espnCookies()` was one global lookup. That was worked around with a
 * draft-window gate. This removes the thing the gate works around.
 *
 * `connect_token` lives here rather than in its own table because it is 1:1
 * with the user and pointless without them: it is the value baked into that
 * user's bookmarklet, and it is how a POST arriving from espn.com — which can
 * never carry a session — says which account it is for. A row may exist with a
 * token and no cookies yet; that is a user who generated a bookmarklet and has
 * not used it.
 */
import crypto from 'node:crypto';

export const name = '063_espn_credentials';

/** Same shape as the token this replaces, so an already-minted bookmarklet keeps working. */
const mintToken = () => crypto.randomBytes(24).toString('base64url');

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS espn_credentials (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      espn_s2 TEXT,
      swid TEXT,
      connect_token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      validated_at TEXT
    );
  `);

  // Carry the existing install-wide pair across to the account that already
  // owns everything, so this is not a disconnection.
  //
  // That account is `gridiron-local-owner` (platform/account-link.js), the row
  // every `league_memberships` row and all five ESPN leagues hang off, and the
  // row a Google sign-in as GRIDIRON_ADMIN_EMAIL adopts. If it is absent — a
  // database that never ran the local-auth path — fall back to the
  // commissioner of the most recently fetched ESPN league, which is the same
  // person by any other name. If there is no user at all there is nothing to
  // own the credentials and nothing to migrate; the pair is still removed,
  // because leaving it would leave the borrowing behaviour in place.
  const owner =
    db.prepare(`SELECT id FROM users WHERE subject = 'gridiron-local-owner'`).get()
    ?? db.prepare(`SELECT lm.user_id AS id FROM league_memberships lm
                     JOIN leagues l ON l.id = lm.league_id
                    WHERE l.platform = 'espn' AND lm.role = 'commissioner'
                    ORDER BY l.fetched_at DESC, lm.user_id ASC LIMIT 1`).get();

  if (owner?.id) {
    const setting = k => db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(k)?.value ?? null;
    const s2 = setting('espn_s2');
    const swid = setting('swid');
    // Reuse the existing install token rather than minting a new one: a
    // bookmarklet already sitting in Nick's bookmarks bar carries it, and it
    // now identifies him specifically instead of the install.
    const token = setting('espn_connect_token') ?? mintToken();

    db.prepare(`INSERT INTO espn_credentials (user_id, espn_s2, swid, connect_token, updated_at)
                VALUES (?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)
                ON CONFLICT(user_id) DO NOTHING`)
      .run(owner.id, s2, swid, token, s2);
  }

  // The global slot goes, in the same transaction. Leaving it readable would
  // leave every fallback that reads it working, and a fallback that still
  // works is one nobody removes.
  db.exec(`DELETE FROM app_settings WHERE key IN ('espn_s2', 'swid', 'espn_connect_token')`);
}

export function down(db) {
  // Put the owner's credentials back where the old code looks for them, so a
  // rollback to an image predating this migration is still connected.
  const cred = db.prepare(`SELECT espn_s2, swid, connect_token FROM espn_credentials
                            WHERE espn_s2 IS NOT NULL AND swid IS NOT NULL
                            ORDER BY updated_at DESC, user_id ASC LIMIT 1`).get();
  if (cred) {
    const put = db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)
                            ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    put.run('espn_s2', cred.espn_s2);
    put.run('swid', cred.swid);
    put.run('espn_connect_token', cred.connect_token);
  }
  db.exec(`DROP TABLE IF EXISTS espn_credentials`);
}
