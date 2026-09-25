/**
 * The app-wide Coach drawer is closed and styled on every area, opened directly.
 *
 * Found 2026-09-25 (PR #416): the drawer's styles (warroom-v2.css) were imported only by the
 * War Room pages, which are lazy route chunks. Opening /my-team (or any area but Today) straight
 * from the address bar loaded no drawer CSS, so the closed drawer rendered unstyled in the page
 * flow: about 460 px of blank page under every area at 375 px.
 *
 * What a browser has on a direct open of a route is the entry chunk's CSS plus that route's own
 * lazy chunk CSS. This builds the real client (Vite, into a temp dir, with a manifest) and, for
 * every area in the sidebar (navigation.ts NAV_GROUPS), checks that exactly that set of CSS
 * carries the drawer's closed state (fixed, off-screen, hidden) and its open state, and that the
 * closed state lives in the entry CSS itself, so no route depends on having visited another one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.join(REPO, 'client');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-drawer-build-'));
test.after(() => fs.rmSync(out, { recursive: true, force: true }));

/** The sidebar's areas, read from navigation.ts itself. */
function areaRoutes() {
  const src = fs.readFileSync(path.join(CLIENT, 'src/navigation.ts'), 'utf8');
  const { outputText } = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const file = path.join(out, 'navigation.mjs');
  fs.writeFileSync(file, outputText);
  return import(file).then(m => m.NAV_GROUPS.flatMap(g => g.items.map(i => i.to)));
}

/** Route path -> the page module App.tsx renders there (via its lazy import). */
function pageFor(route) {
  const app = fs.readFileSync(path.join(CLIENT, 'src/App.tsx'), 'utf8');
  const el = app.match(new RegExp(`<Route path="${route.replace(/[/]/g, '\\/')}" element=\\{<(\\w+)`))?.[1];
  assert.ok(el, `App.tsx has a <Route path="${route}">`);
  const mod = app.match(new RegExp(`const ${el} = lazy\\(\\(\\) => import\\('\\./([^']+)'\\)\\)`))?.[1];
  assert.ok(mod, `${el} is a lazy page in App.tsx`);
  return `src/${mod}.tsx`;
}

const CLOSED = /\.wr-drawer\{[^}]*position:fixed[^}]*transform:translate[XY]?\([^}]*visibility:hidden/;
const OPEN = /\.wr-drawer\.wr-open\{[^}]*transform:none[^}]*visibility:visible/;

test('every area, opened directly, has the Coach drawer closed and styled', { timeout: 180_000 }, async () => {
  const { build } = await import('vite');
  await build({ configFile: path.join(CLIENT, 'vite.config.ts'), logLevel: 'silent',
    build: { outDir: out, emptyOutDir: true, manifest: true, reportCompressedSize: false } });
  const manifest = JSON.parse(fs.readFileSync(path.join(out, '.vite/manifest.json'), 'utf8'));
  const entry = Object.values(manifest).find(c => c.isEntry);
  assert.ok(entry?.css?.length, 'the entry chunk has CSS');
  const read = files => files.map(f => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
  const entryCss = read(entry.css);
  assert.match(entryCss, CLOSED, 'the closed drawer (fixed, off-screen, hidden) is styled by the entry CSS, whatever page opens first');
  assert.match(entryCss, OPEN, 'and so is the open drawer');

  const routes = await areaRoutes();
  assert.ok(routes.length >= 7, `known-nonzero control: ${routes.length} areas`);
  for (const route of routes) {
    const chunk = manifest[pageFor(route)];
    assert.ok(chunk, `${route}: its page is a chunk in the build`);
    // What a direct open of this route loads: the entry CSS and this page chunk's own CSS (and its static imports').
    const seen = new Set(); const css = [...entry.css];
    const walk = key => { if (seen.has(key)) return; seen.add(key); const c = manifest[key]; css.push(...(c.css ?? [])); (c.imports ?? []).forEach(walk); };
    walk(pageFor(route));
    const loaded = read([...new Set(css)]);
    assert.match(loaded, CLOSED, `${route}: drawer closed and styled on a direct open`);
    assert.match(loaded, OPEN, `${route}: drawer opens styled on a direct open`);
  }
});

test('the drawer CSS travels with the app-wide Coach, not with a page', () => {
  const coach = fs.readFileSync(path.join(CLIENT, 'src/components/AppCoach.tsx'), 'utf8');
  assert.match(coach, /^import '\.\/warroom\/warroom-v2\.css';$/m, 'AppCoach.tsx imports the drawer styles itself');
  const app = fs.readFileSync(path.join(CLIENT, 'src/App.tsx'), 'utf8');
  assert.match(app, /^import \{ AppCoachProvider[^}]*\} from '\.\/components\/AppCoach';$/m, 'App.tsx imports AppCoach eagerly (not lazy), so its CSS is in the entry chunk');
  // The area routes are the last <Routes> in App.tsx (the one before it is the signed-out shell).
  const open = app.indexOf('<AppCoachProvider>'), routes = app.lastIndexOf('<Routes>');
  assert.ok(open > -1 && open < routes && app.lastIndexOf('</AppCoachProvider>') > app.lastIndexOf('</Routes>'),
    'every area route renders inside the AppCoachProvider that draws the drawer');
});
