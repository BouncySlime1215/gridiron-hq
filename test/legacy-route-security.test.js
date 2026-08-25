import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ServerResponse } from 'node:http';
import { Readable, PassThrough } from 'node:stream';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-legacy-security-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated, legacyAdmin, legacyRateLimit } = await import('../server/platform/legacy-access.js');
const { default: leaguesRouter } = await import('../server/routes/leagues.js');
const { default: newsRouter } = await import('../server/routes/news.js');
const { default: playersRouter } = await import('../server/routes/players.js');
const { default: tradelabRouter } = await import('../server/routes/tradelab.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');
const { default: devRouter } = await import('../server/routes/dev.js');

const app = express();
app.use(express.json());
app.use('/api/leagues', ...legacyAuthenticated, leaguesRouter);
app.use('/api/news', ...legacyAuthenticated, newsRouter);
app.use('/api/players', ...legacyAuthenticated, playersRouter);
app.use('/api/tradelab', ...legacyAuthenticated, tradelabRouter);
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
app.use('/api/dev', ...legacyAdmin, devRouter);

before(async () => {
  await runMigrations();
  db.prepare(`INSERT OR IGNORE INTO users(id,subject,display_name) VALUES (991,'legacy-security-user','Legacy User')`).run();
  db.prepare(`INSERT OR REPLACE INTO auth_sessions(user_id,token_hash,expires_at) VALUES (991,?,datetime('now','+1 day'))`)
    .run(hashSessionToken('legacy-security-token'));
});

after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

async function request(path, token) {
  const req = new Readable({ read() { this.push(null); } });
  req.url = path; req.method = 'GET'; req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => {
      if (chunk) chunks.push(Buffer.from(chunk));
      resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
    };
    app.handle(req, res, reject);
  });
}

test('legacy league/news/trade/player/dev route families reject anonymous callers', async () => {
  for (const path of ['/api/leagues', '/api/news', '/api/tradelab/1/scout', '/api/trades/1/scout', '/api/players', '/api/dev/status']) {
    assert.equal((await request(path)).status, 401, path);
  }
});

test('dev/admin family rejects authenticated users without administrator permission', async () => {
  assert.equal((await request('/api/dev/status', 'legacy-security-token')).status, 403);
});

test('dev/admin family accepts the persisted administrator-equivalent grant', async () => {
  db.prepare(`INSERT OR IGNORE INTO model_permissions(user_id,permission) VALUES (991,'model:*')`).run();
  assert.equal((await request('/api/dev/status', 'legacy-security-token')).status, 200);
});

test('shared legacy limiter returns 429 after the authenticated allowance is exhausted', async () => {
  const limited = express();
  limited.use('/api/limited', legacyRateLimit({ limit: 1 }), (_req, res) => res.json({ ok: true }));
  const hit = async () => {
    const req = new Readable({ read() { this.push(null); } });
    req.url = '/api/limited'; req.method = 'GET'; req.headers = { authorization: 'Bearer legacy-security-token' };
    req.socket = new PassThrough(); req.connection = req.socket;
    return new Promise((resolve, reject) => {
      const res = new ServerResponse(req);
      res.end = chunk => resolve(res.statusCode);
      limited.handle(req, res, reject);
    });
  };
  assert.equal(await hit(), 200);
  assert.equal(await hit(), 429);
});
