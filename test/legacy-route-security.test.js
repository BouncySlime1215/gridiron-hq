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
// Migrations must finish before the routers below are imported: several of
// them prepare statements at import time against tables a migration creates
// (server/services/nfl-news-events.js is the first to bite). This mirrors the
// ordering server/index.js itself uses and why its imports are dynamic.
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated, legacyAdmin, legacyRateLimit } = await import('../server/platform/legacy-access.js');
const { default: leaguesRouter } = await import('../server/routes/leagues.js');
const { default: newsRouter } = await import('../server/routes/news.js');
const { default: playersRouter } = await import('../server/routes/players.js');
const { default: tradelabRouter } = await import('../server/routes/tradelab.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');
const { default: devRouter } = await import('../server/routes/dev.js');
// The 13 route families that used to mount with no auth at all
// (server/index.js:77-107, Giant Plan section 5.1 item 3) — teams, rankings,
// espn, aggregates, analysis, nfldata ("/api/nfl"), stats, accolades, edge,
// props, props-tickets, decision-inbox and wong ("/api/betting/wong").
const { default: teamsRouter } = await import('../server/routes/teams.js');
const { default: rankingsRouter } = await import('../server/routes/rankings.js');
const { default: espnRouter } = await import('../server/routes/espn.js');
const { default: aggregatesRouter } = await import('../server/routes/aggregates.js');
const { default: analysisRouter } = await import('../server/routes/analysis.js');
const { default: nfldataRouter } = await import('../server/routes/nfldata.js');
const { default: statsRouter } = await import('../server/routes/stats.js');
const { default: accoladesRouter } = await import('../server/routes/accolades.js');
const { default: edgeRouter } = await import('../server/routes/edge.js');
const { default: propsRouter } = await import('../server/routes/props.js');
const { default: propsTicketsRouter } = await import('../server/routes/props-tickets.js');
const { default: decisionInboxRouter } = await import('../server/routes/decision-inbox.js');
const { default: wongRouter } = await import('../server/routes/wong.js');
// The six families that were still mounted with no authentication at all
// (server/index.js) after the thirteen above were closed: model, mlb,
// nfl-market, nfl-betting, betting-hub and execution-slate. Individual
// mutations inside them carried requireModelPermission; every read beside
// those answered anyone who asked, which is invisible on a Mac bound to
// loopback and wide open at a public URL.
const { default: modelRouter } = await import('../server/routes/model.js');
const { default: mlbRouter } = await import('../server/routes/mlb.js');
const { default: nflMarketRouter } = await import('../server/routes/nfl-market.js');
const { default: nflBettingRouter } = await import('../server/routes/nfl-betting.js');
const { default: bettingHubRouter } = await import('../server/routes/betting-hub.js');
const { default: executionSlateRouter } = await import('../server/routes/execution-slate.js');

const app = express();
app.use(express.json());
app.use('/api/leagues', ...legacyAuthenticated, leaguesRouter);
app.use('/api/news', ...legacyAuthenticated, newsRouter);
app.use('/api/players', ...legacyAuthenticated, playersRouter);
app.use('/api/tradelab', ...legacyAuthenticated, tradelabRouter);
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
app.use('/api/dev', ...legacyAdmin, devRouter);
app.use('/api/teams', ...legacyAuthenticated, teamsRouter);
app.use('/api/rankings', ...legacyAuthenticated, rankingsRouter);
app.use('/api/espn', ...legacyAuthenticated, espnRouter);
app.use('/api/aggregates', ...legacyAuthenticated, aggregatesRouter);
app.use('/api/analysis', ...legacyAuthenticated, analysisRouter);
app.use('/api/nfl', ...legacyAuthenticated, nfldataRouter);
app.use('/api/stats', ...legacyAuthenticated, statsRouter);
app.use('/api/accolades', ...legacyAuthenticated, accoladesRouter);
app.use('/api/edge', ...legacyAuthenticated, edgeRouter);
app.use('/api/props', ...legacyAuthenticated, propsRouter);
app.use('/api/props-tickets', ...legacyAuthenticated, propsTicketsRouter);
app.use('/api/decision-inbox', ...legacyAuthenticated, decisionInboxRouter);
app.use('/api/betting/wong', ...legacyAuthenticated, wongRouter);
app.use('/api/model', ...legacyAuthenticated, modelRouter);
app.use('/api/mlb', ...legacyAuthenticated, mlbRouter);
app.use('/api/nfl-market', ...legacyAuthenticated, nflMarketRouter);
app.use('/api/nfl-betting', ...legacyAuthenticated, nflBettingRouter);
app.use('/api/betting', ...legacyAuthenticated, bettingHubRouter);
app.use('/api/execution-slate', ...legacyAuthenticated, executionSlateRouter);

before(() => {
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

test('the 13 previously-ungated route families now reject anonymous callers', async () => {
  for (const path of ['/api/teams', '/api/rankings', '/api/espn', '/api/aggregates', '/api/analysis',
    '/api/nfl', '/api/stats', '/api/accolades', '/api/edge', '/api/props', '/api/props-tickets',
    '/api/decision-inbox', '/api/betting/wong']) {
    assert.equal((await request(path)).status, 401, path);
  }
});

test('the six remaining ungated route families now reject anonymous callers', async () => {
  for (const path of ['/api/model/status', '/api/model/state', '/api/model/accuracy',
    '/api/mlb/status', '/api/nfl-market/evidence/status', '/api/nfl-betting/live',
    '/api/betting/summary', '/api/betting/execution/board', '/api/betting/audits',
    '/api/execution-slate/opportunities']) {
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
