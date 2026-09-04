import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-league-removal-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
// Creates drafts.league_row_id / espn_league_id at import time.
await import('../server/services/espn-draft.js');
const { default: leaguesRouter } = await import('../server/routes/leagues.js');
const { requireAuthenticated, hashSessionToken } = await import('../server/platform/auth.js');
const express = (await import('express')).default;

// Mounted with plain requireAuthenticated rather than the full legacyAuthenticated
// wrapper (which also rate-limits) — this suite is about removal semantics, which
// test/legacy-route-security.test.js already covers for the anonymous-401 case.
// leagues.js itself checks per-league commissioner/member authorization on every
// :id route, so requests still need a real req.auth; each test authenticates as
// that league's commissioner via leagueWithDraftHistory().
const app = express();
app.use(express.json());
app.use('/api/leagues', requireAuthenticated, leaguesRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/api/leagues`;

function authHeaders(token) { return { authorization: `Bearer ${token}` }; }

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

let n = 0;
function leagueWithDraftHistory() {
  n += 1;
  run(`INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid)
       VALUES ('espn', ?, 2026, 'Test League', 's2-secret', '{swid}')`, String(9000 + n));
  const leagueId = row('SELECT last_insert_rowid() AS id').id;
  run(`INSERT INTO drafts (name, type, league_row_id, season) VALUES ('a real draft','live',?,2026)`, leagueId);
  const draftId = row('SELECT last_insert_rowid() AS id').id;
  run(`INSERT INTO players (name, position, fantasy_relevant) VALUES ('Removal Test Player','WR',1)`);
  const playerId = row('SELECT last_insert_rowid() AS id').id;
  run(`INSERT INTO draft_picks (draft_id, pick_number, team_slot, player_id) VALUES (?,1,1,?)`, draftId, playerId);

  const token = `removal-test-token-${n}`;
  run('INSERT INTO users (subject, display_name) VALUES (?,?)', `removal-test-${n}`, `Removal Tester ${n}`);
  const userId = row('SELECT last_insert_rowid() AS id').id;
  run('INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,?)', leagueId, userId, 'commissioner');
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now','+1 day'))`,
    userId, hashSessionToken(token));

  return { leagueId, draftId, token };
}

test('removal impact reports the draft history at stake before anything is destroyed', async () => {
  const { leagueId, token } = leagueWithDraftHistory();
  const body = await (await fetch(`${base}/${leagueId}/removal-impact`, { headers: authHeaders(token) })).json();
  assert.equal(body.drafts, 1);
  assert.equal(body.draft_picks, 1);
  assert.deepEqual(body.draft_names, ['a real draft']);
});

test('the default removal disconnects: credentials go, draft history stays', async () => {
  const { leagueId, draftId, token } = leagueWithDraftHistory();
  const body = await (await fetch(`${base}/${leagueId}`, { method: 'DELETE', headers: authHeaders(token) })).json();

  assert.equal(body.disconnected, true);
  assert.ok(row('SELECT id FROM leagues WHERE id = ?', leagueId), 'league row must survive');
  assert.equal(row('SELECT espn_s2 FROM leagues WHERE id = ?', leagueId).espn_s2, null,
    'stored credentials must be cleared');
  assert.equal(row('SELECT connection_status FROM leagues WHERE id = ?', leagueId).connection_status, 'needs_reconnect');
  assert.ok(row('SELECT id FROM drafts WHERE id = ?', draftId), 'draft history must survive');
  assert.equal(rows('SELECT id FROM draft_picks WHERE draft_id = ?', draftId).length, 1);
});

test('database integrity guards reject orphaned draft references and direct parent deletion', () => {
  assert.throws(() => run(`INSERT INTO drafts (name,type,league_row_id) VALUES ('orphan','mock',999999)`),
    /draft league not found/);
  const { leagueId } = leagueWithDraftHistory();
  assert.throws(() => run('DELETE FROM leagues WHERE id=?', leagueId), /league has draft history/);
});

test('a purge removes dependent drafts too, leaving no orphans behind', async () => {
  // The bug this replaces: a bare `DELETE FROM leagues` succeeded and left drafts
  // pointing at a league row that no longer existed — no error, no warning. The
  // declared FK does not save you, because espn-draft.js's import-time
  // `ALTER TABLE drafts ADD COLUMN league_row_id INTEGER` has no REFERENCES clause.
  const { leagueId, draftId, token } = leagueWithDraftHistory();
  const body = await (await fetch(`${base}/${leagueId}?purge=1`, { method: 'DELETE', headers: authHeaders(token) })).json();

  assert.equal(body.purged, true);
  assert.equal(body.removed.drafts, 1);
  assert.equal(row('SELECT id FROM leagues WHERE id = ?', leagueId), undefined);
  assert.equal(row('SELECT id FROM drafts WHERE id = ?', draftId), undefined,
    'a draft must never be left pointing at a deleted league');
  assert.equal(rows('SELECT id FROM draft_picks WHERE draft_id = ?', draftId).length, 0);
  assert.equal(rows('SELECT id FROM drafts WHERE league_row_id = ?', leagueId).length, 0,
    'no orphaned drafts may remain');
});

test('removing an unknown league rejects rather than silently succeeding', async () => {
  // Membership is checked before existence (so a non-member can't use the response
  // to probe which ids exist) — a real commissioner of some *other* league still
  // gets rejected here, not a 404, because they have no membership row for 999999.
  const { token } = leagueWithDraftHistory();
  const res = await fetch(`${base}/999999`, { method: 'DELETE', headers: authHeaders(token) });
  assert.equal(res.status, 403);
});

test('removing a league with no authentication at all is rejected, not silently applied', async () => {
  const { leagueId } = leagueWithDraftHistory();
  const res = await fetch(`${base}/${leagueId}`, { method: 'DELETE' });
  assert.equal(res.status, 401);
});

test('a league with no draft history still disconnects cleanly', async () => {
  run(`INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid)
       VALUES ('espn','8888',2026,'No Drafts','s2','{swid}')`);
  const id = row('SELECT last_insert_rowid() AS id').id;
  const token = 'removal-test-token-no-drafts';
  run('INSERT INTO users (subject, display_name) VALUES (?,?)', 'removal-test-no-drafts', 'No Drafts Tester');
  const userId = row('SELECT last_insert_rowid() AS id').id;
  run('INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,?)', id, userId, 'commissioner');
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now','+1 day'))`,
    userId, hashSessionToken(token));

  const body = await (await fetch(`${base}/${id}`, { method: 'DELETE', headers: authHeaders(token) })).json();
  assert.equal(body.disconnected, true);
  assert.equal(body.retained.drafts, 0);
});

test('a league with zero members self-heals commissioner membership for whoever calls sync, instead of locking them out forever', async () => {
  // Reproduces the real regression: a league connected through the
  // ESPN-connect flow before it granted membership on add (espn-connect.js)
  // had no league_memberships row at all, so its very first /sync 403'd and
  // there was no way for the owner of their own local install to recover.
  run(`INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid)
       VALUES ('sleeper','7777',2026,'Orphaned League',NULL,NULL)`);
  const leagueId = row('SELECT last_insert_rowid() AS id').id;
  const token = 'orphaned-league-token';
  run('INSERT INTO users (subject, display_name) VALUES (?,?)', 'orphaned-league-user', 'Orphaned Tester');
  const userId = row('SELECT last_insert_rowid() AS id').id;
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now','+1 day'))`,
    userId, hashSessionToken(token));
  assert.equal(row(`SELECT 1 FROM league_memberships WHERE league_id = ?`, leagueId), undefined,
    'the league must genuinely have no members yet, matching the real bug');

  // The sync itself will fail (a fake sleeper league_id has nothing real behind
  // it) — that's fine and expected; what matters is it fails as a sync error,
  // not a 403 membership rejection, and that membership now exists either way.
  await fetch(`${base}/${leagueId}/sync`, { method: 'POST', headers: authHeaders(token) });
  const membership = row(`SELECT role FROM league_memberships WHERE league_id = ? AND user_id = ?`, leagueId, userId);
  assert.equal(membership?.role, 'commissioner', 'the caller must be granted membership rather than staying locked out');
});
