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
