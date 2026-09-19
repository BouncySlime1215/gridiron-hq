import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The account surface, driven over a real socket against the real routes.
 *
 * `test/invite-surface-exists.test.js` proves the client calls these endpoints
 * and that the server still names a guard on each. That is presentation checked
 * and behaviour assumed, which is this project's standing failure mode sitting
 * inside the PR that was meant to end it — so this file exercises the behaviour
 * the panel claims, on a server that is actually listening.
 *
 * Three claims are made in `AccountPanel.tsx` copy and nowhere tested:
 *
 *   1. The admin lists are admin-only, so the panel withholds the request
 *      rather than putting a guaranteed error on every non-admin's page. If the
 *      server answered them to anyone, the panel's `canAdminister` gate would be
 *      the only thing between a visitor and the invite list — presentation
 *      standing in for protection.
 *   2. "Turning one off ends its sessions immediately rather than only blocking
 *      the next sign-in." That is a claim about an existing browser, not about
 *      a future login, and it is the one a reader would act on.
 *   3. Signing out ends the session it was made with, and only that one, while
 *      signing out everywhere ends all of them.
 *
 * `requirePlatformAdmin` reads the persisted `model:*` grant
 * (legacy-access.js:27) rather than anything a caller supplies, so the admin
 * here is seeded the way production seeds it: a row in `model_permissions`,
 * which is what `grantAdmin` writes on the owner's first sign-in.
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-account-surface-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { default: googleAuthRouter } = await import('../server/routes/google-auth.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/auth', googleAuthRouter);
app.use((err, _req, res, _next) => res.status(Number.isInteger(err.status) ? err.status : 500)
  .json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;

function account(subject, email, ...tokens) {
  run('INSERT INTO users (subject, display_name, email) VALUES (?,?,?)', subject, subject, email);
  const id = row('SELECT last_insert_rowid() AS id').id;
  for (const token of tokens) {
    run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at)
         VALUES (?,?,datetime('now','+1 day'))`, id, hashSessionToken(token));
  }
  return id;
}

// Exactly what grantAdmin writes, and what requirePlatformAdmin reads.
const owner = account('owner', 'nick@example.com', 'owner-token');
run("INSERT INTO model_permissions (user_id, permission) VALUES (?, 'model:*')", owner);
const guest = account('guest', 'friend@example.com', 'guest-token', 'guest-phone');

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const as = token => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const get = (p, token) => fetch(`${base}${p}`, { headers: as(token) });
const post = (p, token, body) => fetch(`${base}${p}`,
  { method: 'POST', headers: as(token), body: JSON.stringify(body ?? {}) });

test('an account with no admin grant is refused every admin endpoint', async () => {
  // The panel hides these. That is presentation, never protection, and this is
  // the assertion that says so.
  assert.equal((await get('/auth/invites', 'guest-token')).status, 403);
  assert.equal((await post('/auth/invites', 'guest-token', { email: 'x@y.co' })).status, 403);
  assert.equal((await get('/auth/accounts', 'guest-token')).status, 403);
  assert.equal((await post(`/auth/accounts/${owner}/disabled`, 'guest-token', { disabled: true })).status, 403);
  const del = await fetch(`${base}/auth/invites/1`, { method: 'DELETE', headers: as('guest-token') });
  assert.equal(del.status, 403);
  // And the refusal did not take effect anyway.
  assert.equal(row('SELECT disabled_at FROM users WHERE id=?', owner).disabled_at, null);
});

test('an anonymous caller gets 401, not 403 — the guards are in the right order', async () => {
  // A 403 here would mean the admin check ran before anyone was identified.
  assert.equal((await fetch(`${base}/auth/invites`)).status, 401);
  assert.equal((await fetch(`${base}/auth/accounts`)).status, 401);
  assert.equal((await fetch(`${base}/auth/session`)).status, 401);
});

test('the admin can invite, and the panel reads back what it wrote', async () => {
  const created = await post('/auth/invites', 'owner-token', { email: 'NewGuy@Gmail.com ', note: 'league mate' });
  assert.equal(created.status, 201);
  const list = await (await get('/auth/invites', 'owner-token')).json();
  const invite = list.find(i => i.email === 'newguy@gmail.com');
  assert.ok(invite, 'the address is lowercased on the way in, which is what Google reports');
  assert.equal(invite.note, 'league mate');
  assert.equal(invite.accepted_at, null);
  assert.equal(invite.revoked_at, null);
  // The panel renders `open until <date>`, so an expiry has to exist to render.
  assert.ok(invite.expires_at, 'an invite carries an expiry the panel can show');

  const revoked = await fetch(`${base}/auth/invites/${invite.id}`, { method: 'DELETE', headers: as('owner-token') });
  assert.equal(revoked.status, 200);
  const after = await (await get('/auth/invites', 'owner-token')).json();
  assert.ok(after.find(i => i.id === invite.id).revoked_at, 'and the panel can see it is revoked');
});

test('turning an account off ends the session already in that browser', async () => {
  // The claim in the panel's own words. A disabled account whose existing token
  // kept working would mean access stops in 30 days, not when you press it.
  //
  // What this test does NOT prove, established by running it against a copy with
  // the revoke removed: it still passes. `resolveAuthenticatedUser` requires
  // `u.disabled_at IS NULL` (auth.js:22), so the flag alone ends every lookup and
  // the explicit revoke is belt and braces. The test below is the one that holds
  // the revoke, and it is separate for that reason rather than by accident.
  assert.equal((await get('/auth/session', 'guest-token')).status, 200);
  assert.equal((await get('/auth/session', 'guest-phone')).status, 200);

  const off = await post(`/auth/accounts/${guest}/disabled`, 'owner-token', { disabled: true });
  assert.equal(off.status, 200);

  assert.equal((await get('/auth/session', 'guest-token')).status, 401, 'the browser is out');
  assert.equal((await get('/auth/session', 'guest-phone')).status, 401, 'and so is the phone');
  assert.equal((await get('/auth/invites', 'guest-token')).status, 401);
});

test('turning it back on does not silently restore the old sessions', async () => {
  // This is the test that holds the explicit revoke in the disable handler.
  // Re-enabling clears `disabled_at`, so the only thing still keeping the old
  // token dead is `revoked_at` — remove the revoke and this goes red while the
  // test above stays green. A person who was turned off and back on signs in
  // again; their old browser does not silently resume.
  assert.equal((await post(`/auth/accounts/${guest}/disabled`, 'owner-token', { disabled: false })).status, 200);
  assert.equal(row('SELECT disabled_at FROM users WHERE id=?', guest).disabled_at, null);
  assert.equal((await get('/auth/session', 'guest-token')).status, 401,
    'the old token stays dead — being re-enabled is not being signed back in');
});

test('the admin cannot lock themselves out', async () => {
  const self = await post(`/auth/accounts/${owner}/disabled`, 'owner-token', { disabled: true });
  assert.equal(self.status, 409);
  assert.equal((await get('/auth/session', 'owner-token')).status, 200);
});

test('signing out ends this session and leaves the other one alone', async () => {
  const id = account('twodevice', 'two@example.com', 'device-a', 'device-b');
  assert.equal((await get('/auth/session', 'device-a')).status, 200);
  assert.equal((await post('/auth/logout', 'device-a')).status, 200);
  assert.equal((await get('/auth/session', 'device-a')).status, 401);
  assert.equal((await get('/auth/session', 'device-b')).status, 200, 'the other device is untouched');

  assert.equal((await post('/auth/logout-all', 'device-b')).status, 200);
  assert.equal((await get('/auth/session', 'device-b')).status, 401);
  assert.equal(row('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL', id).n, 0);
});

test('the session the panel renders carries the admin flag it gates on', async () => {
  // `canAdminister` is `account?.admin === true`. If the summary stopped
  // carrying it, the panel would hide the invite surface from the only person
  // who can use it, silently.
  const mine = await (await get('/auth/session', 'owner-token')).json();
  assert.equal(mine.authenticated, true);
  assert.equal(mine.account.admin, true);
  // A fresh non-admin session, because the guest's tokens were revoked earlier
  // and a 401 would prove nothing about the flag.
  account('plainuser', 'plain@example.com', 'plain-token');
  const res = await get('/auth/session', 'plain-token');
  assert.equal(res.status, 200);
  const theirs = await res.json();
  assert.notEqual(theirs.account.admin, true,
    'a non-admin must not carry the flag the invite surface is gated on');
});
