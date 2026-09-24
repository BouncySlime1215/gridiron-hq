import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The administrator grant converges on every sign-in, rather than being made
 * once and never again.
 *
 * `GRIDIRON_ADMIN_EMAIL` is a setting, and a setting that only takes effect if
 * it happened to be right the first time is not a setting, it is a one-time
 * initialisation with a misleading name. The grant used to be made only on the
 * branch of `resolveGoogleAccount` that creates or links an identity; every
 * sign-in after the first takes the existing-identity branch and returns
 * before reaching it. So an account that already carried a Google identity
 * when the address was later pointed at it could never acquire the grant, and
 * nothing anywhere said so.
 *
 * These tests call the policy function directly. The Google half of sign-in is
 * covered end to end in `google-sign-in.test.js`; what is worth isolating here
 * is the policy, which is the part with a decision in it.
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-admin-grant-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
delete process.env.GRIDIRON_OWNER_EMAIL;
process.env.GRIDIRON_ADMIN_EMAIL = 'owner@example.com';

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { resolveGoogleAccount, isAdmin } = await import('../server/platform/account-link.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** An open invite, which is what makes a non-owner address able to sign in at all. */
const invite = email => run(`INSERT INTO auth_invites (email) VALUES (?)`, email);

const signIn = (subject, email) =>
  resolveGoogleAccount({ subject, email, displayName: null, avatarUrl: null });

const adminRows = userId =>
  rows(`SELECT permission FROM model_permissions WHERE user_id=? AND permission='model:*'`, userId);

/** Point the setting somewhere, run something, and put it back. */
function withAdminEmail(value, fn) {
  const before = process.env.GRIDIRON_ADMIN_EMAIL;
  if (value === null) delete process.env.GRIDIRON_ADMIN_EMAIL;
  else process.env.GRIDIRON_ADMIN_EMAIL = value;
  try { return fn(); } finally { process.env.GRIDIRON_ADMIN_EMAIL = before; }
}

test('THE BUG: an account that already has a Google identity acquires the grant when the setting is later pointed at it', () => {
  // Nick signs in under an invite first, while the setting names someone else
  // entirely. This is the ordinary case on a deployment that was invited into
  // before GRIDIRON_ADMIN_EMAIL was ever set on the machine.
  invite('nick@example.com');
  const first = withAdminEmail('someone-else@example.com', () => signIn('google-nick', 'nick@example.com'));
  assert.equal(first.created, true);
  assert.equal(first.admin, false, 'no grant yet: the address did not name him at the time');

  // The setting is corrected to his address. Every sign-in from here takes the
  // existing-identity branch, which is exactly the branch that used to return
  // without ever looking at the address.
  const second = withAdminEmail('nick@example.com', () => signIn('google-nick', 'nick@example.com'));

  assert.equal(second.userId, first.userId, 'still the same account, not a second one');
  assert.equal(second.created, false);
  assert.equal(second.linked, false);
  assert.equal(second.admin, true, 'the grant arrives on the sign-in after the setting was corrected');
  assert.equal(isAdmin(first.userId), true);
});

test('the grant is asserted once, not accumulated on every sign-in', () => {
  const user = row(`SELECT user_id FROM user_identities WHERE provider_subject='google-nick'`).user_id;
  withAdminEmail('nick@example.com', () => {
    signIn('google-nick', 'nick@example.com');
    signIn('google-nick', 'nick@example.com');
  });
  assert.equal(adminRows(user).length, 1, 'INSERT OR IGNORE, so repeated sign-ins leave one row');
});

test('an invited account that the setting does not name never acquires the grant, however often it signs in', () => {
  invite('guest@example.com');
  const first = signIn('google-guest', 'guest@example.com');
  assert.equal(first.admin, false);

  for (let i = 0; i < 3; i++) signIn('google-guest', 'guest@example.com');

  assert.equal(isAdmin(first.userId), false);
  assert.equal(adminRows(first.userId).length, 0);
});

test('an empty administrator address is not a wildcard', () => {
  // An empty string is the shape this setting takes when a Fly secret is unset
  // rather than absent, and `adminEmail()` folds it to null. The convergent
  // grant reads the same setting on every sign-in now, so "blank" getting read
  // as "matches everyone" would hand the grant to each returning account in
  // turn -- which is the failure this whole change could plausibly introduce.
  const guest = row(`SELECT user_id FROM user_identities WHERE provider_subject='google-guest'`).user_id;
  assert.equal(isAdmin(guest), false, 'precondition: the guest holds no grant');

  withAdminEmail('', () => {
    signIn('google-guest', 'guest@example.com');
    // And an address nobody invited is still refused outright, rather than
    // being treated as the owner.
    assert.throws(() => signIn('google-stranger', 'stranger@example.com'), /has not been invited/);
  });

  assert.equal(isAdmin(guest), false, 'a returning account gains nothing off a blank setting');
  assert.equal(row(`SELECT 1 AS found FROM users WHERE email='stranger@example.com'`)?.found, undefined,
    'and the refused attempt left no row behind');
});

test('changing the setting does NOT revoke anyone: that is a different policy against a table this module does not own', () => {
  const nick = row(`SELECT user_id FROM user_identities WHERE provider_subject='google-nick'`).user_id;
  const guest = row(`SELECT user_id FROM user_identities WHERE provider_subject='google-guest'`).user_id;

  // A narrower grant, of the kind platform/provision-auth.js hands out. It has
  // nothing to do with the administrator address and must survive untouched.
  run(`INSERT OR IGNORE INTO model_permissions (user_id, permission) VALUES (?, 'model:train')`, guest);

  withAdminEmail('guest@example.com', () => {
    signIn('google-guest', 'guest@example.com');
    signIn('google-nick', 'nick@example.com');
  });

  assert.equal(isAdmin(guest), true, 'the newly named address gains the grant');
  assert.equal(isAdmin(nick), true, 'the previously named one keeps it: nothing here withdraws a permission');
  assert.equal(
    row(`SELECT 1 AS found FROM model_permissions WHERE user_id=? AND permission='model:train'`, guest)?.found,
    1, 'a narrower grant is untouched');
});
