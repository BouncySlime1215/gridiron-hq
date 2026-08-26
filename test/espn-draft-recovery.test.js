import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Readable, PassThrough } from 'node:stream';
import { ServerResponse } from 'node:http';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-espn-recovery-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'recovery.sqlite');

const { db, row, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const {
  syncLiveDraft, syncDueLiveDrafts, liveDraftSyncStatus
} = await import('../server/services/espn-draft.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { default: draftsRouter } = await import('../server/routes/drafts.js');

const app = express();
app.use(express.json());
app.use('/api/drafts', draftsRouter);
app.use((error, req, res, next) => res.status(error.status ?? 500).json({ error: error.message, code: error.code }));

async function request(method, url, token = null) {
  const req = new Readable({ read() { this.push(null); } });
  req.url = url; req.method = method; req.headers = token ? { authorization: `Bearer ${token}` } : {};
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

const originalFetch = global.fetch;
let payload;
let fetchCalls;

function snapshot({ drafted = false } = {}) {
  return {
    id: 4242, seasonId: 2026,
    settings: { size: 2, draftSettings: { numberOfRounds: 1, pickOrder: [11, 22] } },
    teams: [{ id: 11 }, { id: 22 }],
    draftDetail: { inProgress: !drafted, drafted, picks: [
      { overallPickNumber: 1, playerId: 1001, teamId: 11 },
      { overallPickNumber: 2, playerId: drafted ? 1002 : -1, teamId: 22 }
    ] }
  };
}

before(() => {
  db.prepare(`INSERT INTO users(id,subject,display_name) VALUES (1,'recovery','Recovery')`).run();
  db.prepare(`INSERT INTO auth_sessions(user_id,token_hash,expires_at)
    VALUES (1,?,datetime('now','+1 day'))`).run(hashSessionToken('recovery-token'));
  db.prepare(`INSERT INTO leagues(id,platform,league_id,season,name,espn_s2,swid,team_count)
    VALUES (90,'espn','4242',2026,'Recovery League','secret','{owner}',2)`).run();
  db.prepare(`INSERT INTO league_memberships(league_id,user_id,role) VALUES (90,1,'member')`).run();
  db.prepare(`INSERT INTO players(id,name,position,espn_id,fantasy_relevant) VALUES
    (201,'One','WR',1001,1),(202,'Two','RB',1002,1)`).run();
});

beforeEach(() => {
  db.exec(`DELETE FROM draft_picks; DELETE FROM espn_draft_sync_state; DELETE FROM drafts;`);
  db.prepare(`INSERT INTO drafts(id,name,type,team_count,rounds,my_slot,status,league_row_id,
    espn_league_id,season,pick_order)
    VALUES (100,'ESPN live','live',2,1,1,'active',90,'4242',2026,
      '{"order":["11","22"],"team_names":{}}')`).run();
  payload = snapshot();
  fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, json: async () => structuredClone(payload) };
  };
});

after(() => {
  global.fetch = originalFetch;
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('successful synchronization persists health, board counts, and restart-safe state', async () => {
  await syncLiveDraft(100);
  const status = liveDraftSyncStatus(100);
  assert.equal(status.health_state, 'healthy');
  assert.equal(status.board_count, 1);
  assert.equal(status.consecutive_failures, 0);
  assert.equal(status.retry_status, 'ready');
  assert.ok(status.last_attempt_at);
  assert.ok(status.last_success_at);
});

test('network loss preserves the board and schedules bounded persisted backoff', async () => {
  await syncLiveDraft(100);
  const before = rows('SELECT * FROM draft_picks WHERE draft_id=100');
  global.fetch = async () => { fetchCalls += 1; throw new Error('offline'); };
  await assert.rejects(() => syncLiveDraft(100), error => error.code === 'ESPN_NETWORK_ERROR');
  const status = liveDraftSyncStatus(100);
  assert.equal(status.health_state, 'retrying');
  assert.equal(status.failure_category, 'transient');
  assert.equal(status.retry_status, 'scheduled');
  assert.ok(Date.parse(status.next_retry_at) > Date.now());
  assert.ok(Date.parse(status.next_retry_at) - Date.now() <= 60_000);
  assert.deepEqual(rows('SELECT * FROM draft_picks WHERE draft_id=100'), before);
});

test('authentication expiry and malformed data stop unsafe automatic mutation', async () => {
  await syncLiveDraft(100);
  const before = rows('SELECT * FROM draft_picks WHERE draft_id=100');
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(() => syncLiveDraft(100), error => error.code === 'ESPN_AUTHENTICATION_FAILED');
  assert.deepEqual({ ...liveDraftSyncStatus(100) }, {
    ...liveDraftSyncStatus(100), health_state: 'auth_required', failure_category: 'authentication',
    retry_status: 'stopped', recovery_state: 'action_required'
  });
  const callsAfterAuth = fetchCalls;
  await syncDueLiveDrafts({ now: new Date(Date.now() + 120_000) });
  assert.equal(fetchCalls, callsAfterAuth);

  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 4242, seasonId: 2026 }) });
  await assert.rejects(() => syncLiveDraft(100, { recoveryState: 'manual_retry' }),
    error => error.code === 'ESPN_INVALID_SNAPSHOT');
  const invalid = liveDraftSyncStatus(100);
  assert.equal(invalid.health_state, 'invalid_data');
  assert.equal(invalid.retry_status, 'stopped');
  assert.deepEqual(rows('SELECT * FROM draft_picks WHERE draft_id=100'), before);
});

test('restart catch-up retries persisted due work and converges to the next valid snapshot', async () => {
  db.prepare(`INSERT INTO espn_draft_sync_state
    (draft_id,health_state,retry_status,recovery_state,next_retry_at,consecutive_failures)
    VALUES (100,'syncing','ready','catch_up',datetime('now','-1 minute'),2)`).run();
  const results = await syncDueLiveDrafts({ now: new Date() });
  assert.equal(results[0].ok, true);
  assert.equal(fetchCalls, 1);
  const status = liveDraftSyncStatus(100);
  assert.equal(status.health_state, 'healthy');
  assert.equal(status.recovery_state, 'recovered');
  assert.equal(status.consecutive_failures, 0);
  assert.equal(row('SELECT COUNT(*) n FROM draft_picks WHERE draft_id=100').n, 1);
});

test('background and manual callers with number/string ids share one reconciliation', async () => {
  let release;
  global.fetch = () => {
    fetchCalls += 1;
    return new Promise(resolve => { release = () => resolve({ ok: true, status: 200, json: async () => structuredClone(payload) }); });
  };
  const background = syncLiveDraft(100, { recoveryState: 'catch_up' });
  const manual = syncLiveDraft('100', { recoveryState: 'manual_retry' });
  await new Promise(resolve => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all([background, manual]);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(a, b);
  assert.equal(row('SELECT COUNT(*) n FROM draft_picks WHERE draft_id=100').n, 1);
  assert.equal(liveDraftSyncStatus(100).board_revision, 1);
});

test('completed ESPN drafts persist completion and are excluded from later polling', async () => {
  payload = snapshot({ drafted: true });
  await syncLiveDraft(100);
  const status = liveDraftSyncStatus(100);
  assert.equal(status.health_state, 'complete');
  assert.equal(status.retry_status, 'complete');
  const calls = fetchCalls;
  await syncDueLiveDrafts({ now: new Date(Date.now() + 120_000) });
  assert.equal(fetchCalls, calls);
});

test('status and manual retry APIs require membership and expose persisted recovery state', async () => {
  assert.equal((await request('GET', '/api/drafts/100/sync-status')).status, 401);
  const initial = await request('GET', '/api/drafts/100/sync-status', 'recovery-token');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.health_state, 'pending');
  const retried = await request('POST', '/api/drafts/100/retry', 'recovery-token');
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.sync_status.health_state, 'healthy');
  assert.equal(retried.body.sync_status.board_count, 1);
});
