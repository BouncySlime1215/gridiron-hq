/**
 * WR-2: ONE dashboard, no page scroll (WAR-ROOM-UI.md v2 section 1), plus the house
 * source-level rules for the War Room surface (section 7, war-room-surface).
 *
 *  - the grid container is fixed, 100vh tall, overflow hidden (inline, so no stylesheet
 *    can lose it), and holds every panel + the Coach dock in one viewport;
 *  - the stylesheet never lets the grid or the page scroll; the phone layout (< 700 px)
 *    is a horizontal scroll-snap deck, still no vertical page scroll;
 *  - dark tokens exist (prefers-color-scheme and [data-theme="dark"]);
 *  - only useWarRoom.ts fetches; no arithmetic on `.value` in components;
 *  - navigation stays 8 items and App.tsx gains no route.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWarRoom, textOf, WARROOM_DIR } from './helpers/warroom-tsx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'war-room-plans.json'), 'utf8'));
const { buildWarRoomView } = await import('../server/services/war-room-view.js');

const wr = await loadWarRoom();
test.after(() => wr.cleanup());
const { default: WarRoom, ROOT_STYLE, PANELS } = await wr.mod('WarRoom');
const { useWarRoom } = await wr.mod('useWarRoom');

const view = buildWarRoomView(1, { status: 'ok', entries: structuredClone(fixture), as_of: 'x', id: 'y' }, { enabled: true, preview: true });
const html = renderToStaticMarkup(React.createElement(WarRoom, {
  view, leagues: [{ id: 1, name: 'League 1' }, { id: 2, name: 'League 2' }], activeId: 1, onLeague() {}, onExit() {},
}));
const css = fs.readFileSync(path.join(WARROOM_DIR, 'warroom.css'), 'utf8');
/** Declarations of the first rule whose selector is exactly `sel` (outside media blocks). */
const rule = sel => {
  const m = css.match(new RegExp(`(^|\\n)${sel.replace(/[.[\]"=]/g, c => `\\${c}`)}\\s*\\{([^}]*)\\}`));
  return m ? m[2] : null;
};

test('the grid container is fixed, 100vh tall and overflow hidden', () => {
  assert.equal(ROOT_STYLE.height, '100vh');
  assert.equal(ROOT_STYLE.overflow, 'hidden');
  assert.equal(ROOT_STYLE.position, 'fixed');
  const root = html.match(/^<div class="wr-root wr-app"[^>]*data-testid="war-room-grid"[^>]*style="([^"]*)"/);
  assert.ok(root, 'the outermost element is the grid');
  assert.match(root[1], /position:fixed/);
  assert.match(root[1], /height:100vh/);
  assert.match(root[1], /overflow:hidden/);
  const app = rule('.wr-app');
  assert.ok(app, 'the .wr-app rule exists');
  assert.match(app, /display:\s*grid/);
  assert.doesNotMatch(css, /\.wr-app\s*\{[^}]*overflow(-y)?:\s*(auto|scroll)/, 'the grid never scrolls');
  assert.match(css, /@supports \(height: 100dvh\) \{ \.wr-app \{ height: 100dvh !important; \} \}/, 'phones use the visible viewport');
});

test('every panel and the Coach dock sit in the one grid, each in a named area', () => {
  for (const p of PANELS) assert.match(html, new RegExp(`data-panel="${p.id}"[^>]*style="grid-area:${p.id}"`), p.id);
  assert.match(html, /class="wr-coach/);
  assert.match(css, /\.wr-coach \{ grid-area: coach;/);
  for (const a of ['top', 'next', 'stops', 'flip', 'targets', 'catch', 'brain', 'coach']) assert.ok(ROOT_STYLE.gridTemplateAreas.includes(a), a);
  // Panels clip; their bodies are the only thing allowed to scroll, inside the panel.
  assert.match(rule('.wr-panel'), /overflow:\s*hidden/);
  assert.match(rule('.wr-panel'), /min-height:\s*0/);
});

test('phone (< 700 px) is a one-screen swipe deck: horizontal scroll-snap, no vertical scroll', () => {
  const phone = css.split('@media (max-width: 699px)')[1];
  assert.ok(phone, 'phone block exists');
  assert.match(phone, /\.wr-panels \{[^}]*overflow-x: auto; overflow-y: hidden; scroll-snap-type: x mandatory/);
  assert.match(phone, /\.wr-panels > \.wr-panel \{ flex: 0 0 100%; scroll-snap-align: start/);
  assert.match(phone, /grid-template-areas: "top" "deck" "dots" !important/, 'the phone areas override the inline desktop areas');
  assert.match(html, /<nav class="wr-dots"/);
});

test('dark tokens: system dark and the explicit toggle both define every token', () => {
  const light = [...rule('.wr-root').matchAll(/(--wr-[\w-]+):/g)].map(m => m[1]).sort();
  assert.ok(light.length >= 15);
  const sys = css.split('@media (prefers-color-scheme: dark)')[1].split('}')[0];
  const forced = rule('.wr-root[data-theme="dark"]');
  for (const t of light) {
    assert.ok(sys.includes(`${t}:`), `system dark sets ${t}`);
    assert.ok(forced.includes(`${t}:`), `forced dark sets ${t}`);
  }
});

test('flag-on view renders the whole dashboard with unknowns named, never 0', () => {
  const text = textOf(html);
  for (const s of ['War Room', 'Next move', 'Stops', 'Flip map', 'Suggested targets', 'Catch-up', 'Is the brain working?', 'Coach',
    'Preview, unconfirmed', 'not ranked yet', '1 of 4', 'Send this to Team 7']) assert.ok(text.includes(s), s);
  assert.doesNotMatch(text, /\b0\.0%|\b0%|NaN|undefined/);
  for (const id of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']) assert.ok(text.includes(id), id);
});

test('only useWarRoom.ts fetches, and it asks for the one route', () => {
  const files = fs.readdirSync(WARROOM_DIR).filter(f => /\.tsx?$/.test(f));
  const fetchers = files.filter(f => /\buseApi\s*[<(]|\bapi\s*[<(]|\bfetch\s*\(/.test(fs.readFileSync(path.join(WARROOM_DIR, f), 'utf8')));
  assert.deepEqual(fetchers, ['useWarRoom.ts']);
  globalThis.__warRoomPaths = [];
  const Probe = () => { useWarRoom(3); useWarRoom(null); return null; };
  renderToStaticMarkup(React.createElement(Probe));
  assert.deepEqual(globalThis.__warRoomPaths, ['/trades/3/war-room', null]);
});

test('no arithmetic on producer values in components (formatters only)', () => {
  for (const f of fs.readdirSync(WARROOM_DIR).filter(x => /\.tsx$/.test(x))) {
    const src = fs.readFileSync(path.join(WARROOM_DIR, f), 'utf8');
    assert.doesNotMatch(src, /\.value\s*[-+*/]\s*[\w(]|[\w)]\s*[-+*/]\s*[\w.?]*\.value\b/, `${f} does arithmetic on a .value`);
  }
});

test('nav stays 8 items and App.tsx gains no route', () => {
  const nav = fs.readFileSync(path.join(REPO, 'client', 'src', 'navigation.ts'), 'utf8');
  const groups = nav.slice(nav.indexOf('export const NAV_GROUPS'), nav.indexOf('];', nav.indexOf('export const NAV_GROUPS')));
  assert.equal((groups.match(/\{ to: '/g) ?? []).length, 8);
  const app = fs.readFileSync(path.join(REPO, 'client', 'src', 'App.tsx'), 'utf8');
  assert.doesNotMatch(app, /war-room|warroom/i);
  const brain = fs.readFileSync(path.join(REPO, 'client', 'src', 'pages', 'TradeBrain.tsx'), 'utf8');
  assert.match(brain, /TABS\.filter\(t => t\.id !== 'war-room' \|\| warOn\)/, 'the tab is drawn only when the view is enabled');
});
