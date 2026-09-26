# MOBILE-PWA — pre-registration (2026-09-26)

Scope: Batch D reserve item 59 (Nick, 2026-09-25): "installable app shell (manifest, icons,
offline shell) so Nick can pin it on his phone; no data caching of secrets." This record is
written before the code.

## What changes

- `server/platform/pwa.js`: the manifest, the service worker source, the head tags, and the
  installed-mode routes (`/manifest.webmanifest`, `/sw.js`, index.html sender).
- `server/index.js`: installed mode mounts those routes; the SPA fallback sends index.html
  through `pwa.sendIndex` (byte-equal to the built file with the flag off).
- `client/src/pwa.ts` + one call in `main.tsx`: register `/sw.js` when the page carries the
  manifest link (flag on); unregister and clear this app's shell caches when it does not.
- `scripts/pwa/make-icons.mjs` and `client/public/icons/*.png`: four deterministic icons.
- Flag `GRIDIRON_PWA`, "on" only. Off by default. No served number, no plans.json field.

## Metric and pass bar (all must hold; any one failing fails the unit)

- **B1 off changes nothing.** Flag off: index.html byte-equal to the build; manifest 404;
  `/sw.js` is the off worker (no cache writes, no fetch handler).
- **B2 installable.** Manifest has id, name, short_name (<= 12 chars), start_url `/`, scope,
  display `standalone`, icons 192 + 512 `any` and 512 `maskable`; every icon file exists and
  its PNG header matches its declared size; committed PNGs equal the generator's output.
- **B3 no data cached.** Run in a vm with fake caches: `/api/*` (including a navigation),
  `/draft-capture.js`, other paths, POST and cross-origin requests are not intercepted; after
  a browse, every cached path is a shell path (`/`, manifest, `/icons/*`, `/assets/*`).
- **B4 offline shell.** Online a navigation goes to the network; offline it gets the cached
  index.html.
- **B5 nothing private.** Manifest, both workers and the head tags contain no key, token,
  cookie, password, roster or league id text.
- **B6 off switch cleans up.** The off worker deletes only `gridiron-shell-*` caches and
  unregisters; the client does the same the moment it loads a page with no manifest link.
- **B7 new build, new cache.** The cache is named by a hash of index.html; activate deletes
  older shell caches only.
- **B8 wired, no dev text.** Injection idempotent, throws on a page with no `</head>`;
  routes and the client call are wired; manifest strings carry no flag or file names.

What would fail it: any cached `/api` response, any change to index.html with the flag off,
an icon whose bytes do not match its declared size, or a phone left with a worker after the
flag goes off.

## RED

`test/pwa.test.js` committed before `server/platform/pwa.js` existed: the suite fails at import
(`ERR_MODULE_NOT_FOUND` for `../server/platform/pwa.js`).

## GREEN

`node --test test/pwa.test.js`: 10 pass, 0 fail. Mutation check: removing the two `/api`
guards from the worker turns B3 red (1 fail).

Real browser (Chromium 1194 via Playwright, 375 x 812, built client, `GRIDIRON_PWA=on`):
worker active with scope `/`, page controlled after one reload, 15 cached entries, 0 under
`/api`; offline, `/my-team` opens the app frame (title "Gridiron HQ") and the page's own
"Couldn't load this" card with Retry, not the browser's offline page. Flag switched off on
the same profile: registrations 1 -> 0, shell caches 1 -> 0, no manifest link.

## Not confirmed

- A real phone install (iOS Safari "Add to Home Screen", Android Chrome install prompt) over
  the tunnel. Needs Nick's phone.
- Offline, a page whose code was never loaded online cannot open (its chunk is not cached);
  it shows the app's error card. Precaching every chunk was left out to keep the shell small.
