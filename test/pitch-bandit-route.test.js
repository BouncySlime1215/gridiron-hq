/**
 * BANDIT-01 at its call sites, through the router as server/index.js mounts it:
 *  R1 GET /api/trades/:leagueId/pitch-bandit?team_id= serves the bandit, off
 *     unless preview mode is on, "learning, n=0" on an empty ledger.
 *  R2 POST /api/trades/:leagueId/offers/sent with `pitch_arm` records the arm
 *     on the sent row; an unknown arm is refused before any row is written.
 *
 * Every id below is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-pitch-route-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const { acceptanceBand } = await import('../server/services/trade-acceptance.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');

run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (8811, 'pitch-route-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (8811, ?, datetime('now','+1 day'))`, hashSessionToken('pitch-token'));
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id)
     VALUES (61, 'espn', 'espn-pitch-61', 2026, 'L61', ?, 5, '1')`, JSON.stringify({ teams: [], members: [] }));
run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (61, 8811, 'member')`);

const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
const server = app.listen(0);
const port = server.address().port;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const call = async (method, url, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method, headers: { authorization: 'Bearer pitch-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

const band = acceptanceBand({
  counterparty: { receptiveness: 1, perception_delta: null, counterparty_data: false },
  edge: { passes: true } });
const deal = id => ({ id, partner_id: 3, i_give: [{ id: 1, name: 'Give One', espn_id: 11 }],
  i_get: [{ id: 2, name: 'Get One', espn_id: 22 }], acceptance: band });

test('R1: GET /pitch-bandit is off without preview, "learning, n=0" with it', async () => {
  delete process.env[PREVIEW_ENV];
  const off = await call('GET', '/api/trades/61/pitch-bandit?team_id=3');
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  assert.equal(off.body.suggested_arm, null);
  assert.match(off.body.reason, /preview/i);

  process.env[PREVIEW_ENV] = '1';
  try {
    const on = await call('GET', '/api/trades/61/pitch-bandit?team_id=3');
    assert.equal(on.body.enabled, true);
    assert.equal(on.body.label, 'learning, n=0');
    assert.equal(on.body.preview, true);
    assert.ok(on.body.suggested_arm);
    const all = await call('GET', '/api/trades/61/pitch-bandit');
    assert.equal(all.body.section.status, 'ok');
    assert.equal(all.body.section.value.label, 'learning, n=0');
  } finally { delete process.env[PREVIEW_ENV]; }
});

test('R2: POST /offers/sent records the pitch arm; an unknown arm writes nothing', async () => {
  const ok = await call('POST', '/api/trades/61/offers/sent', { deal: deal('a>b'), pitch_arm: 'value_based' });
  assert.equal(ok.status, 200);
  const r = rows(`SELECT pitch_json FROM trade_outcomes WHERE id = ?`, ok.body.id)[0];
  assert.equal(JSON.parse(r.pitch_json).arm, 'value_based');

  const before = rows(`SELECT COUNT(*) AS n FROM trade_outcomes`)[0].n;
  const bad = await call('POST', '/api/trades/61/offers/sent', { deal: deal('c>d'), pitch_arm: 'flattery' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /pitch_arm/);
  assert.equal(rows(`SELECT COUNT(*) AS n FROM trade_outcomes`)[0].n, before);

  const none = await call('POST', '/api/trades/61/offers/sent', { deal: deal('e>f') });
  assert.equal(none.status, 200);
  assert.equal(rows(`SELECT pitch_json FROM trade_outcomes WHERE id = ?`, none.body.id)[0].pitch_json, null);
});
