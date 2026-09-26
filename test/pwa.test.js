/**
 * MOBILE-PWA (plan item 59), pre-registered bar B1-B8 (PR body). The service worker is run for
 * real in a vm sandbox with a fake Cache Storage and network, so "never caches data" is a
 * behaviour checked request by request, not a grep.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import express from 'express';
import {
  createPwa, buildManifest, serviceWorkerSource, injectPwaTags, pwaEnabled, shellVersion,
  SHELL_URLS, CACHE_PREFIX, APPLE_TOUCH_ICON
} from '../server/platform/pwa.js';
import { ICONS as ICON_SPECS, renderIcon, ICON_DIR } from '../scripts/pwa/make-icons.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ORIGIN = 'http://127.0.0.1:5177';
const INDEX = '<!doctype html>\n<html><head>\n<title>Gridiron HQ</title>\n</head><body><div id="root"></div></body></html>\n';

// --- a service-worker sandbox -------------------------------------------------------------

function makeResponse(body, { status = 200, type = 'basic' } = {}) {
  return {
    body, status, ok: status >= 200 && status < 300, type,
    clone() { return makeResponse(body, { status, type }); }
  };
}

function loadWorker(source, { online = true, existingCaches = [] } = {}) {
  const store = new Map(existingCaches.map((k) => [k, new Map()]));
  const network = [];
  const keyOf = (r) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).pathname;
  const cacheObj = (name) => ({
    async addAll(reqs) { for (const r of reqs) { network.push(keyOf(r)); store.get(name).set(keyOf(r), makeResponse(`net:${keyOf(r)}`)); } },
    async put(req, res) { store.get(name).set(keyOf(req), res); },
    async match(req) { return store.get(name).get(keyOf(req)); }
  });
  const caches = {
    async open(name) { if (!store.has(name)) store.set(name, new Map()); return cacheObj(name); },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
    async match(req) { for (const m of store.values()) { const hit = m.get(keyOf(req)); if (hit) return hit; } return undefined; }
  };
  const listeners = {};
  const state = { unregistered: false, claimed: false, online };
  const self = {
    location: new URL(ORIGIN),
    addEventListener(type, fn) { listeners[type] = fn; },
    skipWaiting() {},
    registration: { async unregister() { state.unregistered = true; return true; } },
    clients: { async claim() { state.claimed = true; } }
  };
  async function fetchImpl(req) {
    const p = keyOf(req);
    network.push(p);
    if (!state.online) throw new TypeError('Failed to fetch');
    return makeResponse(`net:${p}`);
  }
  class Request { constructor(url, init = {}) { this.url = new URL(url, ORIGIN).href; this.method = init.method || 'GET'; this.mode = init.mode || 'cors'; } }
  const sandbox = { self, caches, fetch: fetchImpl, URL, Request, Response: { error: () => makeResponse(null, { status: 0, type: 'error' }) }, Promise, console };
  vm.runInNewContext(source, sandbox);

  async function lifecycle(type) {
    const waits = [];
    listeners[type]?.({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  }
  async function request(url, { method = 'GET', mode = 'cors' } = {}) {
    const req = new Request(url, { method, mode });
    let responded = null;
    const waits = [];
    listeners.fetch?.({ request: req, respondWith: (p) => { responded = p; }, waitUntil: (p) => waits.push(p) });
    if (!responded) return { intercepted: false };
    const res = await responded;
    await Promise.all(waits);
    return { intercepted: true, res };
  }
  const cachedPaths = () => [...store.values()].flatMap((m) => [...m.keys()]);
  return { lifecycle, request, store, network, state, cachedPaths };
}

// --- a served app over a temp dist -------------------------------------------------------

async function serve(env) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), INDEX);
  const pwa = createPwa({ distDir: dist, env });
  const app = express();
  app.use(pwa.router);
  app.get(/^(?!\/api\/).*/, pwa.sendIndex);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

// --- B1 flag off changes nothing --------------------------------------------------------

test('B1 flag off: index.html byte-equal, no manifest, /sw.js is the off switch', async () => {
  assert.equal(pwaEnabled({}), false);
  assert.equal(pwaEnabled({ GRIDIRON_PWA: '1' }), false, 'only "on" switches it on');
  assert.equal(pwaEnabled({ GRIDIRON_PWA: 'on' }), true);
  const app = await serve({});
  try {
    const index = await (await fetch(`${app.base}/trades`)).text();
    assert.equal(index, INDEX);
    assert.equal((await fetch(`${app.base}/manifest.webmanifest`)).status, 404);
    const sw = await fetch(`${app.base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.equal(sw.headers.get('cache-control'), 'no-cache');
    const src = await sw.text();
    assert.match(src, /unregister\(\)/);
    assert.doesNotMatch(src, /\.put\(|addAll\(|respondWith/);
  } finally { await app.close(); }
});

// --- B2 installable --------------------------------------------------------------------

function pngSize(buf) {
  assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test('B2 installable: manifest fields, icon files exist at their declared sizes', async () => {
  const m = buildManifest();
  for (const k of ['id', 'name', 'short_name', 'start_url', 'scope']) assert.ok(m[k], k);
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.equal(m.prefer_related_applications, false);
  assert.ok(m.short_name.length <= 12, 'short_name fits under a home-screen icon');
  const any = m.icons.filter((i) => i.purpose === 'any').map((i) => i.sizes);
  assert.ok(any.includes('192x192') && any.includes('512x512'));
  assert.ok(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
  for (const icon of [...m.icons, { src: APPLE_TOUCH_ICON, sizes: '180x180' }]) {
    const file = path.join(ROOT, 'client', 'public', icon.src);
    assert.ok(fs.existsSync(file), `${icon.src} exists`);
    assert.deepEqual(pngSize(fs.readFileSync(file)).join('x'), icon.sizes);
  }
  const app = await serve({ GRIDIRON_PWA: 'on' });
  try {
    const res = await fetch(`${app.base}/manifest.webmanifest`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
    assert.deepEqual(await res.json(), m);
    const index = await (await fetch(`${app.base}/`)).text();
    assert.match(index, /<link rel="manifest" href="\/manifest.webmanifest" \/>/);
    assert.match(index, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon-180.png" \/>/);
    assert.ok(index.indexOf('rel="manifest"') < index.indexOf('</head>'));
  } finally { await app.close(); }
});

test('B2 committed icons are the generator\'s current drawing', () => {
  for (const spec of ICON_SPECS) {
    assert.ok(fs.readFileSync(path.join(ICON_DIR, spec.file)).equals(renderIcon(spec)), `${spec.file} is stale: node scripts/pwa/make-icons.mjs`);
  }
});

// --- B3 no data is ever cached ---------------------------------------------------------

test('B3 the worker never intercepts or caches /api, auth, bookmarklet, non-GET or cross-origin', async () => {
  const w = loadWorker(serviceWorkerSource({ enabled: true, version: 'v1' }));
  await w.lifecycle('install');
  await w.lifecycle('activate');
  const untouched = [
    ['/api/warroom/plans'], ['/api/auth/session'], ['/api/coach/chat'], ['/api'],
    ['/api/players?id=160', { mode: 'navigate' }],
    ['/draft-capture.js'], ['/some/other.json'],
    ['/assets/app.js', { method: 'POST' }],
    ['https://fonts.googleapis.com/css2?family=Archivo'],
    ['https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl']
  ];
  for (const [url, opts] of untouched) {
    const r = await w.request(url, opts);
    assert.equal(r.intercepted, false, `${url} ${JSON.stringify(opts || {})} must not be intercepted`);
  }
  await w.request('/assets/index-abc123.js');
  await w.request('/icons/icon-192.png');
  await w.request('/trades', { mode: 'navigate' });
  for (const p of w.cachedPaths()) {
    assert.ok(SHELL_URLS.includes(p) || p.startsWith('/assets/') || p.startsWith('/icons/'), `cached non-shell path ${p}`);
    assert.ok(!p.startsWith('/api'), p);
  }
  assert.ok(w.cachedPaths().includes('/assets/index-abc123.js'));
  assert.ok(!w.cachedPaths().includes('/trades'), 'a navigation response is not stored');
  assert.ok(!SHELL_URLS.some((u) => u.startsWith('/api')));
});

test('B3 an error or opaque response is not cached', async () => {
  const src = serviceWorkerSource({ enabled: true, version: 'v1' });
  assert.match(src, /res\.ok && res\.type === 'basic'/);
  assert.doesNotMatch(src, /document\.cookie|localStorage|Authorization|indexedDB/);
});

// --- B4 offline shell ------------------------------------------------------------------

test('B4 offline: a navigation gets the cached shell; online it goes to the network', async () => {
  const w = loadWorker(serviceWorkerSource({ enabled: true, version: 'v1' }));
  await w.lifecycle('install');
  const online = await w.request('/my-team', { mode: 'navigate' });
  assert.equal(online.res.body, 'net:/my-team');
  w.state.online = false;
  const offline = await w.request('/my-team', { mode: 'navigate' });
  assert.equal(offline.res.body, 'net:/', 'the shell index.html cached at install');
  const asset = await w.request('/icons/icon-512.png');
  assert.equal(asset.res.body, 'net:/icons/icon-512.png');
});

// --- B5 nothing private in any PWA byte ------------------------------------------------

test('B5 manifest, worker and head tags carry no secret, id or league data', () => {
  const bytes = [
    JSON.stringify(buildManifest()),
    serviceWorkerSource({ enabled: true, version: 'v1' }),
    serviceWorkerSource({ enabled: false, version: 'off' }),
    injectPwaTags(INDEX)
  ].join('\n');
  assert.doesNotMatch(bytes, /sk-ant|api[_-]?key|espn_s2|SWID|token|password|secret/i);
  assert.doesNotMatch(bytes, /roster|league\s*\d|\bid=\d/i);
});

// --- B6 the off switch cleans up an installed phone ------------------------------------

test('B6 off worker deletes only this app\'s caches and unregisters', async () => {
  const w = loadWorker(serviceWorkerSource({ enabled: false, version: 'off' }), {
    existingCaches: [`${CACHE_PREFIX}old1`, `${CACHE_PREFIX}old2`, 'someone-else']
  });
  await w.lifecycle('install');
  await w.lifecycle('activate');
  assert.deepEqual([...w.store.keys()], ['someone-else']);
  assert.equal(w.state.unregistered, true);
  assert.equal((await w.request('/', { mode: 'navigate' })).intercepted, false);
});

// --- B7 a new build replaces the old cache --------------------------------------------

test('B7 a new build gets a new cache name and the old one is deleted', async () => {
  const v1 = shellVersion(INDEX);
  const v2 = shellVersion(INDEX.replace('Gridiron HQ', 'Gridiron HQ '));
  assert.notEqual(v1, v2);
  const w = loadWorker(serviceWorkerSource({ enabled: true, version: v2 }), { existingCaches: [CACHE_PREFIX + v1, 'someone-else'] });
  await w.lifecycle('install');
  await w.lifecycle('activate');
  assert.deepEqual([...w.store.keys()].sort(), [CACHE_PREFIX + v2, 'someone-else'].sort());
  assert.equal(w.state.claimed, true);
  const app = await serve({ GRIDIRON_PWA: 'on' });
  try {
    const src = await (await fetch(`${app.base}/sw.js`)).text();
    assert.ok(src.includes(JSON.stringify(CACHE_PREFIX + v1)), 'served worker names the current build');
  } finally { await app.close(); }
});

// --- B8 wiring and no dev text ---------------------------------------------------------

test('B8 injection is idempotent, fails loudly without </head>, and is wired in', () => {
  const once = injectPwaTags(INDEX);
  assert.equal(injectPwaTags(once), once);
  assert.throws(() => injectPwaTags('<html><body></body></html>'), /no <\/head>/);
  const server = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert.match(server, /app\.use\(pwa\.router\)/);
  assert.match(server, /app\.get\(\/\^\(\?!\\\/api\\\/\)\.\*\/, pwa\.sendIndex\)/);
  const main = fs.readFileSync(path.join(ROOT, 'client', 'src', 'main.tsx'), 'utf8');
  assert.match(main, /initPwa\(\);/);
  const client = fs.readFileSync(path.join(ROOT, 'client', 'src', 'pwa.ts'), 'utf8');
  assert.ok(client.includes(`'${CACHE_PREFIX}'`), 'client clears the same cache prefix the worker uses');
  const m = buildManifest();
  for (const s of [m.name, m.short_name, m.description]) assert.doesNotMatch(s, /GRIDIRON_|\.js|_/);
});
