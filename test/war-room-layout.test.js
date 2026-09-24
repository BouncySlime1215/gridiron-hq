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
const { default: WarRoom, ROOT_STYLE, PANELS } = await wr.mod('WarRoom');
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
  for (const a of ['top', 'next', 'stops', 'flip_map', 'targets', 'catch', 'brain_report', 'coach']) assert.ok(ROOT_STYLE.gridTemplateAreas.includes(a), a);
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

test('flag-on view renders every contract section from the producer, never 0', () => {
  const text = textOf(html);
  for (const s of ['War Room', 'Next move', 'Stops', 'Flip map', 'Suggested targets', 'Catch-up', 'Is the brain working?', 'Coach',
    'Preview, unconfirmed', '1 of 2', 'Send this to Team 7',
    // destination, attention, speed curve, catch-up, brain report and targets are the producer's, not "not built"
    '11.8%', 'rank 1 of 3', 'Offer Team 9 the bench receiver', 'wk 5', 'D. Harlow (WR)', 'not enough data']) assert.ok(text.includes(s), s);
  assert.doesNotMatch(text, /\b0\.0%|\b0%|NaN|undefined/);
  for (const id of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']) assert.ok(text.includes(id), id);
  // WarRoom wires the request route into the target picker (the call site of target.approve).
  assert.match(html, /<button type="button" class="wr-btn wr-sm">Approve<\/button>/);
  // A league with nothing produced still draws every panel, each saying why.
  const empty = renderToStaticMarkup(React.createElement(WarRoom, {
    view: buildWarRoomView(99, plans, { enabled: true, preview: false }), leagues: [{ id: 99, name: null }], activeId: 99, onLeague() {}, onExit() {},
  }));
  assert.match(textOf(empty), /No plan has been run for this league yet/);
  assert.match(textOf(empty), /not ranked yet/);
});

test("FIX-282-1: the producer fixture through #287's contract view: targets, flip_map and brain_report panels and Coach read it", async () => {
  const real = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'producer-plans.json'), 'utf8'));
  const realPlans = { status: 'ok', entries: structuredClone(real.leagues), as_of: real.generated_at, id: 'p' };
  const { useWarRoomCoach } = await wr.mod('coach/useWarRoomCoach');
  const drawn = real.leagues.filter(e => !e.error);
  assert.ok(drawn.length >= 3, 'the fixture has leagues to draw');
  for (const e of drawn) {
    const v = buildWarRoomView(e.league, realPlans, { enabled: true, preview: false });
    const text = textOf(renderToStaticMarkup(React.createElement(WarRoom, {
      view: v, leagues: [{ id: e.league, name: `L${e.league}` }], activeId: e.league, onLeague() {}, onExit() {},
    })));
    const at = (id, title) => text.includes(title) || assert.fail(`${id} panel missing on league ${e.league}`);
    at('targets', 'Suggested targets'); at('flip_map', 'Flip map'); at('brain_report', 'Is the brain working?');
    if (v.targets.status === 'ok' && v.targets.value.length) assert.ok(text.includes(v.names[v.targets.value[0].player]), `league ${e.league}: first target drawn`);
    else assert.ok(text.includes(v.targets.reason), `league ${e.league}: targets say why`);
    if (v.flip_map.status === 'ok' && v.flip_map.value.length) {
      const f = v.flip_map.value[0];
      assert.ok(text.includes(`${v.names[f.player]} gap`), `league ${e.league}: first flip drawn`);
    } else assert.ok(text.includes(v.flip_map.reason), `league ${e.league}: flip map says why`);
    if (v.brain_report.status === 'ok') for (const c of v.brain_report.value.checks) assert.ok(text.includes(c.id), c.id);
    else assert.ok(text.includes(v.brain_report.reason), `league ${e.league}: brain report says why`);
    assert.doesNotMatch(text, /NaN|undefined/);
    // Coach is handed this same contract view (WarRoom.tsx: useWarRoomCoach({ ..., plans: view })).
    let coach = null;
    const Probe = () => { coach = useWarRoomCoach({ leagueId: e.league, leagues: [e.league], plans: v }); return null; };
    renderToStaticMarkup(React.createElement(Probe));
    assert.ok(coach, `league ${e.league}: Coach mounts on the contract view`);
  }
  const src = fs.readFileSync(path.join(WARROOM_DIR, 'WarRoom.tsx'), 'utf8');
  assert.match(src, /useWarRoomCoach\(\{[^}]*plans: view/);
  assert.match(src, /<CoachDock coach=\{coach\} plans=\{view\}/);
  assert.equal(fs.existsSync(path.join(WARROOM_DIR, 'CoachDock.tsx')), false, 'the placeholder dock stays deleted');
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

test('nav stays 8 items and App.tsx gains no route', () => {
  const nav = fs.readFileSync(path.join(REPO, 'client', 'src', 'navigation.ts'), 'utf8');
  const groups = nav.slice(nav.indexOf('export const NAV_GROUPS'), nav.indexOf('];', nav.indexOf('export const NAV_GROUPS')));
  assert.equal((groups.match(/\{ to: '/g) ?? []).length, 8);
  const app = fs.readFileSync(path.join(REPO, 'client', 'src', 'App.tsx'), 'utf8');
  assert.doesNotMatch(app, /war-room|warroom/i);
  const brain = fs.readFileSync(path.join(REPO, 'client', 'src', 'pages', 'TradeBrain.tsx'), 'utf8');
  assert.match(brain, /TABS\.filter\(t => t\.id !== 'war-room' \|\| warOn\)/, 'the tab is drawn only when the view is enabled');
});
