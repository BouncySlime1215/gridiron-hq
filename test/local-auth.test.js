import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-local-auth-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/espn-draft.js');
const { default: localAuthRouter, isLoopback } = await import('../server/routes/local-auth.js');
const { default: leaguesRouter } = await import('../server/routes/leagues.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const express = (await import('express')).default;

run(`INSERT INTO leagues (platform, league_id, season, name)
     VALUES ('espn','12345',2026,'Local Test League')`);
const leagueId = row('SELECT last_insert_rowid() AS id').id;

const app = express();
app.use(express.json());
app.use('/api/auth', localAuthRouter);
app.use('/api/leagues', ...legacyAuthenticated, leaguesRouter);
const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/api`;

test.after(() => {
  server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true });
});

test('only literal loopback addresses qualify for automatic local sign-in', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.1.20'), false);
  assert.equal(isLoopback('8.8.8.8'), false);
});

test('a local browser provisions one owner with league and model access', async () => {
  const provision = await fetch(`${base}/auth/local-session`, { method: 'POST' });
  assert.equal(provision.status, 200);
  const body = await provision.json();
  assert.ok(body.token?.length > 30);
  assert.equal(body.leagues, 1);

  const user = row(`SELECT id FROM users WHERE subject='gridiron-local-owner'`);
  assert.ok(user);
  assert.equal(row('SELECT role FROM league_memberships WHERE league_id=? AND user_id=?', leagueId, user.id).role, 'commissioner');
  assert.equal(row(`SELECT permission FROM model_permissions WHERE user_id=?`, user.id).permission, 'model:*');

  const protectedResponse = await fetch(`${base}/leagues`, {
    headers: { Authorization: `Bearer ${body.token}` }
  });
  assert.equal(protectedResponse.status, 200);
  assert.equal((await protectedResponse.json()).length, 1);
});

test('protected routes still reject anonymous callers', async () => {
  assert.equal((await fetch(`${base}/leagues`)).status, 401);
});
