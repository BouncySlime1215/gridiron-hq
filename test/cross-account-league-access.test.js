import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Two accounts, two leagues, and the question that only matters once there is
 * more than one person on the platform: can one of them read the other's
 * league by naming its id?
 *
 * Before the membership check in `trades.js`'s `league()` helper, the answer
 * was yes for all 32 league-scoped routes in that file, and for
 * `tradelab.js`'s analysis route — they looked a league up by id and never
 * asked who was asking. POST /:leagueId/brain/managers/:rosterId made it a
 * write, not just a read.
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-cross-account-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');
const { default: tradelabRouter } = await import('../server/routes/tradelab.js');
const { default: leaguesRouter } = await import('../server/routes/leagues.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/leagues', ...legacyAuthenticated, leaguesRouter);
app.use('/api/tradelab', ...legacyAuthenticated, tradelabRouter);
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
// The same handler server/index.js installs: AuthorizationError carries 403.
app.use((err, _req, res, _next) => res.status(Number.isInteger(err.status) ? err.status : 500)
  .json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;

function account(subject, token) {
  run(`INSERT INTO users (subject, display_name) VALUES (?, ?)`, subject, subject);
  const id = row('SELECT last_insert_rowid() AS id').id;
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES (?,?,datetime('now','+1 day'))`, id, hashSessionToken(token));
  return id;
}

function league(name) {
  run(`INSERT INTO leagues (platform, league_id, season, name, payload, team_count)
       VALUES ('espn', ?, 2026, ?, '{"teams":[]}', 12)`, `id-${name}`, name);
  return row('SELECT last_insert_rowid() AS id').id;
}

const nick = account('nick', 'nick-token');
const friend = account('friend', 'friend-token');
const nicksLeague = league("Nick's Dynasty");
const friendsLeague = league("Friend's Redraft");
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,'commissioner')`, nicksLeague, nick);
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,'commissioner')`, friendsLeague, friend);

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const as = token => ({ Authorization: `Bearer ${token}` });

test('each account lists only its own leagues', async () => {
  const mine = await (await fetch(`${base}/leagues`, { headers: as('nick-token') })).json();
  assert.deepEqual(mine.map(l => l.id), [nicksLeague]);
  const theirs = await (await fetch(`${base}/leagues`, { headers: as('friend-token') })).json();
  assert.deepEqual(theirs.map(l => l.id), [friendsLeague]);
});

test('a signed-in account cannot read another account\'s league through /api/trades', async () => {
  // DERIVED FROM THE ROUTER, not a hand-kept list. The list this replaced named
  // five routes that were deleted on 2026-09-20, and the cut turned a security
  // assertion into a 404 — the test went red for the right reason, but a list
  // that rots is a list that will one day go GREEN for the wrong one, when a new
  // league-scoped route is added and nobody remembers to add it here. Every GET
  // this router declares under /:leagueId is probed instead.
  const paths = tradesRouter.stack
    .filter(l => l.route?.path?.startsWith('/:leagueId') && l.route.methods?.get)
    .map(l => l.route.path);
  assert.ok(paths.length >= 15, `expected the router to declare league-scoped GETs, found ${paths.length}`);

  for (const p of paths) {
    const url = p.replace('/:leagueId', '').replace(/:[A-Za-z]+/g, '1');
    const response = await fetch(`${base}/trades/${nicksLeague}${url}`, { headers: as('friend-token') });
    // 410 is the retired-route tombstone (`retired()` in trades.js). It answers
    // before the membership check and that is not a leak: it carries a pointer
    // and nothing about the league. Every other answer must be the refusal.
    assert.ok(response.status === 403 || response.status === 410,
      `GET /trades/:id${url} must refuse a non-member, got ${response.status}`);
  }
});

test('a non-member cannot WRITE a manager profile into another league', async () => {
  const response = await fetch(`${base}/trades/${nicksLeague}/brain/managers/1`, {
    method: 'POST', headers: { ...as('friend-token'), 'content-type': 'application/json' },
    body: JSON.stringify({ archetype: 'planted by a stranger' })
  });
  assert.equal(response.status, 403);
  // And nothing was written on the way to being refused.
  assert.equal(row('SELECT COUNT(*) AS n FROM manager_profiles WHERE league_id=?', nicksLeague).n, 0);
});

test('the AI routes refuse a non-member before they can spend anything', async () => {
  for (const route of ['sense-check', 'explain']) {
    const response = await fetch(`${base}/trades/${nicksLeague}/${route}`, {
      method: 'POST', headers: { ...as('friend-token'), 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    // 400 is the "no Anthropic key" guard, which sits ahead of the league
    // lookup; either way a non-member never reaches the league's data.
    assert.ok([400, 403].includes(response.status), `${route} answered ${response.status}`);
  }
});

test('tradelab analysis is scoped the same way', async () => {
  assert.equal((await fetch(`${base}/tradelab/${nicksLeague}/analysis`, { headers: as('friend-token') })).status, 403);
  assert.notEqual((await fetch(`${base}/tradelab/${nicksLeague}/analysis`, { headers: as('nick-token') })).status, 403);
});

test('a member still reaches their own league', async () => {
  for (const route of ['scout', 'rosters', 'brain/managers']) {
    const response = await fetch(`${base}/trades/${nicksLeague}/${route}`, { headers: as('nick-token') });
    assert.notEqual(response.status, 403, `a commissioner must still reach /${route}`);
    assert.notEqual(response.status, 401);
  }
});

test('an anonymous caller gets 401, not 403', async () => {
  assert.equal((await fetch(`${base}/trades/${nicksLeague}/scout`)).status, 401);
  assert.equal((await fetch(`${base}/tradelab/${nicksLeague}/analysis`)).status, 401);
});

test('a league that does not exist is still 404, not a membership error', async () => {
  assert.equal((await fetch(`${base}/trades/999999/scout`, { headers: as('nick-token') })).status, 404);
});
