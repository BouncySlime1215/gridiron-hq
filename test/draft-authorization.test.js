import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { Readable, PassThrough } from 'node:stream';
import { ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-draft-auth-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'auth.sqlite');

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
await runMigrations();
seedIfEmpty();
const { default: draftsRouter } = await import('../server/routes/drafts.js');

run(`INSERT INTO leagues (platform, league_id, season, name)
     VALUES ('test', 'auth-league', 2026, 'Authorization League')`);
const leagueId = row(`SELECT id FROM leagues WHERE league_id = 'auth-league'`).id;

function user(subject, role, token) {
  run('INSERT INTO users (subject, display_name) VALUES (?,?)', subject, subject);
  const userId = row('SELECT id FROM users WHERE subject = ?', subject).id;
  run('INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,?)', leagueId, userId, role);
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES (?,?,datetime('now', '+1 day'))`, userId, hashSessionToken(token));
  return { userId, token };
}

const commissioner = user('auth:commissioner', 'commissioner', 'commissioner-secret');
const ownerOne = user('auth:owner-one', 'member', 'owner-one-secret');
const ownerTwo = user('auth:owner-two', 'member', 'owner-two-secret');
const outsider = user('auth:outsider', 'member', 'outsider-secret');

const app = express();
app.use(express.json());
app.use('/api/drafts', draftsRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));
async function request(url, { token, roleHeader, method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (roleHeader) headers['x-gridiron-role'] = roleHeader;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const encoded = body === undefined ? '' : JSON.stringify(body);
  if (encoded) headers['content-length'] = String(Buffer.byteLength(encoded));
  const req = new Readable({ read() { this.push(encoded || null); if (encoded) { encoded && this.push(null); } } });
  req.url = `/api/drafts${url}`;
  req.method = method;
  req.headers = headers;
  req.socket = new PassThrough();
  req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req);
    const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: res.statusCode, payload: text ? JSON.parse(text) : null });
    };
    app.handle(req, res, reject);
  });
}

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const draftBody = {
  name: 'Secure draft', league_row_id: leagueId, team_count: 2, rounds: 2,
  my_slot: 1, pick_seconds: 90
};

test('missing, invalid, and forged role credentials cannot create drafts', async () => {
  assert.equal((await request('/', { method: 'POST', body: draftBody })).status, 401);
  assert.equal((await request('/', { method: 'POST', token: 'invalid', body: draftBody })).status, 401);
  assert.equal((await request('/', { method: 'POST', roleHeader: 'commissioner', body: draftBody })).status, 401);
  assert.equal((await request('/', { method: 'POST', token: ownerOne.token, roleHeader: 'commissioner', body: draftBody })).status, 403);
});

let draftId;
test('persisted commissioner membership permits creation and records the actor', async () => {
  const created = await request('/', { method: 'POST', token: commissioner.token, body: draftBody });
  assert.equal(created.status, 200);
  draftId = created.payload.id;
  assert.equal(Number(row(`SELECT actor FROM audit_log WHERE action = 'draft.create' AND entity_id = ?`, String(draftId)).actor), commissioner.userId);

  run('DELETE FROM draft_team_ownership WHERE draft_id = ?', draftId);
  run('INSERT INTO draft_team_ownership (draft_id, team_slot, user_id) VALUES (?,?,?)', draftId, 1, ownerOne.userId);
  run('INSERT INTO draft_team_ownership (draft_id, team_slot, user_id) VALUES (?,?,?)', draftId, 2, ownerTwo.userId);
});

test('team ownership and on-clock checks reject cross-team picks and allow owners', async () => {
  const [playerOne, playerTwo] = rows('SELECT id FROM players WHERE fantasy_relevant = 1 LIMIT 2');
  assert.equal((await request(`/${draftId}/picks`, { method: 'POST', token: outsider.token, body: { player_id: playerOne.id } })).status, 403);
  assert.equal((await request(`/${draftId}/picks`, { method: 'POST', token: ownerTwo.token, body: { player_id: playerOne.id } })).status, 403);

  const first = await request(`/${draftId}/picks`, { method: 'POST', token: ownerOne.token, body: { player_id: playerOne.id } });
  assert.equal(first.status, 200);
  assert.equal(first.payload.team_slot, 1);
  const second = await request(`/${draftId}/picks`, { method: 'POST', token: ownerTwo.token, body: { player_id: playerTwo.id } });
  assert.equal(second.status, 200);
  assert.equal(second.payload.team_slot, 2);
  assert.equal(Number(row(`SELECT actor FROM draft_events WHERE draft_id = ? AND type = 'pick' ORDER BY seq LIMIT 1`, draftId).actor), ownerOne.userId);
});

test('queues are owner-scoped while commissioners can correct draft state', async () => {
  const [queued] = rows(`SELECT id FROM players WHERE fantasy_relevant = 1
                         AND id NOT IN (SELECT player_id FROM draft_picks WHERE draft_id = ?) LIMIT 1`, draftId);
  assert.equal((await request(`/${draftId}/queue`, { method: 'PUT', token: ownerOne.token, body: { team_slot: 2, player_ids: [queued.id] } })).status, 403);
  assert.equal((await request(`/${draftId}/queue`, { method: 'PUT', token: ownerOne.token, body: { team_slot: 1, player_ids: [queued.id] } })).status, 200);

  assert.equal((await request(`/${draftId}/picks/last`, { method: 'DELETE', token: ownerOne.token })).status, 403);
  assert.equal((await request(`/${draftId}/picks/last`, { method: 'DELETE', token: commissioner.token })).status, 200);
});

test('service layer fails closed without an authenticated actor', async () => {
  const { makePick, setQueue, setPaused } = await import('../server/draft/store.js');
  const [player] = rows(`SELECT id FROM players WHERE fantasy_relevant = 1
                        AND id NOT IN (SELECT player_id FROM draft_picks WHERE draft_id = ?) LIMIT 1`, draftId);
  assert.throws(() => makePick({ draftId, playerId: player.id }), /authentication required/);
  assert.throws(() => makePick({ draftId, playerId: player.id, source: 'auto', actor: { system: true } }), /authentication required/);
  assert.throws(() => setQueue({ draftId, teamSlot: 1, playerIds: [player.id] }), /authentication required/);
  assert.throws(() => setPaused({ draftId, paused: true }), /authentication required/);
});

test('identity migration has constraints, foreign keys, and a working rollback', async () => {
  const membershipFks = rows(`PRAGMA foreign_key_list(league_memberships)`);
  assert.deepEqual(new Set(membershipFks.map(fk => fk.table)), new Set(['leagues', 'users']));
  assert.throws(() => run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?, 'admin')`, leagueId, ownerOne.userId), /CHECK constraint/);

  const rollbackDb = new DatabaseSync(':memory:');
  rollbackDb.exec(`CREATE TABLE leagues (id INTEGER PRIMARY KEY); CREATE TABLE drafts (id INTEGER PRIMARY KEY, team_count INTEGER, league_row_id INTEGER);`);
  const migration = await import('../server/migrations/006_identity_and_draft_authorization.js');
  migration.up(rollbackDb);
  assert.ok(rollbackDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_sessions'`).get());
  migration.down(rollbackDb);
  assert.equal(rollbackDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_sessions'`).get(), undefined);
  rollbackDb.close();
});
