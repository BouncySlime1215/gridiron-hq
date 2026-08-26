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
const express = (await import('express')).default;

const app = express();
app.use(express.json());
// Mounted without the legacy auth wrapper: this suite is about removal semantics,
// which test/legacy-route-security.test.js already covers for auth.
app.use('/api/leagues', leaguesRouter);
const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/api/leagues`;

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
  return { leagueId, draftId };
}

test('removal impact reports the draft history at stake before anything is destroyed', async () => {
  const { leagueId } = leagueWithDraftHistory();
  const body = await (await fetch(`${base}/${leagueId}/removal-impact`)).json();
  assert.equal(body.drafts, 1);
  assert.equal(body.draft_picks, 1);
  assert.deepEqual(body.draft_names, ['a real draft']);
});

test('the default removal disconnects: credentials go, draft history stays', async () => {
  const { leagueId, draftId } = leagueWithDraftHistory();
  const body = await (await fetch(`${base}/${leagueId}`, { method: 'DELETE' })).json();

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
  const { leagueId, draftId } = leagueWithDraftHistory();
  const body = await (await fetch(`${base}/${leagueId}?purge=1`, { method: 'DELETE' })).json();

  assert.equal(body.purged, true);
  assert.equal(body.removed.drafts, 1);
  assert.equal(row('SELECT id FROM leagues WHERE id = ?', leagueId), undefined);
  assert.equal(row('SELECT id FROM drafts WHERE id = ?', draftId), undefined,
    'a draft must never be left pointing at a deleted league');
  assert.equal(rows('SELECT id FROM draft_picks WHERE draft_id = ?', draftId).length, 0);
  assert.equal(rows('SELECT id FROM drafts WHERE league_row_id = ?', leagueId).length, 0,
    'no orphaned drafts may remain');
});

test('removing an unknown league is a clean 404, not a silent success', async () => {
  const res = await fetch(`${base}/999999`, { method: 'DELETE' });
  assert.equal(res.status, 404);
});

test('a league with no draft history still disconnects cleanly', async () => {
  run(`INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid)
       VALUES ('espn','8888',2026,'No Drafts','s2','{swid}')`);
  const id = row('SELECT last_insert_rowid() AS id').id;
  const body = await (await fetch(`${base}/${id}`, { method: 'DELETE' })).json();
  assert.equal(body.disconnected, true);
  assert.equal(body.retained.drafts, 0);
});
