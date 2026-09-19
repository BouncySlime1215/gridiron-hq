/**
 * The ESPN-connect and page-explain routes are reachable through the public tunnel —
 * and, as of the Fly.io self-host, potentially a stable public hostname, not just an
 * ephemeral tunnel URL.
 *
 * Both routers are mounted in server/index.js with no auth wrapper
 * (`app.use('/api/espn-connect', espnConnectRouter)`, `app.use('/api/betting',
 * bettingHubRouter)`), so these tests mount them exactly that way and check the
 * guards the routers now carry themselves:
 *   - anyone with the URL could list the leagues and cookie previews (GET /status),
 *     wipe the ESPN cookies (DELETE /cookies), rewrite which roster is Nick's
 *     (POST /add upserts my_team_id), or call ESPN with his cookies (GET /discover);
 *   - anyone could run the Claude page assistant on Nick's API key with a 100 kB
 *     prompt (POST /betting/explain/page) and read the stored answers.
 * POST /cookies (and its preflight) is a special case, covered in its own test
 * below and in more detail in test/espn-connect.test.js: it can't require a session
 * outright (the bookmarklet runs on espn.com and never had one), so it instead
 * requires either a session OR the per-install token that only a signed-in caller's
 * own /bookmarklet response ever contains.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ServerResponse } from 'node:http';
import { Readable, PassThrough } from 'node:stream';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-espn-connect-auth-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
delete process.env.ANTHROPIC_API_KEY;

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { default: espnConnectRouter } = await import('../server/routes/espn-connect.js');
const { default: bettingHubRouter } = await import('../server/routes/betting-hub.js');

const app = express();
app.use(express.json());
// Exactly as server/index.js mounts them.
app.use('/api/espn-connect', espnConnectRouter);
app.use('/api/betting', bettingHubRouter);
app.use((err, _req, res, _next) => res.status(Number.isInteger(err.status) ? err.status : 500).json({ error: err.message }));

const TOKEN = 'espn-connect-auth-token';
before(async () => {
  await runMigrations();
  db.prepare(`INSERT OR IGNORE INTO users(id,subject,display_name) VALUES (992,'espn-connect-user','Connect User')`).run();
  db.prepare(`INSERT OR REPLACE INTO auth_sessions(user_id,token_hash,expires_at) VALUES (992,?,datetime('now','+1 day'))`)
    .run(hashSessionToken(TOKEN));
  run(`INSERT INTO app_settings (key, value) VALUES ('espn_s2', 'AEBsecretS2value1234567890'), ('swid', '{ABCDEF12-3456-7890-ABCD-EF1234567890}')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, espn_s2, swid)
       VALUES (41, 'espn', '555', 2026, 'Home league', '7', 'AEBsecretS2value1234567890', '{ABCDEF12-3456-7890-ABCD-EF1234567890}')`);
});
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function request(method, url, { token, body, headers = {} } = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = new Readable({ read() { if (payload) this.push(payload); this.push(null); } });
  req.url = url; req.method = method;
  req.headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
    ...headers
  };
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      resolve({ status: res.statusCode, json, text });
    };
    app.handle(req, res, reject);
  });
}

test('anonymous callers cannot read, wipe, rebind or use the ESPN connection', async () => {
  for (const [method, url, body] of [
    ['GET', '/api/espn-connect/status'],
    ['GET', '/api/espn-connect/bookmarklet'],
    ['GET', '/api/espn-connect/discover'],
    ['DELETE', '/api/espn-connect/cookies'],
    ['POST', '/api/espn-connect/add', { league_id: '555', season: 2026, my_team_id: '3' }]
  ]) {
    const res = await request(method, url, { body });
    assert.equal(res.status, 401, `${method} ${url} must require a session (got ${res.status})`);
  }
  // Nothing was changed by the anonymous calls.
  assert.equal(row(`SELECT value FROM app_settings WHERE key='espn_s2'`)?.value, 'AEBsecretS2value1234567890');
  assert.equal(row('SELECT my_team_id FROM leagues WHERE id=41').my_team_id, '7', 'my_team_id was not rewritten');
});

test('the bookmarklet preflight stays open for espn.com', async () => {
  const res = await request('OPTIONS', '/api/espn-connect/cookies', { headers: { origin: 'https://fantasy.espn.com' } });
  assert.equal(res.status, 204);
});

test('POST /cookies with no session and no connect token is refused, not silently accepted', async () => {
  const res = await request('POST', '/api/espn-connect/cookies', { body: { espn_s2: 'x', swid: '{x}' } });
  assert.equal(res.status, 401);
  assert.equal(row(`SELECT value FROM app_settings WHERE key='espn_s2'`)?.value, 'AEBsecretS2value1234567890',
    'the real stored connection must be untouched by an anonymous attempt');
});

test('status, for a signed-in caller, reports the connection without cookie previews', async () => {
  const res = await request('GET', '/api/espn-connect/status', { token: TOKEN });
  assert.equal(res.status, 200);
  assert.equal(res.json.connected, true);
  assert.equal(res.json.leagues.length, 1);
  assert.equal('espn_s2_preview' in res.json, false, 'no part of espn_s2 is returned');
  assert.equal('swid_preview' in res.json, false, 'no part of SWID is returned');
  assert.ok(!res.text.includes('AEBsec') && !res.text.includes('ABCDEF12'), 'no cookie fragment in the body');
});

test('the page assistant and its stored answers require a session', async () => {
  const post = await request('POST', '/api/betting/explain/page', { body: { route: '/lineup', visible_summary: {} } });
  assert.equal(post.status, 401);
  const audits = await request('GET', '/api/betting/explain/page/audits');
  assert.equal(audits.status, 401);
  assert.equal((await request('GET', '/api/betting/explain/page/audits', { token: TOKEN })).status, 200);
});

test('the page assistant refuses an oversized prompt before any model call', async () => {
  const big = { rows: 'x'.repeat(20_000) };
  const res = await request('POST', '/api/betting/explain/page', { token: TOKEN, body: { route: '/lineup', visible_summary: big } });
  assert.equal(res.status, 413, res.text);
  const longQuestion = await request('POST', '/api/betting/explain/page',
    { token: TOKEN, body: { route: '/lineup', visible_summary: {}, question: 'why '.repeat(1000) } });
  assert.equal(longQuestion.status, 413, longQuestion.text);
});

test('the page assistant has its own per-user limit, stricter than the 120/min legacy one', async () => {
  const statuses = [];
  for (let i = 0; i < 25; i++) {
    statuses.push((await request('POST', '/api/betting/explain/page', { token: TOKEN, body: { route: '/lineup', visible_summary: {} } })).status);
  }
  assert.ok(statuses.includes(429), `25 calls in a minute must hit the limit: ${statuses.join(',')}`);
  assert.ok(statuses.indexOf(429) <= 20, 'the limit is at most 20 a minute');
});
