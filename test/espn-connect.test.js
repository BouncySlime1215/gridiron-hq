import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Same isolated-DB pattern as test/model-integrity.test.js and
// test/fantasy-workflows.test.js: point GRIDIRON_DB_PATH at a throwaway file
// before anything imports server/db/index.js, so this suite never touches
// the real data.sqlite (which could hold a real user's ESPN cookies).
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-espn-connect-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.NFL_SEASON = '2026';

const { db, run } = await import('../server/db/index.js');
// espn-connect.js reads/writes `app_settings`, but that table is created by
// claude.js's import-time db.exec(), not by db/index.js itself — import it
// for its side effect so the table exists under the isolated test DB.
await import('../server/services/claude.js');
const espnConnectRouter = (await import('../server/routes/espn-connect.js')).default;
const express = (await import('express')).default;

/* ---------------------------------------------------------------- harness */

// Every console call is captured instead of printed, so the assertions below
// can prove — not just assume — that a raw cookie value never reaches a log
// line, no matter which code path (success, discovery filter, or thrown
// error) produced it.
const capturedLogs = [];
const originalConsole = { log: console.log, error: console.error, warn: console.warn };
for (const level of ['log', 'error', 'warn']) {
  console[level] = (...args) => capturedLogs.push(args.map(String).join(' '));
}

const app = express();
app.use(express.json());
app.use('/api/espn-connect', espnConnectRouter);
// Mirrors server/index.js's error handler exactly, including the console.error
// call, so a thrown error is captured through the same path production uses.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/api/espn-connect`;

// The route module calls the bare, ambient `fetch` to reach ESPN's API —
// tests below stub globalThis.fetch to control that. But every test also
// needs its OWN fetch to hit this local server, and that must always be the
// real implementation, or a stub aimed at the ESPN call would swallow the
// test's own request too. Capture the real one now, before any stubbing.
const realFetch = globalThis.fetch;

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
});

function resetState() {
  run(`DELETE FROM app_settings WHERE key IN ('espn_s2','swid')`);
  run(`DELETE FROM leagues WHERE platform = 'espn'`);
  capturedLogs.length = 0;
}

// Deliberately long/realistic-shaped test secrets: espn_s2 is normally a long
// opaque token and SWID a GUID. Long values make "no raw value anywhere"
// assertions meaningful — a masked preview (first 6 + last 4 chars) is a
// small, clearly-partial fragment of these, never the whole string.
const RAW_S2 = 'AEC%2Fabcdefgh1234567890SecretEspnS2TokenValueDoNotLeakXYZ';
const RAW_SWID_BARE = '11112222-3333-4444-5555-666677778888';
const RAW_SWID_BRACED = `{${RAW_SWID_BARE}}`;

const CURRENT_SEASON = 2026;

function fanApiPayload() {
  return {
    preferences: [
      // Matches this season and is a football (gameId 1) entry — the one
      // case discoverLeagues() is supposed to surface.
      {
        metaData: {
          entry: {
            groups: [{ groupId: 555444, groupName: 'Matching League' }],
            entryId: 10,
            gameId: 1,
            seasonId: CURRENT_SEASON,
            entryMetadata: { teamName: 'My Team' }
          }
        }
      },
      // Same account, but a stale season for this league/season pairing —
      // must be excluded ("rejected") from the connect result.
      {
        metaData: {
          entry: {
            groups: [{ groupId: 999888, groupName: 'Old Season League' }],
            entryId: 11,
            gameId: 1,
            seasonId: CURRENT_SEASON - 6,
            entryMetadata: { teamName: 'Old Team' }
          }
        }
      },
      // Same season, but a non-football game (e.g. fantasy baseball) — must
      // also be excluded.
      {
        metaData: {
          entry: {
            groups: [{ groupId: 777666, groupName: 'Other Sport League' }],
            entryId: 12,
            gameId: 2,
            seasonId: CURRENT_SEASON,
            entryMetadata: { teamName: 'Other Team' }
          }
        }
      }
    ]
  };
}

function assertNoRawSecrets(haystack, label) {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  assert.ok(!text.includes(RAW_S2), `${label} must not contain the raw espn_s2 value`);
  assert.ok(!text.includes(RAW_SWID_BARE), `${label} must not contain the raw SWID value`);
  assert.ok(!text.includes(RAW_SWID_BRACED), `${label} must not contain the raw braced SWID value`);
}

/* ------------------------------------------------------------ /bookmarklet */

test('GET /bookmarklet returns a javascript: href and never embeds a live cookie', async () => {
  const res = await realFetch(`${base}/bookmarklet`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.match(body.href, /^javascript:/);
  assert.match(body.origin, /^http:\/\/localhost:\d+$/);
  assertNoRawSecrets(body, 'GET /bookmarklet response body');
});

/* ---------------------------------------------------------------- /cookies */

test('POST /cookies succeeds and discovers the league matching the current league/season', async () => {
  resetState();
  const fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, json: async () => fanApiPayload() };
  };
  try {
    const res = await realFetch(`${base}/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ espn_s2: RAW_S2, swid: RAW_SWID_BARE, league_ids: [] })
    });
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.leagues_found, 1, 'only the matching league/season should be discovered');
    assert.equal(body.leagues[0].league_id, '555444');
    assert.equal(body.leagues[0].season, CURRENT_SEASON);

    // The upstream ESPN request must have carried the cookies (that's the
    // whole point of the endpoint) — but that is an outbound request to
    // ESPN's own API, not a response, log, or error surface.
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].opts.headers.Cookie, `espn_s2=${RAW_S2}; SWID=${RAW_SWID_BRACED}`);

    assertNoRawSecrets(bodyText, 'POST /cookies response body');
    assertNoRawSecrets(capturedLogs.join('\n'), 'log output during POST /cookies');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('POST /cookies discovery rejects leagues for a mismatched season or sport', async () => {
  resetState();
  globalThis.fetch = async () => ({ ok: true, json: async () => fanApiPayload() });
  try {
    const res = await realFetch(`${base}/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ espn_s2: RAW_S2, swid: RAW_SWID_BARE, league_ids: [] })
    });
    const body = await res.json();
    const leagueIds = body.leagues.map(l => l.league_id);

    assert.ok(!leagueIds.includes('999888'), 'a league from a different season must be rejected');
    assert.ok(!leagueIds.includes('777666'), 'a league from a different sport must be rejected');
    assert.deepEqual(leagueIds, ['555444']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('POST /cookies rejects a request missing either cookie value', async () => {
  resetState();
  const res = await realFetch(`${base}/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ espn_s2: '', swid: '' })
  });
  const bodyText = await res.text();
  assert.equal(res.status, 400);
  assert.match(bodyText, /required/);
  assertNoRawSecrets(bodyText, 'POST /cookies 400 response body');
});

/* ----------------------------------------------------------------- /status */

test('GET /status reports connected with masked previews only, never the raw cookie', async () => {
  resetState();
  run(`INSERT INTO app_settings (key, value) VALUES ('espn_s2', ?)`, RAW_S2);
  run(`INSERT INTO app_settings (key, value) VALUES ('swid', ?)`, RAW_SWID_BRACED);

  const res = await realFetch(`${base}/status`);
  const bodyText = await res.text();
  const body = JSON.parse(bodyText);

  assert.equal(res.status, 200);
  assert.equal(body.connected, true);
  assert.equal(body.source, 'bookmarklet');
  assert.equal(body.espn_s2_preview, `${RAW_S2.slice(0, 6)}…${RAW_S2.slice(-4)} (${RAW_S2.length} chars)`);
  assert.equal(body.swid_preview, `${RAW_SWID_BRACED.slice(0, 10)}…`);

  assertNoRawSecrets(bodyText, 'GET /status response body');
  assertNoRawSecrets(capturedLogs.join('\n'), 'log output during GET /status');
});

test('GET /status falls back to a manual-form league row and backfills app_settings', async () => {
  resetState();
  run(`INSERT INTO leagues (platform, league_id, season, name, espn_s2, swid, fetched_at)
       VALUES ('espn', '321', ?, 'Manual League', ?, ?, datetime('now'))`,
    CURRENT_SEASON, RAW_S2, RAW_SWID_BRACED);

  const res = await realFetch(`${base}/status`);
  const bodyText = await res.text();
  const body = JSON.parse(bodyText);

  assert.equal(body.connected, true);
  assert.equal(body.source, 'manual form');
  assertNoRawSecrets(bodyText, 'GET /status (manual form) response body');
});

test('DELETE /cookies clears the stored connection', async () => {
  resetState();
  run(`INSERT INTO app_settings (key, value) VALUES ('espn_s2', ?)`, RAW_S2);
  run(`INSERT INTO app_settings (key, value) VALUES ('swid', ?)`, RAW_SWID_BRACED);

  const del = await realFetch(`${base}/cookies`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });

  const status = await (await realFetch(`${base}/status`)).json();
  assert.equal(status.connected, false);
});

/* ---------------------------------------------------------------- /discover */

test('GET /discover requires cookies to already be connected', async () => {
  resetState();
  const res = await realFetch(`${base}/discover`);
  const bodyText = await res.text();
  assert.equal(res.status, 400);
  assert.match(bodyText, /connect below first/);
  assertNoRawSecrets(bodyText, 'GET /discover 400 response body');
});

test('GET /discover re-runs discovery with stored cookies and applies the same league/season filter', async () => {
  resetState();
  run(`INSERT INTO app_settings (key, value) VALUES ('espn_s2', ?)`, RAW_S2);
  run(`INSERT INTO app_settings (key, value) VALUES ('swid', ?)`, RAW_SWID_BRACED);
  globalThis.fetch = async () => ({ ok: true, json: async () => fanApiPayload() });
  try {
    const res = await realFetch(`${base}/discover`);
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);
    assert.equal(res.status, 200);
    assert.deepEqual(body.leagues.map(l => l.league_id), ['555444']);
    assertNoRawSecrets(bodyText, 'GET /discover response body');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a thrown ESPN-fetch error surfaces a generic message, never the cookie that caused it', async () => {
  resetState();
  run(`INSERT INTO app_settings (key, value) VALUES ('espn_s2', ?)`, RAW_S2);
  run(`INSERT INTO app_settings (key, value) VALUES ('swid', ?)`, RAW_SWID_BRACED);
  // Simulate a network failure whose message an attacker-controlled or
  // careless implementation might embed request details into.
  globalThis.fetch = async () => { throw new Error('fetch failed: network unreachable'); };
  try {
    const res = await realFetch(`${base}/discover`);
    const bodyText = await res.text();
    assert.equal(res.status, 500);
    assertNoRawSecrets(bodyText, 'GET /discover error response body');
    assertNoRawSecrets(capturedLogs.join('\n'), 'log output after a thrown discovery error');
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* -------------------------------------------------------------------- /add */

test('POST /add stores the connected league using the already-saved cookies, without echoing them', async () => {
  resetState();
  run(`INSERT INTO app_settings (key, value) VALUES ('espn_s2', ?)`, RAW_S2);
  run(`INSERT INTO app_settings (key, value) VALUES ('swid', ?)`, RAW_SWID_BRACED);

  const res = await realFetch(`${base}/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ league_id: '555444', season: CURRENT_SEASON, name: 'Matching League' })
  });
  const bodyText = await res.text();
  const body = JSON.parse(bodyText);

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assertNoRawSecrets(bodyText, 'POST /add response body');

  const stored = db.prepare(
    `SELECT espn_s2, swid FROM leagues WHERE platform='espn' AND league_id='555444' AND season=?`
  ).get(CURRENT_SEASON);
  assert.equal(stored.espn_s2, RAW_S2);
  assert.equal(stored.swid, RAW_SWID_BRACED);
});

test('POST /add requires a league_id', async () => {
  resetState();
  const res = await realFetch(`${base}/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(res.status, 400);
});
