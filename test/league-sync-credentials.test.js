import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * League refresh asks the same question as every other ESPN call: whose
 * cookies?
 *
 * `syncEspnLeague` was the one ESPN path left reading credentials off the
 * league row itself. It never borrowed another account's pair, so it was not
 * the leak that `platform/espn-credentials.js` exists to close — but when the
 * row was bare it sent no cookie and carried on, and an unauthenticated fetch
 * of a private ESPN league does not fail. ESPN answers 200 with a thin public
 * payload, and `syncEspnLeague` writes it into `leagues.payload`, which
 * `trade-engine.js#loadRosters` reads directly. A league that looks connected
 * and reports zero rosters is indistinguishable from a league that really did
 * empty out.
 *
 * Measured on the parent branch before this change, on a league whose row was
 * bare while its OWNER was connected in `espn_credentials`: status 200, three
 * ESPN calls, `Cookie: null`.
 *
 * As with `espn-cookie-owner-e2e.test.js`, the assertions are made on the wire
 * rather than on a return value. Counting the calls is the only way to tell
 * "refused" apart from "asked anonymously and liked the answer".
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-league-sync-creds-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.NFL_SEASON = '2026';

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { default: leaguesRouter } = await import('../server/routes/leagues.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/leagues', ...legacyAuthenticated, leaguesRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message, code: err.code }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const OWNER_S2 = 'AEC%2FownerS2OnTheWire1234567890';
const OWNER_SWID = '{33333333-3333-3333-3333-333333333333}';

function account(subject, token, { connected = false } = {}) {
  run('INSERT INTO users (subject, display_name) VALUES (?,?)', subject, subject);
  const userId = row('SELECT id FROM users WHERE subject = ?', subject).id;
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES (?,?,datetime('now','+1 day'))`, userId, hashSessionToken(token));
  run(`INSERT INTO model_permissions (user_id, permission) VALUES (?, 'model:*')`, userId);
  if (connected) {
    run(`INSERT INTO espn_credentials (user_id, espn_s2, swid, connect_token) VALUES (?,?,?,?)`,
      userId, OWNER_S2, OWNER_SWID, `token-${subject}`);
  }
  return { userId, token };
}
const OWNER = account('sync-owner', 'owner-session-secret', { connected: true });
const STRANGER = account('sync-stranger', 'stranger-session-secret');

function makeLeague({ espnId, name, owner, s2 = null, swid = null }) {
  run(`INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid)
       VALUES ('espn', ?, 2026, ?, ?, ?)`, espnId, name, s2, swid);
  const id = row('SELECT last_insert_rowid() AS id').id;
  run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,'commissioner')`, id, owner);
  return id;
}

/** Bare row, connected owner. This is the case that used to go out anonymously. */
const BARE_ROW = makeLeague({ espnId: '800001', name: 'Bare Row League', owner: OWNER.userId });
/** The ordinary case: the pair is on the row, exactly as before. */
const ROW_PAIR = makeLeague({ espnId: '800002', name: 'Row Pair League', owner: OWNER.userId,
  s2: OWNER_S2, swid: OWNER_SWID });
/** Nobody who can see this league has ever connected ESPN. */
const ORPHAN = makeLeague({ espnId: '800003', name: 'Orphan League', owner: STRANGER.userId });

let wire = [];
function watchNetwork() {
  wire = [];
  globalThis.fetch = async (url, init = {}) => {
    if (/127\.0\.0\.1|localhost/.test(String(url))) return realFetch(url, init);
    // Only ESPN is under test here. The sync route also refreshes dynasty
    // values from fantasycalc.com, which is a different call to a public
    // endpoint and carries no credentials by design; counting it would make
    // "went out with no cookie" mean two different things.
    if (!/fantasy\.espn\.com/.test(String(url))) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    wire.push({ url: String(url), cookie: init.headers?.Cookie ?? init.headers?.cookie ?? null });
    return new Response(JSON.stringify({
      teams: [{ id: 1, name: 'A', roster: { entries: [{ playerId: 1 }] } }],
      status: { currentMatchupPeriod: 2 },
      settings: { name: 'League', scoringSettings: {}, rosterSettings: { lineupSlotCounts: {} } }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const sync = (leagueRowId, who) => fetch(`${base}/leagues/${leagueRowId}/sync`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: `Bearer ${who.token}` },
  body: '{}'
});

test('a bare league row uses its connected owner\'s credentials instead of going out anonymously', async () => {
  watchNetwork();
  const res = await sync(BARE_ROW, OWNER);
  assert.equal(res.status, 200, await res.text().catch(() => ''));

  assert.ok(wire.length > 0, 'the refresh must reach the network layer');
  for (const call of wire) {
    assert.ok(call.cookie, `THE BUG: this call went out with no cookie at all — ${call.url}`);
    assert.match(call.cookie, /ownerS2OnTheWire/, 'and it carries the owner\'s pair');
  }
});

test('a league whose row holds its own pair is unchanged', async () => {
  watchNetwork();
  const res = await sync(ROW_PAIR, OWNER);
  assert.equal(res.status, 200);
  for (const call of wire) assert.match(call.cookie ?? '', /ownerS2OnTheWire/);
});

test('a league nobody connected refuses and never reaches ESPN', async () => {
  watchNetwork();
  const res = await sync(ORPHAN, STRANGER);

  assert.equal(res.status, 409, 'the caller is signed in; it is ESPN that is not connected');
  assert.equal((await res.json()).code, 'espn_not_connected');
  assert.equal(wire.length, 0,
    'a thin public payload written down as the truth is worse than a refusal');
});

/**
 * The refusal has to be legible where a person would look for it. The
 * scheduler catches per league and writes the message onto that row
 * (services/scheduler.js#refreshLeagueRosters), so an inert league says so
 * rather than sitting at "connected" with stale rosters underneath.
 */
test('the refusal names the league it is about', async () => {
  watchNetwork();
  const body = await (await sync(ORPHAN, STRANGER)).json();
  assert.match(body.error, /Orphan League/,
    '"ESPN not connected" on an install with five leagues points at the wrong one');
});
