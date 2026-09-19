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

/**
 * Same discipline again, for the environment itself.
 *
 * The network guard above makes it impossible to REACH a provider. It does
 * nothing about code that only asks whether a provider is CONFIGURED, and this
 * repo asks that constantly: every feed gates on `Boolean(process.env.X)`
 * before it builds a request, and `getApiKey()` reads
 * GRIDIRON_ANTHROPIC_API_KEY, then ANTHROPIC_API_KEY, then app_settings. So a
 * box with keys in it ran a different suite from a box without, on the same
 * commit — six tests' worth, measured both ways before this was written.
 *
 * Two of those tests assert a not-configured path directly. The third is
 * collateral: `startAiBlindReplay()` throws when there is no key, and *runs*
 * when there is one — forking a detached worker that writes to the same
 * database the suite is reading. A credential in the environment was enough to
 * start real background work in the middle of a test run.
 *
 * Clearing is the right verb, not `??=`. The two lookups above are redirected
 * to a path that cannot exist because the code needs *a* value; a credential
 * needs to be absent, because absent is what every one of these call sites
 * tests for. A placeholder would read as configured and be worse than the
 * real key.
 *
 * This runs at `--import` time, before any test module is evaluated, so a test
 * that wants a key can still set one and be the only thing that decided it —
 * `nfl-news-events.test.js:21` and `page-explain.test.js` already work this
 * way, and both keep working, because this removes only what the box supplied.
 *
 * KNOWN LIMIT, stated rather than implied: this closes the ENVIRONMENT, not
 * every way the app can find a key. `getApiKey()` (server/services/claude.js)
 * reads GRIDIRON_ANTHROPIC_API_KEY, then ANTHROPIC_API_KEY, then
 * `app_settings.anthropic_api_key` IN THE DATABASE. Clearing the environment
 * does nothing about that third source. Under `npm test` it cannot matter —
 * the script points GRIDIRON_DB_PATH at a fresh temp file with no such row.
 * Under `npm run test:real` it can: that script sets no GRIDIRON_DB_PATH, so it
 * opens the real server/data.sqlite, where a key pasted into the app's Settings
 * screen lives. On such a box `test:real` still runs as "configured" and this
 * guard's promise — that a box with keys runs the same suite as a box without —
 * holds for two of the three sources, not three.
 *
 * The list is credentials, by hand, from
 * `grep -rhoE 'process\.env\.[A-Z0-9_]*(KEY|TOKEN|SECRET)[A-Z0-9_]*' server/ scripts/`,
 * minus LAUNCHER_KEY_FILE, which is a path that test/launcher.test.js sets for
 * itself. It is not a `*_KEY`-shaped regex on purpose: a pattern would sweep up
 * the next path or feature flag someone names that way and break a passing test
 * from a distance.
 */
export const PROVIDER_CREDENTIAL_ENV = Object.freeze([
  'AI_GATEWAY_API_KEY',
  'ANTHROPIC_API_KEY',
  // Not found by the grep below, because no code in this repo reads it — the
  // SDK does, straight from the environment (`@anthropic-ai/sdk/index.mjs`
  // reads ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN). A box with it set would
  // hand the client a live credential this list had not cleared.
  'ANTHROPIC_AUTH_TOKEN',
  'CFBD_API_KEY',
  'GRIDIRON_ANTHROPIC_API_KEY',
  'ODDS_API_KEY',
  'PARLAY_API_KEY',
  'PFF_API_TOKEN',
  'SPORTSGAMEODDS_API_KEY',
  'TWITTERAPI_IO_KEY',
]);

for (const name of PROVIDER_CREDENTIAL_ENV) delete process.env[name];

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
