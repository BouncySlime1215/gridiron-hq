import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Same isolated-DB pattern as test/draft-ingest.test.js — GET /api/drafts/active
// is what the Chrome extension polls to auto-configure itself with zero input
// from the user, so it has to be right about which draft (if any) is "live".
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-draft-active-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { default: draftsRouter } = await import('../server/routes/drafts.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/drafts', draftsRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/drafts`;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT INTO leagues (platform, league_id, season, name) VALUES ('espn', '999111', 2026, 'Active League')`);
const leagueRowId = row(`SELECT id FROM leagues WHERE league_id = '999111'`).id;
run(`INSERT INTO leagues (platform, league_id, season, name) VALUES ('espn', '999222', 2026, 'Other League')`);
const otherLeagueId = row(`SELECT id FROM leagues WHERE league_id = '999222'`).id;

function member(subject, leagueId, token) {
  run('INSERT INTO users (subject, display_name) VALUES (?,?)', subject, subject);
  const userId = row('SELECT id FROM users WHERE subject = ?', subject).id;
  if (leagueId != null) run('INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,?)', leagueId, userId, 'member');
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now', '+1 day'))`, userId, hashSessionToken(token));
  return token;
}
const inLeague = member('active:in-league', leagueRowId, 'in-league-secret');
const outsider = member('active:outsider', null, 'outsider-secret');

function makeDraft({ name, leagueRowIdVal, status, offsetHours, mockLeague = false }) {
  const at = new Date(Date.now() + offsetHours * 3600 * 1000).toISOString();
  run(`INSERT INTO drafts (name, type, team_count, rounds, my_slot, status, league_row_id, draft_at)
       VALUES (?, 'live', 8, 16, 2, ?, ?, ?)`,
    name, status, mockLeague ? null : leagueRowIdVal, offsetHours == null ? null : at);
  return row('SELECT last_insert_rowid() AS id').id;
}

const get = (token) => fetch(`${base}/active`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());

test('no drafts at all -> draft: null', async () => {
  assert.deepEqual(await get(inLeague), { draft: null });
});

test('a draft 6 hours from now is picked up', async () => {
  const id = makeDraft({ name: 'Tonight', leagueRowIdVal: leagueRowId, status: 'active', offsetHours: 6 });
  const body = await get(inLeague);
  assert.equal(body.draft.id, id);
  assert.equal(body.draft.name, 'Tonight');
});

test('a draft 3 days out is NOT picked up (outside the +/-1 day window)', async () => {
  makeDraft({ name: 'Far future', leagueRowIdVal: leagueRowId, status: 'active', offsetHours: 72 });
  // The 6h-out draft from the previous test is still the closest within window.
  const body = await get(inLeague);
  assert.equal(body.draft.name, 'Tonight');
});

test('a completed draft is never returned even if its time is close', async () => {
  run(`UPDATE drafts SET status = 'complete' WHERE name = 'Tonight'`);
  const body = await get(inLeague);
  assert.equal(body.draft, null); // the far-future one is out of window, the near one is complete
});

test('a mock draft (no league_row_id) is never auto-attached', async () => {
  run(`INSERT INTO drafts (name, type, team_count, rounds, my_slot, status, league_row_id, draft_at)
       VALUES ('Mock', 'mock', 8, 16, 2, 'active', NULL, datetime('now', '+1 hour'))`);
  const body = await get(inLeague);
  assert.equal(body.draft, null);
});

test('picks the CLOSEST-in-time live draft when more than one qualifies', async () => {
  run(`UPDATE drafts SET status = 'active' WHERE name = 'Far future'`); // now within a wider check, but still >1 day out — stays excluded
  const nearId = makeDraft({ name: 'Near', leagueRowIdVal: leagueRowId, status: 'active', offsetHours: 2 });
  makeDraft({ name: 'Nearer but different league', leagueRowIdVal: otherLeagueId, status: 'active', offsetHours: -1 });
  const body = await get(inLeague);
  // The other-league draft is closer in time but this user isn't a member of it.
  assert.equal(body.draft.id, nearId);
});

test('someone with no membership in the drafting league gets null even though a live draft exists', async () => {
  const body = await get(outsider);
  assert.equal(body.draft, null);
});

test('an unauthenticated request is rejected', async () => {
  const res = await fetch(`${base}/active`);
  assert.equal(res.status, 401);
});
