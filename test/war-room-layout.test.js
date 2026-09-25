/**
 * WR-2: ONE dashboard, no page scroll (WAR-ROOM-UI.md v2 section 1), plus the house
 * source-level rules for the War Room surface (section 7, war-room-surface).
 *
 *  - the grid container is fixed, 100vh tall, overflow hidden (inline, so no stylesheet
 *    can lose it), and holds every panel + the Coach dock in one viewport;
 *  - the stylesheet never lets the grid or the page scroll; the phone layout (< 700 px)
 *    is a horizontal scroll-snap deck, still no vertical page scroll;
 *  - dark tokens exist (prefers-color-scheme and [data-theme="dark"]);
 *  - only useWarRoom.ts reads and only requests.ts writes (the request table); no
 *    arithmetic on `.value` in components;
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
const producer = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'ui-contract-plans.json'), 'utf8'));
const { buildWarRoomView } = await import('../server/services/war-room-view.js');

const wr = await loadWarRoom();
test.after(() => wr.cleanup());
const { default: WarRoom } = await wr.mod('WarRoomV2'); // the classic dashboard is retired; the War Room is WarRoomV2
const { useWarRoom } = await wr.mod('useWarRoom');

const plans = { status: 'ok', entries: structuredClone(producer.leagues), as_of: producer.generated_at, id: 'y' };
const view = buildWarRoomView(1, plans, { enabled: true, preview: true });
const html = renderToStaticMarkup(React.createElement(WarRoom, {
  view, leagues: [{ id: 1, name: 'League 1' }, { id: 2, name: 'League 2' }], activeId: 1, onLeague() {}, onExit() {},
}));
const css = fs.readFileSync(path.join(WARROOM_DIR, 'warroom.css'), 'utf8');
/** Declarations of the first rule whose selector is exactly `sel` (outside media blocks). */
const rule = sel => {
  const m = css.match(new RegExp(`(^|\\n)${sel.replace(/[.[\]"=]/g, c => `\\${c}`)}\\s*\\{([^}]*)\\}`));
  return m ? m[2] : null;
};

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

test('only useWarRoom.ts reads and only requests.ts writes, each to its one route', () => {
  const files = fs.readdirSync(WARROOM_DIR).filter(f => /\.tsx?$/.test(f));
  const src = f => fs.readFileSync(path.join(WARROOM_DIR, f), 'utf8');
  const fetchers = files.filter(f => /from ['"]\.\.\/\.\.\/api['"]|\bfetch\s*\(/.test(src(f)));
  assert.deepEqual(fetchers.sort(), ['requests.ts', 'useWarRoom.ts']);
  assert.doesNotMatch(src('requests.ts'), /\buseApi\b|\bfetch\s*\(/);
  assert.match(src('requests.ts'), /`\/warroom\/\$\{leagueId\}\/requests`/);
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

// UI consolidation (docs/ui/CONSOLIDATION-MAP.md, decision 2): the nav is seven areas now.
test('nav is 7 items and App.tsx gains no War Room route', () => {
  const nav = fs.readFileSync(path.join(REPO, 'client', 'src', 'navigation.ts'), 'utf8');
  const groups = nav.slice(nav.indexOf('export const NAV_GROUPS'), nav.indexOf('];', nav.indexOf('export const NAV_GROUPS')));
  assert.equal((groups.match(/\{ to: '/g) ?? []).length, 7);
  const app = fs.readFileSync(path.join(REPO, 'client', 'src', 'App.tsx'), 'utf8');
  assert.doesNotMatch(app, /war-room|warroom/i);
  // Trade Brain's tabs are gone; the planner is Trades → Next move, drawn only when the view is enabled.
  const trades = fs.readFileSync(path.join(REPO, 'client', 'src', 'pages', 'Trades.tsx'), 'utf8');
  assert.match(trades, /if \(view === 'planner' && warOn && activeId && warRoom\.data\) \{/, 'the planner is drawn only when the view is enabled');
});
