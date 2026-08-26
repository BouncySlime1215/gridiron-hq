import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Readable, PassThrough } from 'node:stream';
import { ServerResponse } from 'node:http';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-espn-setup-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'setup.sqlite');

const { db, row, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { default: draftsRouter } = await import('../server/routes/drafts.js');

const app = express();
app.use(express.json());
app.use('/api/drafts', draftsRouter);
app.use((error, req, res, next) => res.status(error.status ?? 500).json({ error: error.message, code: error.code }));

const fixture = {
  id: 4242,
  seasonId: 2026,
  settings: {
    name: 'Reliable League', size: 2,
    draftSettings: {
      date: Date.parse('2026-09-01T23:00:00Z'), type: 'SNAKE', timePerSelection: 60,
      numberOfRounds: 3, pickOrder: [22, 11]
    },
    rosterSettings: { lineupSlotCounts: { 0: 1, 2: 1, 20: 1 } }
  },
  draftDetail: { inProgress: false, drafted: false, picks: [] },
  teams: [
    { id: 11, name: 'Alpha', owners: ['alpha-owner'] },
    { id: 22, location: 'Beta', nickname: 'Bears', owners: ['beta-owner'] }
  ]
};

const originalFetch = global.fetch;
function espnResponse(payload = fixture) {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => structuredClone(payload) });
}

async function request(method, url, body) {
  const bytes = body == null ? null : Buffer.from(JSON.stringify(body));
  const req = new Readable({ read() { if (bytes) this.push(bytes); this.push(null); } });
  req.url = url; req.method = method;
  req.headers = { authorization: 'Bearer setup-token',
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

before(() => {
  db.prepare(`INSERT INTO users(id,subject,display_name) VALUES (801,'setup-user','Setup User')`).run();
  db.prepare(`INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES (801,?,datetime('now','+1 day'))`)
    .run(hashSessionToken('setup-token'));
});

beforeEach(() => {
  db.exec(`DELETE FROM draft_picks; DELETE FROM draft_team_ownership;
    DELETE FROM espn_live_draft_identity; DELETE FROM espn_team_confirmations;
    DELETE FROM drafts; DELETE FROM league_memberships; DELETE FROM leagues;`);
  db.prepare(`INSERT INTO leagues(id,platform,league_id,season,name,espn_s2,swid,team_count)
    VALUES (901,'espn','4242',2026,'Stored Name','secret','{unknown-owner}',2)`).run();
  db.prepare(`INSERT INTO league_memberships(league_id,user_id,role) VALUES (901,801,'commissioner')`).run();
  espnResponse();
});

after(() => {
  global.fetch = originalFetch;
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('discovery normalizes complete scheduled setup metadata without creating a draft', async () => {
  const response = await request('GET', '/api/drafts/live/discovery?league_row_id=901');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    league_name: 'Reliable League', league_id: '4242', league_row_id: 901, season: 2026,
    draft_status: 'scheduled', scheduled_time: '2026-09-01T23:00:00.000Z',
    team_count: 2, round_count: 3, draft_type: 'snake', pick_timer_seconds: 60,
    roster_requirements: { QB: 1, RB: 1, BENCH: 1 },
    user_team: null, user_draft_slot: null,
    ownership: { state: 'confirmation_required', source: null, can_start: false, reason: 'team_confirmation_required' },
    pick_order: ['22', '11'],
    teams: [{ id: '11', name: 'Alpha' }, { id: '22', name: 'Beta Bears' }]
  });
  assert.equal(row('SELECT COUNT(*) n FROM drafts').n, 0);
  assert.equal(row('SELECT COUNT(*) n FROM draft_team_ownership').n, 0);
});

test('unknown ownership blocks start with zero draft mutations', async () => {
  const response = await request('POST', '/api/drafts/live/link', { league_row_id: 901 });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'ESPN_TEAM_CONFIRMATION_REQUIRED');
  assert.equal(response.body.discovery.ownership.can_start, false);
  assert.equal(row('SELECT COUNT(*) n FROM drafts').n, 0);
  assert.equal(row('SELECT COUNT(*) n FROM draft_team_ownership').n, 0);
});

test('explicit valid team confirmation enables idempotent start and resume', async () => {
  db.prepare(`INSERT INTO drafts(name,type,team_count,rounds,my_slot,league_row_id)
    VALUES ('untouched mock','mock',8,4,2,901)`).run();
  const mockBefore = row(`SELECT * FROM drafts WHERE name='untouched mock'`);

  const first = await request('POST', '/api/drafts/live/link', { league_row_id: 901, confirmed_team_id: '22' });
  const second = await request('POST', '/api/drafts/live/link', { league_row_id: 901 });
  const third = await request('POST', '/api/drafts/live/link', { league_row_id: 901 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200);
  assert.equal(third.status, 200);
  assert.equal(first.body.created, true);
  assert.equal(second.body.created, false);
  assert.equal(first.body.draft_id, second.body.draft_id);
  assert.equal(second.body.draft_id, third.body.draft_id);
  assert.equal(row(`SELECT COUNT(*) n FROM drafts WHERE type='live' AND league_row_id=901 AND season=2026`).n, 1);
  const ownership = row(`SELECT team_slot,user_id FROM draft_team_ownership WHERE draft_id=?`, first.body.draft_id);
  assert.equal(ownership.team_slot, 1);
  assert.equal(ownership.user_id, 801);
  assert.deepEqual(row(`SELECT * FROM drafts WHERE name='untouched mock'`), mockBefore);
});

test('ESPN member ownership is proven without an explicit confirmation', async () => {
  db.prepare(`UPDATE leagues SET swid='{alpha-owner}' WHERE id=901`).run();
  const discovered = await request('GET', '/api/drafts/live/discovery?league_row_id=901');
  assert.equal(discovered.body.ownership.state, 'proven');
  assert.deepEqual(discovered.body.user_team, { id: '11', name: 'Alpha' });
  assert.equal(discovered.body.user_draft_slot, 2);
  const linked = await request('POST', '/api/drafts/live/link', { league_row_id: 901 });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(row(`SELECT espn_team_id FROM drafts WHERE id=?`, linked.body.draft_id).espn_team_id, '11');
});

test('completed and active fixtures expose their ESPN draft status', async () => {
  const active = structuredClone(fixture);
  active.draftDetail.inProgress = true;
  espnResponse(active);
  assert.equal((await request('GET', '/api/drafts/live/discovery?league_row_id=901')).body.draft_status, 'active');
  const complete = structuredClone(fixture);
  complete.draftDetail.drafted = true;
  espnResponse(complete);
  assert.equal((await request('GET', '/api/drafts/live/discovery?league_row_id=901')).body.draft_status, 'completed');
});

test('invalid confirmation never persists or assigns a roster', async () => {
  const response = await request('POST', '/api/drafts/live/link', { league_row_id: 901, confirmed_team_id: '999' });
  assert.equal(response.status, 400);
  assert.equal(row('SELECT COUNT(*) n FROM espn_team_confirmations').n, 0);
  assert.equal(row('SELECT COUNT(*) n FROM drafts').n, 0);
});

test('start returns categorized persisted recovery state when the immediate sync cannot authenticate', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: true, status: 200, json: async () => structuredClone(fixture) };
    return { ok: false, status: 401, json: async () => ({}) };
  };
  const response = await request('POST', '/api/drafts/live/link', {
    league_row_id: 901, confirmed_team_id: '22'
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.sync.ok, false);
  assert.equal(response.body.sync.code, 'ESPN_AUTHENTICATION_FAILED');
  assert.equal(response.body.sync.sync_status.health_state, 'auth_required');
  assert.equal(response.body.sync.sync_status.failure_category, 'authentication');
  assert.equal(response.body.sync.sync_status.recovery_action, 'reconnect_espn');
  assert.equal(row('SELECT COUNT(*) n FROM draft_picks WHERE draft_id=?', response.body.draft_id).n, 0);
});
