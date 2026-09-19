/**
 * An enforced external-network guard for the test suite.
 *
 * Codex correction C06 asks for "an enforced external-network guard with
 * explicit localhost exceptions." The CI workflow previously asserted that no
 * network was needed "by construction of the test suite itself" — a claim
 * about the tests rather than a property of the run. A test that quietly
 * reached a provider would have passed, and would have kept passing until the
 * day it did not, or until it cost money.
 *
 * This makes the claim enforceable: any request to a host other than the local
 * machine throws, naming the host and the test file that attempted it, so a
 * leak is a loud failure rather than a silent dependency. Localhost is exempted
 * explicitly, because several tests boot the real server and talk to it over a
 * real socket, which is the whole point of an integration test.
 *
 * WHY THERE ARE THREE LAYERS, not just `globalThis.fetch`
 * ------------------------------------------------------
 * Replacing `globalThis.fetch` only covers callers that go through Node's
 * built-in (undici) fetch. It does not cover the Anthropic SDK, and that was a
 * real hole rather than a theoretical one: `@anthropic-ai/sdk@0.39.0` resolves
 * its HTTP client through `_shims/auto/runtime`, which under Node's `"node"`
 * export condition is `_shims/node-runtime.mjs`, and that file does
 * `import * as nf from 'node-fetch'` and hands `nf.default` to the client
 * (`core.mjs:133`, `this.fetch = overriddenFetch ?? fetch`). `node-fetch@2`
 * is not a fetch polyfill over undici — it calls
 * `(options.protocol === 'https:' ? https : http).request(options)`
 * (`node-fetch/lib/index.js:1452`) straight into `node:http`/`node:https`.
 * `globalThis.fetch` is never consulted, so the guard never saw the call.
 *
 * So the guard blocks at three seams, outermost first, because the outer ones
 * can say more about what was attempted:
 *
 *   1. `globalThis.fetch`  — undici; the original guard, kept as-is.
 *   2. `node:http` / `node:https` `request`/`get` — every library built on
 *      core HTTP: node-fetch (and therefore the Anthropic SDK), axios, got,
 *      superagent, request. This is the layer that closes the SDK hole.
 *   3. `net.Socket.prototype.connect` — the backstop. `tls.connect` and
 *      `net.connect` both end up here, and so does undici's own connector, so
 *      a caller that bypasses both layers above still cannot open a socket to
 *      another machine.
 *
 * The seam deliberately is NOT "pass a failing `fetch` into the Anthropic
 * client at construction": that would special-case one library in one call
 * site, leave every other transport open, and put test-only wiring into
 * `server/services/claude.js`. The guard's job is to make the *run* hermetic,
 * not to make two known test files quiet.
 *
 * Loaded via NODE_OPTIONS="--import ./test/offline-guard.mjs" so it applies to
 * the test runner and every worker and child process beneath it, rather than
 * depending on each test file remembering to install it.
 *
 * Not covered, stated rather than implied: raw UDP (`node:dgram`), and a
 * request deliberately sent to a proxy listening on localhost (the socket is
 * genuinely local; layer 2 still names the real target host for anything that
 * goes through `http.request`).
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Same discipline for on-disk research exports as for the network: no test
// reads the real `server/data/research/market-correction-lookup.json` unless
// it explicitly points at a file of its own. 1,278 of that export's 3,044
// real-game keys collide with the synthetic ensemble fixture's key space, so
// without this every fixture-based ensemble test would silently measure real
// research values mixed into a synthetic league. `??=` so an explicit setting
// from outside the suite still wins.
process.env.GRIDIRON_MARKET_CORRECTION_LOOKUP ??= '/nonexistent/market-correction-lookup.json';
// Same isolation for the TeamRankings power-rating lookup
// (`server/services/nfl-teamrankings-lookup.js`): the real export's keys are
// real team codes across real seasons and would otherwise collide with the
// synthetic ensemble fixture's key space in any fixture-based test.
process.env.GRIDIRON_TEAMRANKINGS_LOOKUP ??= '/nonexistent/teamrankings-lookup.json';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * `input` is whatever a transport thinks the host is: a hostname, an IP, a
 * bracketed IPv6 literal, an IPv4-mapped IPv6 address, or nothing at all.
 * Nothing at all means there is no other machine to reach — a unix socket, or
 * an `http.request()` with no host, which Node itself defaults to localhost —
 * so it is allowed.
 */
function isLocalHost(input) {
  if (input === undefined || input === null || input === '') return true;
  let host = String(input).trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.startsWith('::ffff:')) host = host.slice(7);
  if (LOCAL_HOSTS.has(host)) return true;
  // The whole 127.0.0.0/8 loopback block, and RFC 6761's `.localhost` names.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return false;
}

/**
 * Which test file attempted the call. Node's test runner runs each file in its
 * own child process with the file as `argv[1]`, so this is exact under the
 * suite; under a bare `node script.mjs` it names that script instead, which is
 * still the thing to go and look at.
 */
function attemptedBy() {
  const entry = process.argv[1];
  if (!entry) return 'this process';
  return entry.startsWith(process.cwd() + '/') ? entry.slice(process.cwd().length + 1) : entry;
}

function blocked(host, detail, layer) {
  return new Error(
    `offline test guard: blocked an external request to ${host} (${detail}) ` +
    `via ${layer}, attempted by ${attemptedBy()}. ` +
    'The test suite must run with no network, no provider credentials and no paid API calls. ' +
    'Mock the client, or point the test at a local fixture server.');
}

// ---------------------------------------------------------------- layer 1
// globalThis.fetch (undici). Unchanged in behaviour from the original guard:
// it throws synchronously, and the detail string still leads with the host.
const originalFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, options) {
  let url;
  try {
    url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  } catch {
    // Not a parseable absolute URL; there is no host to reach, so nothing to guard.
    return originalFetch.call(this, input, options);
  }
  if (!isLocalHost(url.hostname)) {
    throw blocked(url.hostname, `${url.protocol}//${url.host}${url.pathname}`, 'globalThis.fetch');
  }
  return originalFetch.call(this, input, options);
};

// ---------------------------------------------------------------- layer 2
// node:http / node:https. `http.request(url[, options][, cb])` and
// `http.request(options[, cb])` are both supported by Node, so both shapes
// have to be read here. `get` is a separate export that calls Node's internal
// `request`, not the exported one, so it needs its own wrapper.
function targetOf(args) {
  let fromUrl = null;
  let options = null;
  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    try { fromUrl = new URL(String(args[0])); } catch { fromUrl = null; }
    if (args[1] && typeof args[1] === 'object') options = args[1];
  } else if (args[0] && typeof args[0] === 'object') {
    options = args[0];
  }
  // A unix-domain socket has no host to reach.
  if (options?.socketPath) return { host: null, detail: `unix:${options.socketPath}` };
  let host = options?.hostname ?? options?.host ?? null;
  if (host == null && fromUrl) host = fromUrl.hostname;
  // `options.host` may carry a port ("example.com:443"); `hostname` never does.
  if (typeof host === 'string' && options?.hostname == null) {
    const m = /^(.+):(\d+)$/.exec(host);
    if (m && !host.includes('::')) host = m[1];
  }
  const path = options?.path ?? fromUrl?.pathname ?? '';
  const detail = fromUrl ? `${fromUrl.protocol}//${fromUrl.host}${fromUrl.pathname}` : `${host ?? ''}${path}`;
  return { host, detail };
}

for (const [mod, scheme] of [[http, 'node:http'], [https, 'node:https']]) {
  for (const name of ['request', 'get']) {
    const original = mod[name];
    if (typeof original !== 'function') continue;
    mod[name] = function guardedHttp(...args) {
      const { host, detail } = targetOf(args);
      if (!isLocalHost(host)) throw blocked(host, detail, `${scheme}.${name}`);
      return original.apply(this, args);
    };
  }
}

// ---------------------------------------------------------------- layer 3
// net.Socket.prototype.connect — the backstop. `net.connect`,
// `net.createConnection`, `tls.connect` (TLSSocket extends net.Socket and does
// not override connect) and undici's connector all arrive here, so nothing can
// open a socket to another machine without passing this check. Inbound
// connections to a server the suite booted never call `connect`, and a unix
// socket has no host, so neither is affected.
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let host = null;
  let detail = '';
  // `net.connect()` / `net.createConnection()` do not forward their arguments
  // as written: they run them through Node's internal `normalizeArgs()` and
  // call `socket.connect([options, callback])` with that ARRAY as the single
  // argument (a symbol on the array tells `connect` it is pre-normalised).
  // Missing this is how a first cut of this guard passed every other case and
  // still let `net.connect({ host, port })` straight out.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') {
    if (first.path) { host = null; detail = `unix:${first.path}`; }
    else { host = first.host ?? null; detail = `${first.host ?? ''}:${first.port ?? ''}`; }
  } else if (typeof first === 'number') {
    // connect(port[, host][, listener])
    host = typeof args[1] === 'string' ? args[1] : null;
    detail = `${host ?? 'localhost'}:${first}`;
  } else if (typeof first === 'string') {
    // connect(path[, listener]) — a unix socket.
    host = null;
    detail = `unix:${first}`;
  }
  if (!isLocalHost(host)) throw blocked(host, detail, 'net.Socket.connect');
  return originalConnect.apply(this, args);
};
