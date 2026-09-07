import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-draft-capture-route-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'capture.sqlite');

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
await runMigrations();
seedIfEmpty();
const { default: localAuthRouter } = await import('../server/routes/local-auth.js');
const { default: draftCaptureRouter, serveCaptureScript, buildBookmarklet } = await import('../server/routes/draft-capture.js');

run(`INSERT INTO leagues (platform, league_id, season, name) VALUES ('test', 'cap-league', 2026, 'Capture League')`);
const leagueId = row(`SELECT id FROM leagues WHERE league_id = 'cap-league'`).id;
run(`INSERT INTO drafts (name, type, team_count, rounds, my_slot, pick_seconds, order_type, roster_positions, league_row_id)
     VALUES ('Capture Draft', 'snake', 10, 15, 3, 90, 'snake', '{}', ?)`, leagueId);
const draftId = row(`SELECT id FROM drafts WHERE name = 'Capture Draft'`).id;

function user(subject, token, member) {
  run('INSERT INTO users (subject, display_name) VALUES (?,?)', subject, subject);
  const userId = row('SELECT id FROM users WHERE subject = ?', subject).id;
  if (member) run('INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,?)', leagueId, userId, 'member');
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now', '+1 day'))`, userId, hashSessionToken(token));
  return token;
}
const member = user('cap:member', 'member-secret', true);
const outsider = user('cap:outsider', 'outsider-secret', false);

const app = express();
app.use(express.json());
app.use('/api/auth', localAuthRouter);
app.use('/api/drafts', draftCaptureRouter);
app.get('/draft-capture.js', serveCaptureScript);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const get = (url, token) => fetch(base + url, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('bookmarklet href is a small loader with draft, key and origin baked in', () => {
  const { href, loader_url } = buildBookmarklet({ origin: 'https://x.trycloudflare.com/', draftId: 7, ingestKey: 'a b&c' });
  assert.equal(loader_url, 'https://x.trycloudflare.com/draft-capture.js');
  assert.ok(href.startsWith('javascript:(function(){'));
  assert.match(href, /draft-capture\.js\?draft=7&key=a%20b%26c&origin=https%3A%2F%2Fx\.trycloudflare\.com&t="\+Date\.now\(\)/);
  assert.ok(Buffer.byteLength(href) < 2048);
});

test('route requires auth, draft membership, and an ingest key; falls back to localhost with a warning', async () => {
  assert.equal((await get(`/api/drafts/${draftId}/capture-bookmarklet?ingest_key=k1`)).status, 401);
  assert.equal((await get(`/api/drafts/${draftId}/capture-bookmarklet?ingest_key=k1`, outsider)).status, 404);
  assert.equal((await get(`/api/drafts/999999/capture-bookmarklet?ingest_key=k1`, member)).status, 404);
  const noKey = await get(`/api/drafts/${draftId}/capture-bookmarklet`, member);
  assert.equal(noKey.status, 400);
  assert.match((await noKey.json()).error, /ingest_key required/);

  const res = await get(`/api/drafts/${draftId}/capture-bookmarklet?ingest_key=k1`, member);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tunnel_up, false);
  assert.equal(body.key_source, 'query');
  assert.match(body.origin, /^http:\/\/localhost:\d+$/);
  assert.equal(body.warnings.length, 1);
  assert.match(body.href, new RegExp(`draft=${draftId}&key=k1&origin=`));
});

test('route uses the registered tunnel origin when one is up', async () => {
  const reg = await fetch(`${base}/api/auth/tunnel-url`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://abc.trycloudflare.com' })
  });
  assert.equal(reg.status, 200);
  const body = await (await get(`/api/drafts/${draftId}/capture-bookmarklet?ingest_key=k1`, member)).json();
  assert.equal(body.tunnel_up, true);
  assert.equal(body.origin, 'https://abc.trycloudflare.com');
  assert.equal(body.loader_url, 'https://abc.trycloudflare.com/draft-capture.js');
  assert.deepEqual(body.warnings, []);
});

test('the capture script is served from source with no-store', async () => {
  const res = await fetch(`${base}/draft-capture.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(await res.text(), /createCapture/);
});
