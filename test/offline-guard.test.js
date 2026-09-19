import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';

/**
 * What `test/offline-guard.mjs` is actually worth.
 *
 * The guard's promise is a property of the RUN: "no test in this suite can
 * reach another machine, and if one tries, the failure names the host and the
 * file that tried." Replacing `globalThis.fetch` alone does not deliver that,
 * because `globalThis.fetch` is one transport out of several. The tests below
 * exercise the transports the repo actually has on disk:
 *
 *   - `@anthropic-ai/sdk@0.39.0` -> `_shims/node-runtime.mjs` -> `node-fetch@2`
 *     -> `node:https.request`. Never touches `globalThis.fetch`.
 *   - anything on core HTTP (axios, got, superagent, a hand-rolled client).
 *   - a raw socket, which is what undici and `tls.connect` come down to.
 *
 * and the exemption the suite depends on: localhost still works, because
 * several tests boot the real server and talk to it over a real socket.
 *
 * Every "blocked" assertion insists on the guard's OWN message. An ENOTFOUND
 * or an ECONNREFUSED is not this guard working — it is the sandbox happening
 * to have no route, which is exactly the accident this guard exists to stop
 * relying on.
 */

const GUARD = /offline test guard: blocked an external request to/;
const EXTERNAL_HOST = 'api.anthropic.com';

/** Run `open`, expect the guard to have refused it, and never leak a handle. */
function expectBlocked(label, open) {
  let handle = null;
  let thrown = null;
  try { handle = open(); } catch (e) { thrown = e; }
  if (handle && typeof handle === 'object') {
    try { handle.on?.('error', () => {}); } catch { /* not an emitter */ }
    try { handle.destroy?.(); } catch { /* already gone */ }
  }
  assert.ok(thrown, `${label}: nothing was thrown — the call was allowed out of the box`);
  assert.match(thrown.message, GUARD,
    `${label}: refused for the wrong reason (not the guard): ${thrown.message}`);
  assert.match(thrown.message, new RegExp(EXTERNAL_HOST),
    `${label}: the failure does not name the host that was attempted`);
  return thrown;
}

test('the guard blocks the Anthropic SDK, which does not go through globalThis.fetch', async () => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // A real client, built the way server/services/claude.js builds one. The key
  // is deliberately not a real one, and maxRetries is 0 so a RED run does not
  // sit through the SDK's backoff before reporting.
  const client = new Anthropic({ apiKey: 'offline-guard-not-a-real-key', maxRetries: 0, timeout: 5000 });
  let err = null;
  try {
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 8,
      messages: [{ role: 'user', content: 'this request must never leave the box' }],
    });
  } catch (e) { err = e; }

  assert.ok(err, 'the SDK call did not fail — it reached the real API');
  // The SDK wraps a transport failure in APIConnectionError and keeps the
  // original on `cause`, so the guard's message can be one or two levels down.
  const chain = [err.message, err.cause?.message, err.cause?.cause?.message]
    .filter(Boolean).join(' | ');
  assert.match(chain, GUARD,
    `the SDK was not stopped by the guard; it failed with: ${chain}`);
  assert.match(chain, new RegExp(EXTERNAL_HOST), `the failure does not name ${EXTERNAL_HOST}`);
});

test('the guard blocks node-fetch itself — the module the SDK binds as its fetch', async () => {
  const { default: nodeFetch } = await import('node-fetch');
  await assert.rejects(() => nodeFetch(`https://${EXTERNAL_HOST}/v1/messages`, { method: 'POST' }), GUARD);
});

test('the guard blocks node:https.request and node:http.request, and names the host', () => {
  expectBlocked('https.request(url)', () => https.request(`https://${EXTERNAL_HOST}/v1/messages`));
  expectBlocked('https.request(options)', () => https.request({ hostname: EXTERNAL_HOST, path: '/v1/messages', method: 'POST' }));
  expectBlocked('https.get(url)', () => https.get(`https://${EXTERNAL_HOST}/v1/messages`));
  expectBlocked('http.request(options)', () => http.request({ host: EXTERNAL_HOST, path: '/' }));
});

test('the guard blocks a raw socket to another machine — the backstop under every client', () => {
  expectBlocked('net.connect(options)', () => net.connect({ host: EXTERNAL_HOST, port: 443 }));
  expectBlocked('net.connect(port, host)', () => net.connect(443, EXTERNAL_HOST));
});

test('a blocked call names the test file that attempted it', () => {
  const err = expectBlocked('https.request', () => https.request(`https://${EXTERNAL_HOST}/v1/messages`));
  assert.match(err.message, /offline-guard\.test\.js/,
    `the failure does not say which test attempted it: ${err.message}`);
});

test('globalThis.fetch to an external host is still blocked, and still names the host', () => {
  expectBlocked('globalThis.fetch', () => { fetch(`https://${EXTERNAL_HOST}/v1/messages`); });
});

test('localhost is still reachable — over fetch, over http.request, and over a raw socket', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('local'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const viaFetch = await fetch(`http://127.0.0.1:${port}/ping`);
    assert.equal(await viaFetch.text(), 'local');

    const viaHttp = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/ping' }, res => {
        let body = ''; res.setEncoding('utf8');
        res.on('data', c => { body += c; }); res.on('end', () => resolve(body));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(viaHttp, 'local');

    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.destroy();

    // `localhost` by name, and a unix-socket-shaped call with no host at all,
    // must not be caught either.
    const viaName = await fetch(`http://localhost:${port}/ping`);
    assert.equal(await viaName.text(), 'local');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

/* ------------------------------------------------ ambient credentials
 * The guard makes the network hermetic. It did not make the ENVIRONMENT
 * hermetic, and that gap cost a session.
 *
 * Measured, not supposed: on a box carrying this project's real keys,
 * `test/model-integrity.test.js` fails 3 of 94 and
 * `test/nfl-prospective-collection.test.js` fails 3 of 9. Strip the keys from
 * the same commit and both files pass 94/94 and 9/9. The suite's result was a
 * property of which machine ran it.
 *
 * Two of those were tests asserting a not-configured path —
 * `startAiBlindReplay()` must throw "No Claude API key configured",
 * `evidenceDaemonStatus().odds_feed` must be false — which are true only where
 * nobody added the key. The third was worse: once `startAiBlindReplay()` stops
 * throwing it runs, inserting a row and forking a detached worker that
 * reconstructs ensembles against the same SQLite file, which corrupts the
 * unrelated test 14 cases later ("historical ensemble weights…"). That one
 * passes in isolation and fails in file order — the signature of state
 * escaping a test, not of a bug in the test that reports it.
 *
 * So the credentials are cleared here, at the same seam and for the same
 * reason as the two research-export paths above: a suite whose verdict depends
 * on the box it runs on cannot be used as a baseline, and a "14 known
 * failures" number is worth nothing if it is really "14 on that laptop".
 *
 * A test that wants a key sets its own, after this module has run —
 * `nfl-news-events.test.js` and `page-explain.test.js` both already do.
 * Clearing here never fights them; it only removes what the box supplied.
 */
test('the guard clears ambient provider credentials, whatever the box supplied', async () => {
  const { PROVIDER_CREDENTIAL_ENV } = await import('./offline-guard.mjs');
  assert.ok(PROVIDER_CREDENTIAL_ENV.length > 0, 'the guard names no credentials at all');
  for (const name of PROVIDER_CREDENTIAL_ENV) {
    assert.equal(process.env[name], undefined,
      `${name} is still visible to the test run — this box does not run the suite the same way an empty one does`);
  }
});

/**
 * The assertion above passes for free on a box that never had the keys, which
 * is exactly the box where the bug hid. This one proves the mechanism instead
 * of the ambient state: a child process is given real-looking credentials and
 * must not be able to see them once the guard has loaded.
 */
test('a box that really has the keys still starts the run without them', async () => {
  const { PROVIDER_CREDENTIAL_ENV } = await import('./offline-guard.mjs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');

  const planted = Object.fromEntries(PROVIDER_CREDENTIAL_ENV.map(n => [n, `planted-${n}`]));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', './test/offline-guard.mjs', '-e',
      'console.log(JSON.stringify(Object.fromEntries(' +
      `${JSON.stringify(PROVIDER_CREDENTIAL_ENV)}.map(n => [n, process.env[n] ?? null]))))`],
    { cwd: process.cwd(), env: { ...process.env, ...planted } });

  const seen = JSON.parse(stdout);
  const leaked = Object.entries(seen).filter(([, v]) => v !== null).map(([k]) => k);
  assert.deepEqual(leaked, [],
    `the guard let real credentials through to the run: ${leaked.join(', ')}`);
});

/**
 * `LAUNCHER_KEY_FILE` is a path, not a secret, and `test/launcher.test.js:39`
 * sets it itself. Clearing it would break a passing test for no gain, so the
 * list is deliberately credentials only — pinned here so a later edit that
 * sweeps in every `*_KEY*` name fails loudly instead of quietly.
 */
test('the cleared list is credentials only, not every name that looks like one', async () => {
  const { PROVIDER_CREDENTIAL_ENV } = await import('./offline-guard.mjs');
  assert.ok(!PROVIDER_CREDENTIAL_ENV.includes('LAUNCHER_KEY_FILE'),
    'LAUNCHER_KEY_FILE is a file path that test/launcher.test.js sets for itself');
  assert.ok(!PROVIDER_CREDENTIAL_ENV.includes('GRIDIRON_DB_PATH'),
    'GRIDIRON_DB_PATH is how the suite points itself at a scratch database');
});
