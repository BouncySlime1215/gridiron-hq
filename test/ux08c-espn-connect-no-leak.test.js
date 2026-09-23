/**
 * UX-08c: POST /espn-connect/cookies must not put a raw exception message in the
 * `error` it sends — EspnConnect.tsx:53 shows a 4xx `error` verbatim.
 *
 * Behavioural, not source-regex: the real router, mounted as in
 * test/espn-connect.test.js, with globalThis.fetch stubbed so the ESPN call
 * rejects with an Error carrying internal detail. Replaces the regex checks
 * that let `"..." + e.message` and a `detail` field through (skeptic mutants
 * A and B, 2026-09-23).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ux08c-espn-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.NFL_SEASON = '2026';
process.env.SCHEDULER_DISABLED = '1';

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
// app_settings is created by claude.js's import-time db.exec() (same as test/espn-connect.test.js).
await import('../server/services/claude.js');
const { default: espnConnectRouter, validateCookies } = await import('../server/routes/espn-connect.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/espn-connect', espnConnectRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/espn-connect`;

run('INSERT INTO users (subject, display_name) VALUES (?,?)', 'ux08c-espn-user', 'Tester');
const USER_ID = row('SELECT last_insert_rowid() AS id').id;
const TOKEN = 'ux08c-espn-token';
run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now','+1 day'))`,
  USER_ID, hashSessionToken(TOKEN));

const realFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = realFetch;
  server.close();
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const LEAKY = 'getaddrinfo ENOTFOUND fan.api.espn.com at server/routes/espn-connect.js:330 (nfl_availability_role_rates)';
const MARKERS = ['ENOTFOUND', 'getaddrinfo', 'espn-connect.js', 'nfl_availability_role_rates'];
const GOOD_S2 = 'AEC%2Fabcdefgh1234567890RealLookingEspnS2TokenValue';
const GOOD_SWID = '{11112222-3333-4444-5555-666677778888}';

const espnRejects = () => { globalThis.fetch = async () => { throw new Error(LEAKY); }; };
const espnStatus = status => { globalThis.fetch = async () => ({ ok: false, status, json: async () => ({}) }); };

async function postCookies() {
  const res = await realFetch(`${base}/cookies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ espn_s2: GOOD_S2, swid: GOOD_SWID })
  });
  return { status: res.status, text: await res.text() };
}

function quietly(fn) {
  const orig = console.error; const logged = [];
  console.error = (...a) => logged.push(a.map(x => (x instanceof Error ? x.message : String(x))).join(' '));
  return fn().then(out => ({ out, logged: logged.join('\n') }), e => { throw e; }).finally(() => { console.error = orig; });
}

test('control (known-nonzero): the stubbed fetch really rejects with the leak markers', async () => {
  espnRejects();
  await assert.rejects(globalThis.fetch('x'), e => MARKERS.every(m => e.message.includes(m)));
});

test('validateCookies() — a rejected ESPN call returns plain copy, detail only in the log', async () => {
  espnRejects();
  const { out, logged } = await quietly(() => validateCookies(GOOD_S2, GOOD_SWID));
  assert.equal(out.ok, false);
  const shipped = JSON.stringify(out);
  for (const m of MARKERS) assert.ok(!shipped.includes(m), `validateCookies result carries "${m}": ${shipped}`);
  assert.equal(out.reason, "Couldn't verify those cookies with ESPN. Try again in a moment.");
  assert.ok(logged.includes('ENOTFOUND'), 'the raw detail still reaches console.error');
});

test('POST /cookies — the JSON the user\'s browser receives carries no exception text', async () => {
  espnRejects();
  const { out } = await quietly(postCookies);
  assert.equal(out.status, 400, `expected the plain 400 path; got ${out.status} ${out.text}`);
  for (const m of MARKERS) assert.ok(!out.text.includes(m), `POST /cookies body carries "${m}": ${out.text}`);
  assert.match(out.text, /Couldn't verify those cookies with ESPN/);
});

test('control: the 401/403/404 and timeout reasons are kept specific, not collapsed', async () => {
  for (const s of [401, 403, 404]) {
    espnStatus(s);
    const r = await validateCookies(GOOD_S2, GOOD_SWID);
    assert.match(r.reason, /ESPN didn't recognise those cookies/, `status ${s}`);
  }
  globalThis.fetch = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  const t = await validateCookies(GOOD_S2, GOOD_SWID);
  assert.match(t.reason, /\(timed out\)/);
});
