import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Same isolated-DB pattern as the rest of the suite: never touch the real
// data.sqlite, which holds real ESPN cookies.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-espn-connect-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.NFL_SEASON = '2026';

const { db, row, run } = await import('../server/db/index.js');
// app_settings is created by claude.js's import-time db.exec().
await import('../server/services/claude.js');
const { default: espnConnectRouter, extractEspnCookies } = await import('../server/routes/espn-connect.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/espn-connect', espnConnectRouter);
const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/api/espn-connect`;

// Tests hit this local server with the real fetch; globalThis.fetch gets stubbed to
// control the ESPN call, so capture the real one first.
const realFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = realFetch;
  server.close();
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

// Realistic shapes: espn_s2 is a long opaque token, SWID a braced GUID.
const GOOD_S2 = 'AEC%2Fabcdefgh1234567890RealLookingEspnS2TokenValue';
const GOOD_SWID = '{11112222-3333-4444-5555-666677778888}';

function stubEspn({ ok = true, status = 200, leagues = [] } = {}) {
  globalThis.fetch = async () => ({
    ok,
    status,
    json: async () => ({
      preferences: leagues.map(l => ({
        metaData: { entry: { gameId: 1, seasonId: 2026, entryId: l.team_id ?? '1', groups: [{ groupId: l.league_id, groupName: l.name }] } }
      }))
    })
  });
}

function resetState() {
  run(`DELETE FROM app_settings WHERE key IN ('espn_s2','swid')`);
  run(`DELETE FROM leagues WHERE platform = 'espn'`);
}

/* ------------------------------------------------------------------- parsing */

test('extractEspnCookies pulls both values out of a raw document.cookie dump', () => {
  const dump = `SWID=${GOOD_SWID}; espn_s2=${GOOD_S2}; other=junk; _ga=GA1.2.999`;
  const got = extractEspnCookies(dump);
  assert.equal(got.espn_s2, decodeURIComponent(GOOD_S2));
  assert.equal(got.swid, GOOD_SWID);
});

test('extractEspnCookies handles the two values on separate lines, in either order', () => {
  const got = extractEspnCookies(`espn_s2 = ${GOOD_S2}\nSWID = ${GOOD_SWID}`);
  assert.equal(got.espn_s2, decodeURIComponent(GOOD_S2));
  assert.equal(got.swid, GOOD_SWID);
});

test('extractEspnCookies accepts a bare GUID with no SWID= key at all', () => {
  const got = extractEspnCookies(`espn_s2=${GOOD_S2}\n11112222-3333-4444-5555-666677778888`);
  assert.equal(got.swid, '11112222-3333-4444-5555-666677778888');
});

test('extractEspnCookies returns nulls rather than guessing when the text has neither', () => {
  const got = extractEspnCookies('I pasted the wrong thing entirely');
  assert.equal(got.espn_s2, null);
  assert.equal(got.swid, null);
});

/* ---------------------------------------------------------------- cross-origin */

test('a preflight from espn.com is answered with the headers the browser requires', async () => {
  const res = await realFetch(`${base}/cookies`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://www.espn.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    }
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://www.espn.com');
  assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /content-type/i);
  // Without this, Chrome refuses a public site -> private address request outright.
  assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
});

test('a preflight from an unrelated site gets no cross-origin grant', async () => {
  const res = await realFetch(`${base}/cookies`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(res.headers.get('access-control-allow-origin'), null,
    'only ESPN origins may post credentials to this endpoint');
});

/* ------------------------------------------------------------- capture + guard */

test('valid cookies are stored and the discovered leagues come back', async () => {
  resetState();
  stubEspn({ leagues: [{ league_id: '1458727014', name: 'DMV League' }] });
  const res = await realFetch(`${base}/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ espn_s2: GOOD_S2, swid: GOOD_SWID })
  });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.leagues_found, 1);
  assert.equal(row(`SELECT value FROM app_settings WHERE key='espn_s2'`).value, GOOD_S2);
});

test('the paste box accepts one messy blob and connects from it', async () => {
  resetState();
  stubEspn({ leagues: [] });
  const res = await realFetch(`${base}/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: `_ga=GA1.2.1; SWID=${GOOD_SWID}; espn_s2=${GOOD_S2}; s_ecid=xyz` })
  });
  assert.equal((await res.json()).ok, true);
  assert.equal(row(`SELECT value FROM app_settings WHERE key='swid'`).value, GOOD_SWID);
});

test('cookies ESPN rejects are never persisted', async () => {
  resetState();
  stubEspn({ ok: false, status: 401 });
  const res = await realFetch(`${base}/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ espn_s2: 'bogus', swid: '{bogus}' })
  });
  assert.equal(res.status, 400);
  assert.equal(row(`SELECT value FROM app_settings WHERE key='espn_s2'`), undefined,
    'a rejected credential must not land in storage');
});

test('an unrecognised SWID (ESPN answers 404, not 401) still reads as a credential problem', async () => {
  resetState();
  stubEspn({ ok: false, status: 404 });
  const res = await realFetch(`${base}/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ espn_s2: 'nope', swid: '{11111111-2222-3333-4444-555555555555}' })
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error, /didn't recognise those cookies/,
    'a raw "ESPN returned 404" is useless to the person trying to connect');
  assert.doesNotMatch(body.error, /404/);
});

test('a failed reconnect leaves a working connection completely untouched', async () => {
  resetState();
  // Establish a good connection first.
  stubEspn({ leagues: [{ league_id: '999', name: 'Existing League' }] });
  await realFetch(`${base}/cookies`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ espn_s2: GOOD_S2, swid: GOOD_SWID })
  });
  run(`INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid)
       VALUES ('espn','999',2026,'Existing League',?,?)`, GOOD_S2, GOOD_SWID);

  // Now a bad attempt — the exact shape of the accident that wiped real credentials:
  // an unvalidated write used to overwrite every league's cookies with whatever arrived.
  stubEspn({ ok: false, status: 401 });
  const res = await realFetch(`${base}/cookies`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ espn_s2: 'probe', swid: '{probe}' })
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.unchanged, true);
  assert.equal(row(`SELECT value FROM app_settings WHERE key='espn_s2'`).value, GOOD_S2,
    'the previously working cookie must survive a failed attempt');
  assert.equal(row(`SELECT espn_s2 FROM leagues WHERE league_id='999'`).espn_s2, GOOD_S2,
    'and the league row must not have been clobbered either');
});

test('connecting a second ESPN account does not overwrite the first account\'s leagues', async () => {
  resetState();
  const OTHER_SWID = '{99999999-8888-7777-6666-555544443333}';
  run(`INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid)
       VALUES ('espn','111',2026,'Account A League','account-a-s2',?)`, GOOD_SWID);

  stubEspn({ leagues: [] });
  await realFetch(`${base}/cookies`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ espn_s2: 'account-b-s2', swid: OTHER_SWID })
  });

  assert.equal(row(`SELECT espn_s2 FROM leagues WHERE league_id='111'`).espn_s2, 'account-a-s2',
    "account B's connection must not rebind account A's league to the wrong credentials");
});

test('a paste with nothing usable in it is a clear 400, not a silent success', async () => {
  resetState();
  const res = await realFetch(`${base}/cookies`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: 'just some random text I copied' })
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /espn_s2 and SWID/);
});

/* ------------------------------------------------------------------- portability */

test('the bookmarklet targets the host the request actually came in on, not a hardcoded port', async () => {
  const res = await realFetch(`${base}/bookmarklet`);
  const body = await res.json();
  assert.equal(body.origin, `http://127.0.0.1:${port}`,
    'a clone running on a different port must get a bookmarklet that points at itself');
  assert.match(decodeURIComponent(body.href), new RegExp(`127\\.0\\.0\\.1:${port}`));
});

test('the emitted bookmarklet is syntactically valid JavaScript', async () => {
  // The minifier used to strip the `//` inside `http://…` as if it were a comment,
  // emitting `fetch('http:` — invalid JS, so the button silently did nothing at all.
  // Parsing it here (without running it) is what catches that class of breakage.
  const body = await (await realFetch(`${base}/bookmarklet`)).json();
  const source = decodeURIComponent(body.href).replace(/^javascript:/, '');
  assert.doesNotThrow(() => new Function(source), 'bookmarklet must parse as JavaScript');
  assert.doesNotThrow(() => new Function(body.console_snippet), 'console fallback must parse too');
  // And the POST target must have survived minification intact.
  assert.match(source, /fetch\('http:\/\/127\.0\.0\.1:\d+\/api\/espn-connect\/cookies'/);
});
