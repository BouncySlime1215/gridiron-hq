import { db, row, rows, run } from '../db/index.js';
import { AuthorizationError } from './auth.js';

/**
 * Decides which `users` row a verified Google identity belongs to.
 *
 * Kept apart from the route because this is the part with actual policy in
 * it, and the policy is the thing worth testing directly: sign-up is
 * invite-only, and Nick's Google account must land on the account that
 * already owns his leagues rather than on a fresh empty one.
 */

/** The subject `local-auth.js` provisions for the loopback owner. */
export const LOCAL_SUBJECT = 'gridiron-local-owner';

/**
 * The one address allowed to claim an account without an invite. Set as a Fly
 * secret. Deliberately a single address and not a domain: a domain allow-list
 * would be open registration for anyone with a work address.
 */
export function adminEmail() {
  const value = process.env.GRIDIRON_ADMIN_EMAIL || process.env.GRIDIRON_OWNER_EMAIL || '';
  return value.trim().toLowerCase() || null;
}

export class SignInRefused extends AuthorizationError {
  constructor(message, code) { super(message); this.code = code; }
}

function grantAdmin(userId) {
  run(`INSERT OR IGNORE INTO model_permissions (user_id, permission) VALUES (?, 'model:*')`, userId);
}

export function isAdmin(userId) {
  return Boolean(row('SELECT 1 FROM model_permissions WHERE user_id=? AND permission=?', userId, 'model:*'));
}

function openInviteFor(email) {
  return row(`SELECT id, invited_by FROM auth_invites
    WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))`, email);
}

/**
 * The account that already holds Nick's data, if this is his first Google
 * sign-in. `local-auth.js` has only ever provisioned one subject, and every
 * league membership, draft ownership and model permission on this deployment
 * hangs off it. Attaching the identity to that row rather than creating a new
 * one is why no data has to move: the five ESPN leagues, the `model:*` grant
 * and every `league_memberships` row stay exactly where they are.
 *
 * Only ever done for the admin address, and only while that row has no Google
 * identity of its own — so a second person signing in can never inherit it.
 */
function adoptableLocalOwner() {
  const owner = row('SELECT id FROM users WHERE subject = ?', LOCAL_SUBJECT);
  if (!owner) return null;
  const taken = row(`SELECT 1 FROM user_identities WHERE provider='google' AND user_id=?`, owner.id);
  return taken ? null : owner;
}

/**
 * Resolve a verified Google profile to a user id, creating or linking as the
 * policy allows. Runs in one transaction: a half-linked identity would let
 * the next attempt fork the account.
 *
 * @param {{subject: string, email: string, displayName: string|null, avatarUrl: string|null}} profile
 * @returns {{userId: number, created: boolean, linked: boolean, admin: boolean}}
 */
export function resolveGoogleAccount(profile) {
  const email = String(profile.email).trim().toLowerCase();
  const subject = String(profile.subject);

  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = row(`SELECT id, user_id FROM user_identities
      WHERE provider='google' AND provider_subject=?`, subject);

    if (existing) {
      const user = row('SELECT id, disabled_at FROM users WHERE id=?', existing.user_id);
      if (!user) throw new SignInRefused('this account no longer exists', 'no_account');
      if (user.disabled_at) throw new SignInRefused('this account has been disabled', 'disabled');
      // Refresh the mutable half of the profile on every sign-in. The subject
      // is what identity means here; name, picture and even the address are
      // just the current display of it and are allowed to change at Google.
      run(`UPDATE user_identities SET email=?, email_verified=1, display_name=?, avatar_url=?,
             last_login_at=datetime('now') WHERE id=?`,
        email, profile.displayName ?? null, profile.avatarUrl ?? null, existing.id);
      run(`UPDATE users SET email=?, display_name=COALESCE(?, display_name),
             avatar_url=COALESCE(?, avatar_url), last_login_at=datetime('now') WHERE id=?`,
        email, profile.displayName ?? null, profile.avatarUrl ?? null, user.id);

      // The admin grant converges; it is not one-shot. It used to be made only
      // on the branch below, the one that creates or links an identity, so an
      // account that ALREADY carried a Google identity when
      // GRIDIRON_ADMIN_EMAIL was pointed at its address could never acquire
      // the grant: every sign-in after the first takes this branch and returns
      // before reaching it. The address is the policy, so re-asserting it on
      // each sign-in is what makes the setting mean what it says.
      //
      // Only the grant converges, never a revocation, and that asymmetry is
      // deliberate. `model_permissions` also holds narrower grants that were
      // never about this address at all -- `model:train`, `model:promote`,
      // `model:execute`, handed out by platform/provision-auth.js -- so
      // "withdraw what the address no longer justifies" is a different policy
      // against a table this one does not own. It also fails far worse: a
      // mistyped GRIDIRON_ADMIN_EMAIL would lock the real administrator out on
      // their next sign-in, and the fix for that would itself need an admin.
      if (adminEmail() != null && email === adminEmail()) grantAdmin(user.id);

      db.exec('COMMIT');
      return { userId: user.id, created: false, linked: false, admin: isAdmin(user.id) };
    }

    const invite = openInviteFor(email);
    const isOwner = adminEmail() != null && email === adminEmail();
    if (!invite && !isOwner) {
      // Refused before any row is written: an uninvited sign-in leaves nothing
      // behind at all, not a disabled user and not an audit-only shell.
      throw new SignInRefused('this Google account has not been invited to Gridiron HQ', 'not_invited');
    }

    let userId;
    let created = false;
    let linked = false;

    const adopt = isOwner ? adoptableLocalOwner() : null;
    if (adopt) {
      userId = adopt.id;
      linked = true;
      run(`UPDATE users SET email=?, display_name=COALESCE(?, display_name),
             avatar_url=COALESCE(?, avatar_url), last_login_at=datetime('now') WHERE id=?`,
        email, profile.displayName ?? null, profile.avatarUrl ?? null, userId);
    } else {
      const byEmail = row('SELECT id, disabled_at FROM users WHERE lower(email) = ?', email);
      if (byEmail) {
        if (byEmail.disabled_at) throw new SignInRefused('this account has been disabled', 'disabled');
        userId = byEmail.id;
        linked = true;
        run(`UPDATE users SET display_name=COALESCE(?, display_name), avatar_url=COALESCE(?, avatar_url),
               last_login_at=datetime('now') WHERE id=?`,
          profile.displayName ?? null, profile.avatarUrl ?? null, userId);
      } else {
        // `users.subject` is UNIQUE and already means "the local owner" for one
        // fixed value, so an external identity gets a namespaced subject of its
        // own instead of overloading that column.
        run(`INSERT INTO users (subject, display_name, email, avatar_url, last_login_at)
             VALUES (?,?,?,?,datetime('now'))`,
          `google:${subject}`, profile.displayName ?? email, email, profile.avatarUrl ?? null);
        userId = row('SELECT last_insert_rowid() AS id').id;
        created = true;
      }
    }

    run(`INSERT INTO user_identities (user_id, provider, provider_subject, email, email_verified,
           display_name, avatar_url, last_login_at)
         VALUES (?, 'google', ?, ?, 1, ?, ?, datetime('now'))`,
      userId, subject, email, profile.displayName ?? null, profile.avatarUrl ?? null);

    if (invite) {
      run(`UPDATE auth_invites SET accepted_at=datetime('now'), accepted_user_id=? WHERE id=?`, userId, invite.id);
    }
    if (isOwner) grantAdmin(userId);

    db.exec('COMMIT');
    return { userId, created, linked, admin: isAdmin(userId) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Everything the client needs to render "who am I", and nothing more. */
export function accountSummary(userId) {
  const user = row(`SELECT id, display_name, email, avatar_url, created_at, last_login_at
    FROM users WHERE id=?`, userId);
  if (!user) return null;
  return {
    id: user.id,
    display_name: user.display_name,
    email: user.email,
    avatar_url: user.avatar_url,
    admin: isAdmin(userId),
    providers: rows(`SELECT provider, email, last_login_at FROM user_identities WHERE user_id=?`, userId),
    leagues: row('SELECT COUNT(*) AS n FROM league_memberships WHERE user_id=?', userId).n,
    created_at: user.created_at,
    last_login_at: user.last_login_at
  };
}
