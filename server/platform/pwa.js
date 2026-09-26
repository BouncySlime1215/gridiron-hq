/**
 * MOBILE-PWA (plan item 59): the installable app shell, so the app can be pinned to a phone's
 * home screen and open to its own frame when the network is gone.
 *
 * Flag GRIDIRON_PWA ("on" to serve it; anything else is off). Off, installed mode serves the
 * same index.html bytes as before and /manifest.webmanifest is a 404. /sw.js still answers when
 * off, with a worker that deletes this app's caches and unregisters itself: a phone that
 * installed the shell while the flag was on is cleaned up on its next visit, not stranded on
 * an old build.
 *
 * What the worker may keep is the SHELL only: "/" (index.html, which is static and carries no
 * user data), the content-hashed /assets/* bundles, /icons/* and the manifest. It never sees
 * /api/*, auth, the draft bookmarklet, a non-GET or another origin: those requests are not
 * intercepted at all, so no league data, cookie-bearing response or key can land in a cache.
 * Serving last-good DATA offline is item 53's job, not this one.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

export const PWA_FLAG = 'GRIDIRON_PWA';
export const CACHE_PREFIX = 'gridiron-shell-';

export function pwaEnabled(env = process.env) {
  return env[PWA_FLAG] === 'on';
}

// Colours are tokens.css's light/dark --c-bg and --c-accent, so the splash and status bar
// match the page the app opens to.
const BG_LIGHT = '#f6f7f9';
const BG_DARK = '#0a0b0f';
const ACCENT = '#4b5bff';

export const ICONS = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
];
export const APPLE_TOUCH_ICON = '/icons/apple-touch-icon-180.png';

export function buildManifest() {
  return {
    id: '/',
    name: 'Gridiron HQ',
    short_name: 'Gridiron',
    description: 'Your fantasy football league: today, trades, your team.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: BG_LIGHT,
    theme_color: ACCENT,
    prefer_related_applications: false,
    icons: ICONS
  };
}

/** The paths the worker may cache and answer from. Everything else goes straight to the network. */
export const SHELL_URLS = ['/', '/manifest.webmanifest', ...ICONS.map((i) => i.src), APPLE_TOUCH_ICON];

/**
 * The service worker. `version` names the cache, so a new build installs a fresh cache and
 * the activate step deletes the old one.
 */
export function serviceWorkerSource({ enabled, version }) {
  if (!enabled) {
    return `// Gridiron HQ app shell: switched off (${PWA_FLAG}). Clears this app's caches and unregisters.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(${JSON.stringify(CACHE_PREFIX)})).map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
  );
});
`;
  }
  return `// Gridiron HQ app shell (${PWA_FLAG}=on). Caches the shell only; never /api or any data.
const CACHE = ${JSON.stringify(CACHE_PREFIX + version)};
const PREFIX = ${JSON.stringify(CACHE_PREFIX)};
const SHELL = ${JSON.stringify(SHELL_URLS)};

function isShell(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  if (p === '/api' || p.startsWith('/api/')) return false;
  return SHELL.includes(p) || p.startsWith('/assets/') || p.startsWith('/icons/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // Network first, so a signed-in page is always the live one; offline, the cached shell.
    event.respondWith(fetch(req).catch(() => caches.match('/').then((hit) => hit || Response.error())));
    return;
  }
  if (!isShell(url)) return;
  // Hashed bundles and icons never change under the same name: cache first.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(req, copy)));
      }
      return res;
    }))
  );
});
`;
}

/** The head tags that make the page installable. Only added when the flag is on. */
export function pwaHeadTags() {
  return [
    '<link rel="manifest" href="/manifest.webmanifest" />',
    `<meta name="theme-color" content="${BG_LIGHT}" media="(prefers-color-scheme: light)" />`,
    `<meta name="theme-color" content="${BG_DARK}" media="(prefers-color-scheme: dark)" />`,
    '<meta name="mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-title" content="Gridiron" />',
    `<link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON}" />`
  ].join('\n    ');
}

/** index.html with the tags added before </head>. Idempotent. Throws if there is no </head>. */
export function injectPwaTags(html) {
  if (html.includes('rel="manifest"')) return html;
  const at = html.indexOf('</head>');
  if (at < 0) throw new Error('pwa: index.html has no </head> to add the manifest link to');
  return `${html.slice(0, at)}  ${pwaHeadTags()}\n  ${html.slice(at)}`;
}

/** The shell's cache name: a hash of the built index.html, which names every hashed bundle. */
export function shellVersion(html) {
  return crypto.createHash('sha256').update(html).digest('hex').slice(0, 12);
}

/**
 * Routes for installed mode: /manifest.webmanifest, /sw.js and the index.html sender the SPA
 * fallback uses. `env` is read per request, so a restart is not needed to flip the flag in a
 * test; in the app it comes from the process environment.
 */
export function createPwa({ distDir, env = process.env }) {
  const indexPath = path.join(distDir, 'index.html');
  // Read per request: index.html is small, and a rebuild while the server runs must not leave a
  // stale shell (or a stale cache name) behind.
  const readIndex = () => fs.readFileSync(indexPath, 'utf8');

  const router = express.Router();
  router.get('/manifest.webmanifest', (req, res) => {
    if (!pwaEnabled(env)) return res.status(404).json({ error: 'not found' });
    res.set('Cache-Control', 'no-cache');
    res.type('application/manifest+json').send(JSON.stringify(buildManifest()));
  });
  router.get('/sw.js', (req, res) => {
    const enabled = pwaEnabled(env);
    const version = enabled ? shellVersion(readIndex()) : 'off';
    // Always revalidated, so a new build or the off switch reaches an installed phone.
    res.set('Cache-Control', 'no-cache');
    res.set('Service-Worker-Allowed', '/');
    res.type('application/javascript').send(serviceWorkerSource({ enabled, version }));
  });

  function sendIndex(req, res) {
    if (!pwaEnabled(env)) return res.sendFile(indexPath);
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(injectPwaTags(readIndex()));
  }

  return { router, sendIndex };
}
