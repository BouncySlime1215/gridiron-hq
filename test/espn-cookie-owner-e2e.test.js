import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The cookie-owner read path, over real HTTP, with the network watched.
 *
 * Everything in `espn-credential-ownership.test.js` calls the resolver or a
 * service function. This drives the actual request path — a signed-in account
 * POSTs to a route, the route reaches a service, the service reaches `fetch` —
 * and inspects the `Cookie` header that would have gone to ESPN.
 *
 * That distinction is the whole point. The defect being fixed was not a wrong
 * answer from a lookup; it was two call sites each carrying their own copy of
 * a lookup, so the only assertion that settles it is one made on the wire.
 *
 * Two accounts, three leagues:
 *   A — NICK's, connected, its own pair on the league row.
 *   B — GUEST's, connected through GUEST's account, and the most recently
 *       fetched league on the install. This is the row the removed
 *       `ORDER BY fetched_at DESC LIMIT 1` fallback used to hand to everybody.
 *   C — NICK's, connected nowhere at all.
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-cookie-owner-e2e-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.NFL_SEASON = '2026';

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { default: draftsRouter } = await import('../server/routes/drafts.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/drafts', draftsRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message, code: err.code }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const NICK_S2 = 'AEC%2FnickS2OnTheWire1234567890';
const NICK_SWID = '{11111111-1111-1111-1111-111111111111}';
const GUEST_S2 = 'AEC%2FguestS2OnTheWire0987654321';
const GUEST_SWID = '{22222222-2222-2222-2222-222222222222}';

function account(subject, token) {
  run('INSERT INTO users (subject, display_name) VALUES (?,?)', subject, subject);
  const userId = row('SELECT id FROM users WHERE subject = ?', subject).id;
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES (?,?,datetime('now','+1 day'))`, userId, hashSessionToken(token));
  return { userId, token };
}
const NICK = account('wire-nick', 'nick-session-secret');
const GUEST = account('wire-guest', 'guest-session-secret');
// A third, signed-in account that has never connected ESPN. League C is his, so
// that "no connection" means the league's own members have none -- not merely
// that the league row is bare while its owner is connected, which resolves to
// the owner by design.
const CASUAL = account('wire-casual', 'casual-session-secret');

function makeLeague({ espnId, name, owner, s2 = null, swid = null, fetched }) {
  run(`INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid, fetched_at)
       VALUES ('espn', ?, 2026, ?, ?, ?, ?)`, espnId, name, s2, swid, fetched);
  const id = row('SELECT last_insert_rowid() AS id').id;
  run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,'commissioner')`, id, owner);
  return id;
}

const LEAGUE_A = makeLeague({ espnId: '700001', name: "Nick's League", owner: NICK.userId,
  s2: NICK_S2, swid: NICK_SWID, fetched: '2026-09-01T00:00:00Z' });
const LEAGUE_B = makeLeague({ espnId: '700002', name: "Guest's League", owner: GUEST.userId,
  s2: GUEST_S2, swid: GUEST_SWID, fetched: '2026-09-19T00:00:00Z' });
const LEAGUE_C = makeLeague({ espnId: '700003', name: 'Unconnected League', owner: CASUAL.userId,
  fetched: '2026-08-01T00:00:00Z' });

run(`INSERT INTO espn_credentials (user_id, espn_s2, swid, connect_token) VALUES (?,?,?,?)`,
  NICK.userId, NICK_S2, NICK_SWID, 'nick-connect-token');
run(`INSERT INTO espn_credentials (user_id, espn_s2, swid, connect_token) VALUES (?,?,?,?)`,
  GUEST.userId, GUEST_S2, GUEST_SWID, 'guest-connect-token');

/** Every outgoing request, with the cookie it carried. ESPN is never really called. */
let wire = [];
function watchNetwork() {
  wire = [];
  globalThis.fetch = async (url, init = {}) => {
    // The test drives the app over a real socket, so its own requests to
    // 127.0.0.1 must pass through untouched. Only calls leaving for ESPN are
    // recorded and stubbed.
    if (/127\.0\.0\.1|localhost/.test(String(url))) return realFetch(url, init);
    const cookie = init.headers?.Cookie ?? init.headers?.cookie ?? null;
    wire.push({ url: String(url), cookie });
    return new Response(JSON.stringify({
      draftDetail: { drafted: true, picks: [] },
      settings: { name: 'Mirror', draftSettings: { pickOrder: [] } },
      teams: [], status: { currentMatchupPeriod: 2 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const link = (leagueRowId, who) => fetch(`${base}/drafts/live/link`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: `Bearer ${who.token}` },
  body: JSON.stringify({ league_row_id: leagueRowId })
});

/**
 * The headline case, stated on the wire.
 *
 * Under the removed behaviour this request went out carrying GUEST's cookies:
 * `espnCookies()` was one install-wide lookup with a most-recently-fetched
 * fallback, and league B is the most recently fetched league here. Nick asking
 * for Nick's own draft would have reached ESPN as somebody else.
 */
test('one account\'s draft fetch carries its own cookies and never the other account\'s', async () => {
  watchNetwork();
  const res = await link(LEAGUE_A, NICK);
  assert.equal(res.status, 200, await res.text().catch(() => ''));

  assert.ok(wire.length > 0, 'the request must actually have reached the network layer');
  for (const call of wire) {
    assert.ok(call.cookie, `every ESPN call carries a cookie: ${call.url}`);
    assert.match(call.cookie, new RegExp(NICK_S2.replace(/[%]/g, '\\%')), 'Nick\'s own pair goes out');
    assert.doesNotMatch(call.cookie, /guestS2OnTheWire/,
      'THE BUG: the other account\'s cookies must never appear on this wire');
    assert.doesNotMatch(call.cookie, /22222222-2222/, 'nor the other account\'s SWID');
  }
});

test('the other account\'s own league carries the other account\'s cookies', async () => {
  watchNetwork();
  const res = await link(LEAGUE_B, GUEST);
  assert.equal(res.status, 200, await res.text().catch(() => ''));

  for (const call of wire) {
    assert.match(call.cookie ?? '', /guestS2OnTheWire/, 'the guest fetches as the guest');
    assert.doesNotMatch(call.cookie ?? '', /nickS2OnTheWire/, 'and never as Nick');
  }
});

/**
 * "No cookies for this user" has to be loud, and loud means the request never
 * leaves. A private ESPN league fetched anonymously answers 200 with a thin
 * public payload, which the mirror writes down as though the draft were empty —
 * so a silent anonymous fetch is worse than an error, not a graceful fallback.
 */
test('a league connected nowhere fails loudly and never reaches ESPN', async () => {
  watchNetwork();
  const res = await link(LEAGUE_C, CASUAL);

  assert.equal(res.status, 409, 'the caller is authenticated; it is ESPN that is not connected');
  assert.equal((await res.json()).code, 'espn_not_connected');
  assert.equal(wire.length, 0, 'ESPN must not be asked anonymously');
});

/**
 * And the refusal must not be satisfied by somebody else being connected.
 * League C has no pair of its own and no member with credentials; the fact that
 * two other accounts on this install are connected is not permission. This is
 * the removed fallback stated as a negative: "somebody here has cookies" used
 * to be enough, and must never be again.
 */
test('another account being connected does not make an unconnected league fetchable', async () => {
  assert.ok(row('SELECT 1 FROM espn_credentials WHERE espn_s2 IS NOT NULL'),
    'precondition: somebody on this install is connected');
  assert.equal(row(`SELECT 1 AS found FROM espn_credentials c
                      JOIN league_memberships lm ON lm.user_id = c.user_id
                     WHERE lm.league_id = ? AND c.espn_s2 IS NOT NULL`, LEAGUE_C)?.found, undefined,
    'precondition: but nobody in THIS league is');
  watchNetwork();
  const res = await link(LEAGUE_C, CASUAL);
  assert.equal(res.status, 409);
  assert.equal(wire.length, 0);
});
