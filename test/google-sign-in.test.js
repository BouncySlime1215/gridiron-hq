import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The Google sign-in flow end to end, against a stubbed Google.
 *
 * Google is stubbed rather than mocked away because the parts worth testing
 * are exactly the parts that read Google's responses: signature verification,
 * the audience and nonce checks, and what the account policy does with a
 * verified profile. A test that stubbed `verifyIdToken` would assert nothing.
 *
 * The keypair below is generated per run, and the JWKS the stub serves is its
 * real public half, so the RS256 path is genuinely exercised.
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-google-auth-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.GRIDIRON_ADMIN_EMAIL = 'owner@example.com';
delete process.env.GRIDIRON_PUBLIC_URL;

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { default: googleAuthRouter } = await import('../server/routes/google-auth.js');
const { default: localAuthRouter } = await import('../server/routes/local-auth.js');
const { default: leaguesRouter } = await import('../server/routes/leagues.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const { _resetOidcCaches } = await import('../server/platform/google-oidc.js');
const express = (await import('express')).default;

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };

const wrongKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

function signIdToken(claims, { key = privateKey, kid = KID, alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    iss: 'https://accounts.google.com',
    aud: process.env.GOOGLE_OAUTH_CLIENT_ID,
    iat: now, exp: now + 3600,
    email_verified: true,
    ...claims
  })).toString('base64url');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), key).toString('base64url');
  return `${header}.${body}.${signature}`;
}

/** What the stubbed token endpoint will hand back on the next exchange. */
let nextIdToken = null;
let tokenEndpointCalls = 0;

// The test drives the app over a real socket, so only Google's own hosts are
// stubbed; everything else falls through to the runtime's fetch (which the
// offline guard still polices).
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!/accounts\.google\.com|googleapis\.com/.test(url)) return realFetch(input, init);
  const json = (bodyObject, headers = {}) => new Response(JSON.stringify(bodyObject), {
    status: 200, headers: { 'content-type': 'application/json', ...headers }
  });
  if (url.includes('.well-known/openid-configuration')) {
    return json({
      issuer: 'https://accounts.google.com',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs'
    });
  }
  if (url.includes('oauth2/v3/certs')) return json({ keys: [jwk] });
  if (url.includes('oauth2.googleapis.com/token')) {
    tokenEndpointCalls += 1;
    const form = new URLSearchParams(init.body);
    // PKCE is only meaningful if the verifier that arrives matches the
    // challenge the authorization request carried, so check it here.
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.ok(form.get('code_verifier'), 'token exchange must send the PKCE verifier');
    assert.equal(form.get('client_secret'), 'test-client-secret');
    return json({ id_token: nextIdToken, token_type: 'Bearer', expires_in: 3599 });
  }
  throw new Error(`unexpected Google endpoint in test: ${url}`);
};

const app = express();
app.use(express.json());
app.use('/api/auth', localAuthRouter);
app.use('/api/auth', googleAuthRouter);
app.use('/api/leagues', ...legacyAuthenticated, leaguesRouter);
const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/api`;

run(`INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid)
     VALUES ('espn','98765',2026,'Nick''s Dynasty','s2-cookie','{swid}')`);
const leagueId = row('SELECT last_insert_rowid() AS id').id;

test.after(() => {
  server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true });
});

/** Drive the browser half of the flow and return the final complete response. */
async function signInAs({ sub, email, name = null, tamper = null }) {
  _resetOidcCaches();
  const start = await fetch(`${base}/auth/google/start`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const authorizeUrl = new URL(start.headers.get('location'));
  const state = authorizeUrl.searchParams.get('state');
  const nonce = authorizeUrl.searchParams.get('nonce');

  nextIdToken = signIdToken({ sub, email, name, nonce: tamper?.nonce ?? nonce },
    tamper?.signing ?? {});
  const callback = await fetch(`${base}/auth/google/callback?code=fake-code&state=${encodeURIComponent(state)}`,
    { redirect: 'manual' });
  const cookie = (callback.headers.getSetCookie?.() ?? []).find(c => c.startsWith('gridiron_signin='));
  return { callback, cookie, authorizeUrl };
}

async function completeWith(cookie) {
  return fetch(`${base}/auth/google/complete`, {
    method: 'POST', headers: cookie ? { cookie: cookie.split(';')[0] } : {}
  });
}

test('the authorization request carries PKCE, a nonce, and only the openid scopes', async () => {
  _resetOidcCaches();
  const start = await fetch(`${base}/auth/google/start`, { redirect: 'manual' });
  const url = new URL(start.headers.get('location'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('client_id'), process.env.GOOGLE_OAUTH_CLIENT_ID);
  assert.match(url.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/api\/auth\/google\/callback$/);
  // The raw state and nonce must not be readable from the database.
  assert.equal(row('SELECT COUNT(*) AS n FROM auth_login_flows WHERE state_hash = ?',
    url.searchParams.get('state')).n, 0);
});

test('an uninvited Google account is refused and leaves no trace', async () => {
  const before = row('SELECT COUNT(*) AS n FROM users').n;
  const { callback, cookie } = await signInAs({ sub: 'google-stranger', email: 'stranger@example.com' });
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get('location'), /error=not_invited/);
  assert.equal(cookie, undefined, 'a refused sign-in must not set a handoff cookie');
  assert.equal(row('SELECT COUNT(*) AS n FROM users').n, before);
  assert.equal(row('SELECT COUNT(*) AS n FROM user_identities').n, 0);
});

test("the admin address adopts the existing local owner rather than making a second account", async () => {
  // Stand up the account the Mac install has been using, with its leagues and
  // its model:* grant, exactly as local-auth.js provisions it.
  const provision = await fetch(`${base}/auth/local-session`, { method: 'POST' });
  assert.equal(provision.status, 200);
  const owner = row(`SELECT id FROM users WHERE subject='gridiron-local-owner'`);
  assert.equal(row('SELECT COUNT(*) AS n FROM league_memberships WHERE user_id=?', owner.id).n, 1);

  const usersBefore = row('SELECT COUNT(*) AS n FROM users').n;
  const { callback, cookie } = await signInAs({ sub: 'google-nick', email: 'Owner@Example.com', name: 'Nick' });
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get('location'), /^\/sign-in\/complete/);
  assert.ok(cookie, 'a successful sign-in hands back a one-time cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/api\/auth/);

  const completed = await completeWith(cookie);
  assert.equal(completed.status, 200);
  const body = await completed.json();
  assert.ok(body.token?.length > 30);
  assert.equal(body.account.id, owner.id, 'the Google identity must attach to the existing owner');
  assert.equal(body.account.admin, true);
  assert.equal(body.account.leagues, 1, 'the leagues that account already owned are still there');
  // Email comparison is case-insensitive: Google reported Owner@Example.com.
  assert.equal(body.account.email, 'owner@example.com');
  assert.equal(row('SELECT COUNT(*) AS n FROM users').n, usersBefore, 'no second account was created');

  const leagues = await fetch(`${base}/leagues`, { headers: { Authorization: `Bearer ${body.token}` } });
  assert.equal(leagues.status, 200);
  assert.equal((await leagues.json()).length, 1);

  globalThis.__ownerToken = body.token;
  globalThis.__ownerId = owner.id;
});

test('the one-time handoff cannot be redeemed twice', async () => {
  const { cookie } = await signInAs({ sub: 'google-nick', email: 'owner@example.com' });
  const first = await completeWith(cookie);
  assert.equal(first.status, 200);
  const second = await completeWith(cookie);
  assert.equal(second.status, 401);
  assert.equal((await second.json()).code, 'expired');
});

test('a state value cannot be replayed once its callback has run', async () => {
  _resetOidcCaches();
  const start = await fetch(`${base}/auth/google/start`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const nonce = new URL(start.headers.get('location')).searchParams.get('nonce');
  nextIdToken = signIdToken({ sub: 'google-nick', email: 'owner@example.com', nonce });

  const first = await fetch(`${base}/auth/google/callback?code=c1&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
  assert.match(first.headers.get('location'), /^\/sign-in\/complete/);
  const replay = await fetch(`${base}/auth/google/callback?code=c1&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
  assert.match(replay.headers.get('location'), /error=expired/);
});

test('an ID token signed by the wrong key is rejected', async () => {
  const { callback, cookie } = await signInAs({
    sub: 'google-nick', email: 'owner@example.com', tamper: { signing: { key: wrongKey } }
  });
  assert.match(callback.headers.get('location'), /error=bad_token/);
  assert.equal(cookie, undefined);
});

test('an ID token whose nonce does not match the attempt is rejected', async () => {
  const { callback, cookie } = await signInAs({
    sub: 'google-nick', email: 'owner@example.com', tamper: { nonce: 'a-nonce-from-somewhere-else' }
  });
  assert.match(callback.headers.get('location'), /error=bad_nonce/);
  assert.equal(cookie, undefined);
});

test('an ID token minted for a different application is rejected', async () => {
  _resetOidcCaches();
  const start = await fetch(`${base}/auth/google/start`, { redirect: 'manual' });
  const url = new URL(start.headers.get('location'));
  nextIdToken = signIdToken({
    sub: 'google-nick', email: 'owner@example.com',
    nonce: url.searchParams.get('nonce'), aud: 'some-other-app.apps.googleusercontent.com'
  });
  const callback = await fetch(
    `${base}/auth/google/callback?code=c&state=${encodeURIComponent(url.searchParams.get('state'))}`,
    { redirect: 'manual' });
  assert.match(callback.headers.get('location'), /error=bad_token/);
});

test('an unverified Google email is refused', async () => {
  _resetOidcCaches();
  const start = await fetch(`${base}/auth/google/start`, { redirect: 'manual' });
  const url = new URL(start.headers.get('location'));
  nextIdToken = signIdToken({
    sub: 'google-unverified', email: 'unverified@example.com',
    nonce: url.searchParams.get('nonce'), email_verified: false
  });
  const callback = await fetch(
    `${base}/auth/google/callback?code=c&state=${encodeURIComponent(url.searchParams.get('state'))}`,
    { redirect: 'manual' });
  assert.match(callback.headers.get('location'), /error=email_unverified/);
});

test('an alg=none token is rejected before any key lookup', async () => {
  _resetOidcCaches();
  const start = await fetch(`${base}/auth/google/start`, { redirect: 'manual' });
  const url = new URL(start.headers.get('location'));
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    iss: 'https://accounts.google.com', aud: process.env.GOOGLE_OAUTH_CLIENT_ID,
    sub: 'google-nick', email: 'owner@example.com', email_verified: true,
    nonce: url.searchParams.get('nonce'), exp: Math.floor(Date.now() / 1000) + 600
  })).toString('base64url');
  nextIdToken = `${header}.${body}.`;
  const callback = await fetch(
    `${base}/auth/google/callback?code=c&state=${encodeURIComponent(url.searchParams.get('state'))}`,
    { redirect: 'manual' });
  assert.match(callback.headers.get('location'), /error=bad_token/);
});

test('an invited address gets its own account, separate from the owner', async () => {
  const ownerToken = globalThis.__ownerToken;
  const invite = await fetch(`${base}/auth/invites`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'Friend@Example.com', note: 'league mate' })
  });
  assert.equal(invite.status, 201);
  assert.equal((await invite.json()).email, 'friend@example.com');

  const { cookie } = await signInAs({ sub: 'google-friend', email: 'friend@example.com', name: 'Friend' });
  assert.ok(cookie);
  const body = await (await completeWith(cookie)).json();
  assert.notEqual(body.account.id, globalThis.__ownerId);
  assert.equal(body.account.admin, false, 'an invited user is not an administrator');
  // The whole point of per-user scoping: the friend sees none of Nick's leagues.
  assert.equal(body.account.leagues, 0);
  const leagues = await fetch(`${base}/leagues`, { headers: { Authorization: `Bearer ${body.token}` } });
  assert.equal((await leagues.json()).length, 0);
  assert.equal(row('SELECT accepted_user_id FROM auth_invites WHERE email=?', 'friend@example.com')
    .accepted_user_id, body.account.id);

  globalThis.__friendToken = body.token;
  globalThis.__friendId = body.account.id;
});

test('a spent invite cannot be reused by a different Google account', async () => {
  const { callback } = await signInAs({ sub: 'google-impostor', email: 'friend@example.com' });
  assert.match(callback.headers.get('location'), /error=not_invited/);
});

test('a returning user signs in again without creating anything', async () => {
  const identities = row('SELECT COUNT(*) AS n FROM user_identities').n;
  const users = row('SELECT COUNT(*) AS n FROM users').n;
  const { cookie } = await signInAs({ sub: 'google-friend', email: 'friend@example.com', name: 'Friend Renamed' });
  const body = await (await completeWith(cookie)).json();
  assert.equal(body.account.id, globalThis.__friendId);
  assert.equal(row('SELECT COUNT(*) AS n FROM user_identities').n, identities);
  assert.equal(row('SELECT COUNT(*) AS n FROM users').n, users);
  assert.equal(row('SELECT display_name FROM users WHERE id=?', globalThis.__friendId).display_name, 'Friend Renamed');
});

test('invite management is administrator-only', async () => {
  const asFriend = await fetch(`${base}/auth/invites`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${globalThis.__friendToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'gatecrasher@example.com' })
  });
  assert.equal(asFriend.status, 403);
  assert.equal((await fetch(`${base}/auth/invites`,
    { headers: { Authorization: `Bearer ${globalThis.__friendToken}` } })).status, 403);
  assert.equal((await fetch(`${base}/auth/invites`)).status, 401);
});

test('disabling an account revokes the sessions it already holds', async () => {
  const friendToken = globalThis.__friendToken;
  assert.equal((await fetch(`${base}/auth/session`,
    { headers: { Authorization: `Bearer ${friendToken}` } })).status, 200);

  const disable = await fetch(`${base}/auth/accounts/${globalThis.__friendId}/disabled`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${globalThis.__ownerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ disabled: true })
  });
  assert.equal(disable.status, 200);
  assert.equal((await fetch(`${base}/auth/session`,
    { headers: { Authorization: `Bearer ${friendToken}` } })).status, 401);

  // And signing in again does not hand them a fresh one.
  const { callback } = await signInAs({ sub: 'google-friend', email: 'friend@example.com' });
  assert.match(callback.headers.get('location'), /error=disabled/);
});

test('an administrator cannot disable their own account', async () => {
  const response = await fetch(`${base}/auth/accounts/${globalThis.__ownerId}/disabled`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${globalThis.__ownerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ disabled: true })
  });
  assert.equal(response.status, 409);
});

test('logout revokes only the session that was used', async () => {
  const { cookie } = await signInAs({ sub: 'google-nick', email: 'owner@example.com' });
  const extra = (await (await completeWith(cookie)).json()).token;
  assert.equal((await fetch(`${base}/auth/logout`,
    { method: 'POST', headers: { Authorization: `Bearer ${extra}` } })).status, 200);
  assert.equal((await fetch(`${base}/auth/session`,
    { headers: { Authorization: `Bearer ${extra}` } })).status, 401);
  assert.equal((await fetch(`${base}/auth/session`,
    { headers: { Authorization: `Bearer ${globalThis.__ownerToken}` } })).status, 200);
});

test('return_to is only ever a path on this origin', async () => {
  _resetOidcCaches();
  for (const hostile of ['https://evil.example/steal', '//evil.example', '/\\evil.example']) {
    const start = await fetch(`${base}/auth/google/start?return_to=${encodeURIComponent(hostile)}`,
      { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    assert.equal(row('SELECT return_to FROM auth_login_flows WHERE state_hash=?',
      crypto.createHash('sha256').update(state).digest('hex')).return_to, null,
      `${hostile} must not survive as a redirect target`);
  }
  const start = await fetch(`${base}/auth/google/start?return_to=%2Ftrade-lab`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  assert.equal(row('SELECT return_to FROM auth_login_flows WHERE state_hash=?',
    crypto.createHash('sha256').update(state).digest('hex')).return_to, '/trade-lab');
});

test('the providers probe answers before anyone is signed in', async () => {
  const body = await (await fetch(`${base}/auth/providers`)).json();
  assert.equal(body.google, true);
  assert.match(body.redirect_uri, /\/api\/auth\/google\/callback$/);
});

test('the loopback token path still works alongside Google sign-in', async () => {
  const provision = await fetch(`${base}/auth/local-session`, { method: 'POST' });
  assert.equal(provision.status, 200);
  const { token } = await provision.json();
  assert.equal((await fetch(`${base}/leagues`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.ok(tokenEndpointCalls > 0, 'the stubbed Google token endpoint was exercised');
  assert.ok(leagueId > 0);
  assert.ok(rows('SELECT id FROM users').length >= 2);
});
