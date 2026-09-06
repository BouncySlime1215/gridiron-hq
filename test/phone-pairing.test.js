import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-phone-pairing-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/espn-draft.js');
const { default: localAuthRouter, _resetRedeemLimiter } = await import('../server/routes/local-auth.js');
const { default: leaguesRouter } = await import('../server/routes/leagues.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const express = (await import('express')).default;

run(`INSERT INTO leagues (platform, league_id, season, name) VALUES ('espn','777',2026,'Pairing League')`);

const app = express();
app.use(express.json());
app.use('/api/auth', localAuthRouter);
app.use('/api/leagues', ...legacyAuthenticated, leaguesRouter);
const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/api`;
// What every request looks like after cloudflared/ngrok forwards it to 127.0.0.1.
const viaTunnel = { 'X-Forwarded-For': '203.0.113.9', 'CF-Connecting-IP': '203.0.113.9' };
const json = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

let ownerToken;
test('the Mac itself still auto-provisions', async () => {
  const res = await fetch(`${base}/auth/local-session`, { method: 'POST' });
  assert.equal(res.status, 200);
  ownerToken = (await res.json()).token;
  assert.ok(ownerToken);
});

test('a tunnelled request is NOT loopback even though the socket is 127.0.0.1', async () => {
  const res = await fetch(`${base}/auth/local-session`, { method: 'POST', headers: viaTunnel });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).pairing, true);
  for (const path of ['/auth/pairing-code', '/auth/tunnel-url']) {
    const r = await fetch(`${base}${path}`, json({}, { ...viaTunnel, Authorization: `Bearer ${ownerToken}` }));
    assert.equal(r.status, 403, path);
  }
  assert.equal((await fetch(`${base}/auth/pairing-info`, { headers: { ...viaTunnel, Authorization: `Bearer ${ownerToken}` } })).status, 403);
});

test('minting a code needs a signed-in local browser', async () => {
  assert.equal((await fetch(`${base}/auth/pairing-code`, { method: 'POST' })).status, 401);
});

test('a phone redeems a code once for a real session with league access', async () => {
  const mint = await fetch(`${base}/auth/pairing-code`, json({}, { Authorization: `Bearer ${ownerToken}` }));
  assert.equal(mint.status, 200);
  const { code } = await mint.json();
  assert.match(code, /^\d{4}-\d{4}$/);
  assert.equal(row(`SELECT COUNT(*) AS n FROM auth_pairing_codes WHERE used_at IS NULL`).n, 1);

  const info = await fetch(`${base}/auth/pairing-info`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal((await info.json()).active_codes, 1);

  const pair = await fetch(`${base}/auth/pair`, json({ code }, viaTunnel));
  assert.equal(pair.status, 200);
  const phone = await pair.json();
  assert.ok(phone.token && phone.token !== ownerToken);
  assert.equal(phone.expires_in_days, 30);

  const leagues = await fetch(`${base}/leagues`, { headers: { ...viaTunnel, Authorization: `Bearer ${phone.token}` } });
  assert.equal(leagues.status, 200);
  assert.equal((await leagues.json()).length, 1);

  // Burned on first use.
  const again = await fetch(`${base}/auth/pair`, json({ code }, viaTunnel));
  assert.equal(again.status, 401);
});

test('wrong, malformed and expired codes are refused', async () => {
  assert.equal((await fetch(`${base}/auth/pair`, json({ code: '0000-0000' }, viaTunnel))).status, 401);
  assert.equal((await fetch(`${base}/auth/pair`, json({ code: '12' }, viaTunnel))).status, 400);

  const { code } = await (await fetch(`${base}/auth/pairing-code`, json({}, { Authorization: `Bearer ${ownerToken}` }))).json();
  run(`UPDATE auth_pairing_codes SET expires_at = datetime('now', '-1 minute') WHERE used_at IS NULL`);
  assert.equal((await fetch(`${base}/auth/pair`, json({ code }, viaTunnel))).status, 401);
});

test('redeem attempts are rate limited per source', async () => {
  _resetRedeemLimiter();
  let last;
  for (let i = 0; i < 11; i++) last = await fetch(`${base}/auth/pair`, json({ code: '1111-1111' }, viaTunnel));
  assert.equal(last.status, 429);
  // A different source is unaffected.
  const other = await fetch(`${base}/auth/pair`, json({ code: '1111-1111' }, { 'X-Forwarded-For': '198.51.100.4' }));
  assert.equal(other.status, 401);
  _resetRedeemLimiter();
});

test('tunnel url is validated and surfaces in pairing-info', async () => {
  assert.equal((await (await fetch(`${base}/auth/tunnel-url`, json({ url: 'javascript:alert(1)' }))).json()).tunnel_url, null);
  await fetch(`${base}/auth/tunnel-url`, json({ url: 'https://quiet-fox-123.trycloudflare.com' }));
  const info = await (await fetch(`${base}/auth/pairing-info`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json();
  assert.equal(info.tunnel_url, 'https://quiet-fox-123.trycloudflare.com');
});
