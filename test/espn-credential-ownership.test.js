/**
 * One account can never make an ESPN request with another account's cookies
 * (2026-09-19).
 *
 * Until PR #14 there was one person who could reach this app, so one
 * install-wide `espn_s2`/`SWID` pair was merely untidy. Two things made it a
 * bug rather than a shortcut.
 *
 * The first is that #14 makes a second account possible, and the single slot
 * is first-write-wins: an invited person connecting ESPN takes it over, and
 * every sync afterwards runs as them, with no error and no log line. The
 * boards still render. They are just somebody else's.
 *
 * The second is that it had already happened once with ONE user.
 * `services/scheduler.js` carries an investigation from 2026-09-06: Nick's
 * ESPN session kept being kicked mid-draft, and the cause was the hourly
 * roster sweep hitting ESPN with the same cookies his browser was drafting
 * with, because the lookup was global. That was worked around with a
 * draft-window gate rather than fixed.
 *
 * So these tests are about the resolver refusing to guess. The case that
 * matters most is the last kind: not "does the right credential come back" but
 * "does a WRONG one come back when the right one is missing", because the
 * behaviour being removed answered that question with yes, silently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-espn-cred-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.NFL_SEASON = '2026';

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/claude.js');

const {
  EspnCredentialsMissing, credentialsForLeague, credentialsForUser,
  requireCredentialsForLeague, connectTokenForUser, userForConnectToken,
  saveCredentials, clearCredentials
} = await import('../server/platform/espn-credentials.js');
const { default: espnConnectRouter } = await import('../server/routes/espn-connect.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/espn-connect', espnConnectRouter);
const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/api/espn-connect`;

const realFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = realFetch;
  server.close();
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

/* Two real people. NICK is the incumbent; GUEST is the invited second account
 * that every one of these tests is about. */
function makeUser(subject) {
  run(`INSERT INTO users (subject, display_name) VALUES (?, ?)`, subject, subject);
  return row('SELECT last_insert_rowid() AS id').id;
}
const NICK = makeUser('owner-nick');
const GUEST = makeUser('invited-guest');

const NICK_TOKEN = 'session-token-nick';
const GUEST_TOKEN = 'session-token-guest';
run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now','+1 day'))`,
  NICK, hashSessionToken(NICK_TOKEN));
run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now','+1 day'))`,
  GUEST, hashSessionToken(GUEST_TOKEN));

const NICK_S2 = 'AEC%2FnickS2valueLongAndOpaque1234567890';
const NICK_SWID = '{11111111-1111-1111-1111-111111111111}';
const GUEST_S2 = 'AEC%2FguestS2valueLongAndOpaque0987654321';
const GUEST_SWID = '{22222222-2222-2222-2222-222222222222}';

function league({ id, name, owner, s2 = null, swid = null, role = 'commissioner', fetched = null }) {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, espn_s2, swid, fetched_at)
       VALUES (?, 'espn', ?, 2026, ?, ?, ?, ?)`, id, String(9000 + id), name, s2, swid, fetched);
  if (owner) run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,?)`, id, owner, role);
  return id;
}

function reset() {
  run(`DELETE FROM league_memberships`);
  run(`DELETE FROM leagues`);
  run(`UPDATE espn_credentials SET espn_s2 = NULL, swid = NULL`);
}

/* ------------------------------------------------------- resolving a league */

test("a league's own stored pair is used when it has one", () => {
  reset();
  league({ id: 1, name: "Nick's league", owner: NICK, s2: NICK_S2, swid: NICK_SWID });
  const got = credentialsForLeague(1);
  assert.equal(got.s2, NICK_S2);
  assert.equal(got.source, 'league');
});

test('a league with no pair of its own falls back to a member, commissioner first', () => {
  reset();
  saveCredentials(NICK, NICK_S2, NICK_SWID);
  saveCredentials(GUEST, GUEST_S2, GUEST_SWID);
  league({ id: 2, name: 'Shared league', owner: GUEST, role: 'member' });
  run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (2, ?, 'commissioner')`, NICK);

  const got = credentialsForLeague(2);
  assert.equal(got.userId, NICK, 'the commissioner is preferred over a plain member');
  assert.equal(got.s2, NICK_S2);
  assert.equal(got.source, 'member');
});

test('THE BUG: a non-member\'s credentials are never borrowed, however recently they synced', () => {
  reset();
  // Guest is connected and their league was fetched most recently — which is
  // precisely the row the old `ORDER BY fetched_at DESC LIMIT 1` fallback
  // picked, install-wide, with no reference to who was asking.
  saveCredentials(GUEST, GUEST_S2, GUEST_SWID);
  league({ id: 3, name: "Guest's league", owner: GUEST, s2: GUEST_S2, swid: GUEST_SWID, fetched: '2026-09-19T20:00:00Z' });
  // Nick's league has no pair and Nick is not connected.
  league({ id: 4, name: "Nick's unconnected league", owner: NICK, fetched: '2026-09-01T00:00:00Z' });

  const got = credentialsForLeague(4);
  assert.equal(got.s2, null, "guest's cookies must not be used to fetch Nick's league");
  assert.equal(got.swid, null);
  assert.equal(got.userId, null);
});

test('a missing connection throws by name rather than fetching ESPN anonymously', () => {
  reset();
  league({ id: 5, name: 'DMV League 23-24', owner: NICK });
  let err = null;
  try { requireCredentialsForLeague(5); } catch (e) { err = e; }
  assert.ok(err instanceof EspnCredentialsMissing, 'a missing connection is its own error type, not a generic one');
  // An anonymous fetch of a private league does not fail — ESPN answers with a
  // thin public payload that a sync writes down as real. Failing loudly, and
  // naming the league, is the whole point.
  assert.match(err.message, /DMV League 23-24/);
  assert.equal(err.status, 409, 'the caller is authenticated; it is ESPN that is not connected');
});

test('credentialsForUser reads one account and never substitutes another', () => {
  reset();
  saveCredentials(GUEST, GUEST_S2, GUEST_SWID);
  assert.equal(credentialsForUser(NICK).s2, null, 'Nick is not connected, and guest is not a fallback');
  assert.equal(credentialsForUser(GUEST).s2, GUEST_S2);
  assert.equal(credentialsForUser(null).s2, null);
});

test('clearing one account leaves the other connected', () => {
  reset();
  saveCredentials(NICK, NICK_S2, NICK_SWID);
  saveCredentials(GUEST, GUEST_S2, GUEST_SWID);
  clearCredentials(GUEST);
  assert.equal(credentialsForUser(GUEST).s2, null);
  assert.equal(credentialsForUser(NICK).s2, NICK_S2, "one person disconnecting must not disconnect everyone");
});

/* -------------------------------------------------------------- the token */

test('a bookmarklet token identifies exactly the account that generated it', () => {
  const nickToken = connectTokenForUser(NICK);
  const guestToken = connectTokenForUser(GUEST);
  assert.notEqual(nickToken, guestToken, 'one token per install was the old problem');
  assert.equal(userForConnectToken(nickToken), NICK);
  assert.equal(userForConnectToken(guestToken), GUEST);
});

test('an unrecognised, empty or over-long token resolves to nobody rather than throwing', () => {
  assert.equal(userForConnectToken('not-a-real-token'), null);
  assert.equal(userForConnectToken(''), null);
  assert.equal(userForConnectToken('x'.repeat(500)), null, 'a length mismatch must not crash the comparison');
  assert.equal(userForConnectToken(undefined), null);
});

test('the token is stable across calls, so an already-installed bookmarklet keeps working', () => {
  assert.equal(connectTokenForUser(NICK), connectTokenForUser(NICK));
});

/* ------------------------------------------------------------ over the wire */

function stubEspn({ ok = true, status = 200, leagues = [] } = {}) {
  globalThis.fetch = async () => ({
    ok, status,
    json: async () => ({
      preferences: leagues.map(l => ({
        metaData: { entry: { gameId: 1, seasonId: 2026, entryId: '1', groups: [{ groupId: l, groupName: `League ${l}` }] } }
      }))
    })
  });
}

test("the guest's bookmarklet token writes the guest's row, not the owner's", async () => {
  reset();
  saveCredentials(NICK, NICK_S2, NICK_SWID);
  const guestToken = connectTokenForUser(GUEST);
  stubEspn({ leagues: [] });

  const res = await realFetch(`${base}/cookies?t=${encodeURIComponent(guestToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ espn_s2: GUEST_S2, swid: GUEST_SWID })
  });
  assert.equal((await res.json()).ok, true);
  assert.equal(credentialsForUser(GUEST).s2, GUEST_S2);
  assert.equal(credentialsForUser(NICK).s2, NICK_S2,
    'connecting a second account must not take over the first account\'s connection');
});

test('connecting does not stamp cookies onto leagues the caller is not in', async () => {
  reset();
  // Nick's league has no swid yet — exactly the row the old blanket UPDATE
  // matched on, install-wide. The guest has never heard of it.
  league({ id: 6, name: "Nick's league", owner: NICK });
  league({ id: 7, name: "Guest's league", owner: GUEST });
  stubEspn({ leagues: [] });

  await realFetch(`${base}/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${GUEST_TOKEN}` },
    body: JSON.stringify({ espn_s2: GUEST_S2, swid: GUEST_SWID })
  });

  assert.equal(row('SELECT espn_s2 FROM leagues WHERE id = 6').espn_s2, null,
    "the guest's cookies must not land on a league the guest is not a member of");
  assert.equal(row('SELECT espn_s2 FROM leagues WHERE id = 7').espn_s2, GUEST_S2,
    'their own league is still connected, which is the point of the call');
});

test('status shows only the caller\'s own leagues', async () => {
  reset();
  saveCredentials(GUEST, GUEST_S2, GUEST_SWID);
  league({ id: 8, name: "Nick's private league", owner: NICK });
  league({ id: 9, name: "Guest's league", owner: GUEST });

  const res = await realFetch(`${base}/status`, { headers: { authorization: `Bearer ${GUEST_TOKEN}` } });
  const body = await res.json();
  assert.equal(body.connected, true);
  assert.deepEqual(body.leagues.map(l => l.name), ["Guest's league"],
    'the unscoped version listed every ESPN league on the install to anyone signed in');
});

test('disconnecting clears the caller\'s leagues and nobody else\'s', async () => {
  reset();
  saveCredentials(NICK, NICK_S2, NICK_SWID);
  saveCredentials(GUEST, GUEST_S2, GUEST_SWID);
  league({ id: 10, name: "Nick's league", owner: NICK, s2: NICK_S2, swid: NICK_SWID });
  league({ id: 11, name: "Guest's league", owner: GUEST, s2: GUEST_S2, swid: GUEST_SWID });

  const res = await realFetch(`${base}/cookies`, {
    method: 'DELETE', headers: { authorization: `Bearer ${GUEST_TOKEN}` }
  });
  assert.equal((await res.json()).ok, true);
  assert.equal(row('SELECT espn_s2 FROM leagues WHERE id = 11').espn_s2, null);
  assert.equal(row('SELECT espn_s2 FROM leagues WHERE id = 10').espn_s2, NICK_S2,
    'this used to null the cookies on every ESPN league in the database');
  assert.equal(credentialsForUser(NICK).s2, NICK_S2);
});

/* --------------------------------------------------------------- migration */

/**
 * The migration is the part that decides whether Nick is still connected the
 * morning after this deploys, so it gets its own test rather than being taken
 * on trust. `up()` is called directly against a fixture rather than through
 * the runner: what is being checked is where the existing pair LANDS, and that
 * is a property of the function, not of the ordering.
 */
test('migration 063 hands the install-wide pair to the account that owns the leagues', async () => {
  const { up } = await import('../server/migrations/063_espn_credentials.js');

  // Rebuild the pre-migration world: a global pair, a global connect token,
  // and an owner row with the subject the local-auth path creates.
  run(`DELETE FROM espn_credentials`);
  run(`INSERT INTO users (subject, display_name) VALUES ('gridiron-local-owner', 'Owner')`);
  const ownerId = row('SELECT last_insert_rowid() AS id').id;
  run(`INSERT INTO app_settings (key, value) VALUES ('espn_s2', ?), ('swid', ?), ('espn_connect_token', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    NICK_S2, NICK_SWID, 'the-original-install-token');

  up(db);

  const carried = row('SELECT * FROM espn_credentials WHERE user_id = ?', ownerId);
  assert.equal(carried.espn_s2, NICK_S2, 'the deploy must not silently disconnect ESPN');
  assert.equal(carried.swid, NICK_SWID);
  assert.equal(carried.connect_token, 'the-original-install-token',
    'reusing the token means a bookmarklet already in the bookmarks bar keeps working');

  // And the global slot is gone, in the same transaction. A fallback that still
  // reads is a fallback nobody removes.
  for (const key of ['espn_s2', 'swid', 'espn_connect_token']) {
    assert.equal(row(`SELECT value FROM app_settings WHERE key = ?`, key), undefined,
      `app_settings.${key} must not survive the migration`);
  }
});

/**
 * Everything above this line tests the RESOLVER. That is the producer, and a
 * producer that refuses correctly proves nothing about whether its callers
 * actually go through it — the bug being fixed was two call sites that each
 * had their own copy of the lookup. So this tests the CONSUMER: the function
 * that really talks to ESPN, with the network watched.
 *
 * The assertion that matters is not that it throws. It is that `fetch` is
 * never reached. A private ESPN league fetched with no cookies does not fail:
 * ESPN answers 200 with a thin public payload, and the reconciler writes that
 * down as though the draft were empty. A loud failure here is the only thing
 * standing between "not connected" and "connected, and the league is empty".
 */
test('the draft fetch never reaches ESPN for a league with no connection', async () => {
  reset();
  const { fetchDraftDetail } = await import('../server/services/espn-draft.js');
  const orphan = league({ id: 61, name: 'Nobody Connected', owner: GUEST, role: 'member' });

  let calls = 0;
  globalThis.fetch = async (...args) => { calls++; return realFetch(...args); };
  let err = null;
  try { await fetchDraftDetail(9061, 2026, orphan); } catch (e) { err = e; }
  globalThis.fetch = realFetch;

  assert.ok(err instanceof EspnCredentialsMissing,
    'a missing connection must be its own error, not an empty-looking draft');
  assert.equal(calls, 0, 'ESPN must not be asked anonymously: a 200 with a thin payload is worse than a throw');
  assert.match(err.message, /Nobody Connected/, 'the message names the league, not just "ESPN"');
  assert.equal(err.status, 409);
});

/**
 * `down()`, exercised rather than asserted.
 *
 * A rollback here is not a code rollback. Dropping `espn_credentials` without
 * putting the pair back where the pre-063 code reads it would leave an older
 * image running and disconnected, and there is no source to re-derive a
 * cookie pair from — it lives in Nick's browser, or nowhere.
 */
test('migration 063 down() puts the pair back where the old code reads it', async () => {
  const { up, down } = await import('../server/migrations/063_espn_credentials.js');
  reset();
  run(`DELETE FROM app_settings WHERE key IN ('espn_s2','swid','espn_connect_token')`);
  run(`DELETE FROM espn_credentials`);

  // Not borrowed from the test above it: this test owns its own fixture.
  if (!row(`SELECT 1 FROM users WHERE subject='gridiron-local-owner'`)) {
    run(`INSERT INTO users (subject, display_name) VALUES ('gridiron-local-owner', 'Owner')`);
  }
  const ownerId = row(`SELECT id FROM users WHERE subject='gridiron-local-owner'`).id;
  run(`INSERT INTO espn_credentials (user_id, espn_s2, swid, connect_token, updated_at)
       VALUES (?,?,?,?,datetime('now'))`, ownerId, NICK_S2, NICK_SWID, 'token-before-rollback');

  down(db);

  const setting = k => row(`SELECT value FROM app_settings WHERE key = ?`, k)?.value ?? null;
  assert.equal(setting('espn_s2'), NICK_S2, 'an older image boots still connected');
  assert.equal(setting('swid'), NICK_SWID);
  assert.equal(setting('espn_connect_token'), 'token-before-rollback',
    'and the bookmarklet in the bookmarks bar still matches');
  assert.equal(row(`SELECT name FROM sqlite_master WHERE type='table' AND name='espn_credentials'`), undefined,
    'the table is gone, so the pre-063 code cannot half-read it');

  // And forward again, which is the real shape of a recovery: roll back,
  // fix, redeploy. The pair has to survive the round trip, not just one leg.
  up(db);
  const carried = row('SELECT * FROM espn_credentials WHERE user_id = ?', ownerId);
  assert.equal(carried.espn_s2, NICK_S2, 'up-down-up is not a disconnection');
  assert.equal(carried.connect_token, 'token-before-rollback');
});

/**
 * The fallback branch of the migration, which nothing else covers.
 *
 * `gridiron-local-owner` exists on this deployment, so the primary branch is
 * the one that will actually run tonight. But the fallback is what runs on any
 * database that never went through the loopback path, and an untested branch
 * in a migration is a branch that gets discovered during a deploy.
 */
test('migration 063 falls back to the commissioner when there is no local owner', async () => {
  const { up } = await import('../server/migrations/063_espn_credentials.js');
  reset();
  run(`DELETE FROM espn_credentials`);
  run(`DELETE FROM app_settings WHERE key IN ('espn_s2','swid','espn_connect_token')`);

  // No `gridiron-local-owner` row at all: rename it out of the way.
  run(`UPDATE users SET subject='was-local-owner' WHERE subject='gridiron-local-owner'`);
  try {
    league({ id: 71, name: 'Older League', owner: NICK, fetched: '2026-09-01T00:00:00Z' });
    league({ id: 72, name: 'Most Recent League', owner: GUEST, fetched: '2026-09-18T00:00:00Z' });
    run(`INSERT INTO app_settings (key, value) VALUES ('espn_s2', ?), ('swid', ?)`, NICK_S2, NICK_SWID);

    up(db);

    assert.equal(row(`SELECT espn_s2 FROM espn_credentials WHERE user_id = ?`, GUEST)?.espn_s2, NICK_S2,
      'the commissioner of the most recently fetched ESPN league takes ownership');
    assert.equal(row(`SELECT 1 AS found FROM espn_credentials WHERE user_id = ? AND espn_s2 IS NOT NULL`, NICK)?.found,
      undefined, 'and nobody else receives a copy of the pair');
  } finally {
    run(`UPDATE users SET subject='gridiron-local-owner' WHERE subject='was-local-owner'`);
  }
});
