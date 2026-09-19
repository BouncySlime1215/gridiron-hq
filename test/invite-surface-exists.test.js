/**
 * The multi-user API has to have a surface, or the app is still one person's.
 *
 * Google sign-in shipped complete on the server and invisible in the client:
 * `/api/auth/session` knew who you were, `/api/auth/invites` could add someone,
 * `/api/auth/accounts` could disable someone, and no page rendered any of it.
 * The sign-in screen told a rejected visitor "ask Nick to add your address"
 * while the only way to add it was a hand-written HTTP request. That is this
 * project's standing failure mode — a working backend nobody can reach — landing
 * on the one feature whose whole point was that the app stops being single-user.
 *
 * These are source-text checks: they prove the surface exists and is reached
 * with the right guards, not that it renders correctly. Paired with a real
 * assertion that the server still guards the same routes, so the client cannot
 * quietly become the only thing standing between a visitor and an invite list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const panel = read('client/src/components/AccountPanel.tsx');
const settings = read('client/src/pages/Settings.tsx');
const route = read('server/routes/google-auth.js');

test('every account endpoint the server exposes is reachable from the client', () => {
  for (const path of ['/auth/session', '/auth/invites', '/auth/accounts', '/auth/logout']) {
    assert.match(panel, new RegExp(path.replace('/', '\\/')), `${path} has no caller`);
  }
  assert.match(panel, /auth\/invites\/\$\{id\}/, 'an invite can be revoked, not only created');
  assert.match(panel, /auth\/accounts\/\$\{row\.id\}\/disabled/, 'an account can be turned off');
});

test('the panel is actually mounted, not merely written', () => {
  // A component nobody renders is the same defect one level up.
  assert.match(settings, /import AccountPanel/, 'Settings imports it');
  assert.match(settings, /<AccountPanel \/>/, 'and renders it');
});

test('the admin lists are not requested by someone who cannot have them', () => {
  // Both endpoints answer 403 without the model:* grant. Requesting them anyway
  // would put a guaranteed error on the page of every non-admin.
  assert.match(panel, /account\?\.admin === true/, 'the panel reads the admin grant from the session');
  assert.match(panel, /canAdminister \? '\/auth\/invites' : null/,
    'and passes null instead of the path when it is absent');
  assert.match(panel, /canAdminister \? '\/auth\/accounts' : null/);
});

test('invites are offered only where the sign-in they gate exists', () => {
  // An invite is meaningless on an install with no Google sign-in configured:
  // nobody can accept it. `deployment.google` is the server's own answer.
  assert.match(panel, /deployment\?\.google === true/,
    'the invite surface is gated on Google sign-in being configured');
});

test('sign-out clears the token it cannot use any more', () => {
  // A revoked session leaves a token behind that keeps being sent and keeps
  // being rejected, and nothing clears it — the exact failure api.js already
  // guards against on a 401.
  assert.match(panel, /setAuthToken\(null\)/, 'the local token is cleared on sign-out');
});

test('the server still guards the routes this surface calls', () => {
  // The client hides these from a non-admin. That is presentation, never
  // protection, and this test exists so nobody mistakes one for the other.
  for (const line of [
    /r\.get\('\/invites', requireAuthenticated, requirePlatformAdmin/,
    /r\.post\('\/invites', requireAuthenticated, requirePlatformAdmin/,
    /r\.delete\('\/invites\/:id', requireAuthenticated, requirePlatformAdmin/,
    /r\.get\('\/accounts', requireAuthenticated, requirePlatformAdmin/,
    /r\.post\('\/accounts\/:id\/disabled', requireAuthenticated, requirePlatformAdmin/
  ]) {
    assert.match(route, line, 'an admin route lost its guard');
  }
});
