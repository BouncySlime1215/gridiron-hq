import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ServerResponse } from 'node:http';
import { Readable, PassThrough } from 'node:stream';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-espn-security-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { default: espnConnectRouter } = await import('../server/routes/espn-connect.js');
const { default: leaguesRouter } = await import('../server/routes/leagues.js');
const { espnCookies } = await import('../server/services/espn-draft.js');

const app = express();
app.use(express.json());
app.use('/api/espn-connect', espnConnectRouter);
app.use('/api/leagues', leaguesRouter);
app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: 'request failed' }));

before(async () => {
  await runMigrations();
  db.prepare(`INSERT INTO users(id,subject,display_name) VALUES (701,'espn-user','ESPN User')`).run();
  db.prepare(`INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES (701,?,datetime('now','+1 day'))`)
    .run(hashSessionToken('espn-token'));
});

after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

async function request(method, url, { token, body } = {}) {
  const bytes = body == null ? null : Buffer.from(JSON.stringify(body));
  const req = new Readable({ read() { if (bytes) this.push(bytes); this.push(null); } });
  req.url = url; req.method = method;
  req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}) };
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
    };
    app.handle(req, res, reject);
  });
}

test('all ESPN connection endpoints reject anonymous callers', async () => {
  for (const [method, url] of [['POST','/api/espn-connect/cookies'], ['GET','/api/espn-connect/status?league_id=1&season=2026'],
    ['DELETE','/api/espn-connect/cookies'], ['POST','/api/espn-connect/discover'], ['POST','/api/espn-connect/test']]) {
    assert.equal((await request(method, url)).status, 401, `${method} ${url}`);
  }
});

test('test access probes public first and does not send or persist supplied credentials', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, options) => {
    calls.push(options);
    return { ok: true, status: 200, json: async () => ({ id: 321, seasonId: 2026 }) };
  };
  try {
    const response = await request('POST', '/api/espn-connect/test', { token: 'espn-token', body: {
      league_id: '321', season: 2026, espn_s2: 'must-not-be-sent', swid: 'must-not-be-sent'
    } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { code: 'ESPN_PUBLIC_ACCESS', connection_state: 'public',
      message: 'This ESPN league is publicly accessible.', next_action: 'continue', league_id: '321', season: 2026 });
    assert.equal('Cookie' in calls[0].headers, false);
    assert.equal(calls.length, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM leagues WHERE league_id='321'`).get().n, 0);
    assert.doesNotMatch(JSON.stringify(response.body), /must-not-be-sent/);
  } finally { global.fetch = originalFetch; }
});

test('test access requests credentials only after an authentication response', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401 });
  try {
    const response = await request('POST', '/api/espn-connect/test', { token: 'espn-token',
      body: { league_id: '322', season: 2026 } });
    assert.equal(response.status, 200);
    assert.equal(response.body.code, 'ESPN_CREDENTIALS_REQUIRED');
    assert.equal(response.body.next_action, 'provide_credentials');
  } finally { global.fetch = originalFetch; }
});

test('test access rejects partial credentials without making an authenticated request', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: false, status: 403 }; };
  try {
    const response = await request('POST', '/api/espn-connect/test', { token: 'espn-token',
      body: { league_id: '327', season: 2026, espn_s2: 'only-one-secret' } });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'ESPN_CREDENTIALS_INVALID');
    assert.equal(response.body.next_action, 'replace_credentials');
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(response.body), /only-one-secret/);
  } finally { global.fetch = originalFetch; }
});

test('test access retries exact league with normalized credentials and sanitizes failures', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, options) => {
    calls.push(options);
    if (calls.length === 1) return { ok: false, status: 403 };
    return { ok: true, status: 200, json: async () => ({ id: 323, seasonId: 2026 }) };
  };
  try {
    const response = await request('POST', '/api/espn-connect/test', { token: 'espn-token', body: {
      league_id: '323', season: 2026, espn_s2: ' secret ', swid: '%7Bmember%7D'
    } });
    assert.equal(response.status, 200);
    assert.equal(response.body.code, 'ESPN_CREDENTIALS_VALID');
    assert.equal(calls[1].headers.Cookie, 'espn_s2=secret; SWID={member}');
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM leagues WHERE league_id='323'`).get().n, 0);
    assert.doesNotMatch(JSON.stringify(response.body), /secret|member/);
  } finally { global.fetch = originalFetch; }
});

test('test access does not try credentials for non-authentication ESPN failures', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: false, status: 500 }; };
  try {
    const response = await request('POST', '/api/espn-connect/test', { token: 'espn-token', body: {
      league_id: '324', season: 2026, espn_s2: 'secret', swid: 'member'
    } });
    assert.equal(response.status, 502);
    assert.equal(response.body.code, 'ESPN_ACCESS_CHECK_FAILED');
    assert.equal(response.body.next_action, 'retry');
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(response.body), /secret|member|upstream/);
  } finally { global.fetch = originalFetch; }
});

test('test access treats not-found as an exact-tuple correction, not an authentication prompt', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: false, status: 404 }; };
  try {
    const response = await request('POST', '/api/espn-connect/test', { token: 'espn-token', body: {
      league_id: '328', season: 2026, espn_s2: 'unused', swid: 'unused'
    } });
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'ESPN_LEAGUE_NOT_FOUND');
    assert.equal(response.body.connection_state, 'not_found');
    assert.equal(response.body.next_action, 'correct_request');
    assert.equal(calls, 1);
  } finally { global.fetch = originalFetch; }
});

test('test access returns a sanitized invalid-credential result after the public probe', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: false, status: 401 }; };
  try {
    const response = await request('POST', '/api/espn-connect/test', { token: 'espn-token', body: {
      league_id: '326', season: 2026, espn_s2: 'bad-secret', swid: 'bad-member'
    } });
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { code: 'ESPN_CREDENTIALS_INVALID', connection_state: 'credentials_required',
      message: 'ESPN could not authenticate these credentials.', next_action: 'replace_credentials',
      league_id: '326', season: 2026 });
    assert.equal(calls, 2);
    assert.doesNotMatch(JSON.stringify(response.body), /bad-secret|bad-member/);
  } finally { global.fetch = originalFetch; }
});

test('test access preserves exact league and season validation', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: true, status: 200,
    json: async () => ({ id: 999, seasonId: 2026 }) }; };
  try {
    const response = await request('POST', '/api/espn-connect/test', { token: 'espn-token',
      body: { league_id: '325', season: 2026 } });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'ESPN_LEAGUE_MISMATCH');
    assert.equal(response.body.connection_state, 'mismatch');
    assert.equal(response.body.next_action, 'correct_request');
    assert.equal(calls, 1);
    const invalid = await request('POST', '/api/espn-connect/test', { token: 'espn-token',
      body: { league_id: '325x', season: 2026 } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'ESPN_INVALID_REQUEST');
    assert.equal(calls, 1);
  } finally { global.fetch = originalFetch; }
});

test('invalid or mismatched credentials are not saved', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 999, seasonId: 2026 }) });
  try {
    const response = await request('POST', '/api/espn-connect/cookies', { token: 'espn-token',
      body: { league_id: '123', season: 2026, espn_s2: 'top-secret', swid: 'member-id' } });
    assert.equal(response.status, 400);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM leagues WHERE espn_s2 IS NOT NULL`).get().n, 0);
    assert.doesNotMatch(JSON.stringify(response.body), /top-secret|member-id/);
  } finally { global.fetch = originalFetch; }
});

test('validated credentials are league scoped and ordinary league data omits secrets', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    id: 123, seasonId: 2026, settings: { name: 'Private League' }, teams: [], members: [{ id: 'espn-member' }]
  }) });
  try {
    const connected = await request('POST', '/api/espn-connect/cookies', { token: 'espn-token',
      body: { league_id: '123', season: 2026, espn_s2: 'top-secret', swid: '%7Bmember-id%7D' } });
    assert.equal(connected.status, 200);
    assert.doesNotMatch(JSON.stringify(connected.body), /top-secret|member-id/);
    const stored = db.prepare(`SELECT * FROM leagues WHERE league_id='123' AND season=2026`).get();
    assert.equal(stored.espn_s2, 'top-secret');
    assert.equal(stored.swid, '{member-id}');
    assert.equal(stored.espn_connection_state, 'connected');
    assert.ok(stored.espn_validated_at);
    const data = await request('GET', `/api/leagues/${stored.id}/data`);
    assert.equal(data.status, 200);
    assert.equal('espn_s2' in data.body, false);
    assert.equal('swid' in data.body, false);
  } finally { global.fetch = originalFetch; }
});

test('live draft credential lookup never falls back to global or newest league credentials', () => {
  db.prepare(`INSERT INTO leagues(platform,league_id,season,espn_s2,swid)
    VALUES ('espn','456',2026,'second-secret','{second-member}')`).run();
  assert.deepEqual(espnCookies('123', 2026), { s2: 'top-secret', swid: '{member-id}' });
  assert.deepEqual(espnCookies('missing', 2026), { s2: null, swid: null });
  assert.deepEqual(espnCookies(), { s2: null, swid: null });
});
