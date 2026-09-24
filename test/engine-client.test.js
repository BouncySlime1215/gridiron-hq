/**
 * EA-03 (built as cloud unit EA-04), client side: the view hook, the snapshot provider,
 * EngineValue, ReasonChain and the status strip (ENGINE-SPECS.md EA-03 row, UI-ENG-6 RED,
 * UI-RED 1-2 and 4; ENGINE-ARCHITECTURE.md §2.12, §3.5).
 *
 * The TSX is compiled with the repo's own TypeScript and rendered to markup with React;
 * the fetch layer is a plain function, so the request count is measured on a mocked fetch.
 *   (C1) two views on one page make one /snapshot call and read one snapshot id;
 *   (C2) a new snapshot id moves every view on the page together;
 *   (C3) the strip's data is one /status request however often it is asked;
 *   (C4) EngineValue renders every typed status distinctly; a failed field shows its
 *        fallback or "last good, N min old"; a missing row never renders as 0 or a dash;
 *   (C5) ReasonChain renders every contribution with its signed delta;
 *   (C6) UI-ENG-6: a heartbeat 50 min old is red with its age; a producer on its fallback
 *        says "fallen back to X" with the reason; Jev unknown reads "Jev not live", never
 *        "$0.00"; a live $0 day reads "$0.00";
 *   (C7) UI-RED 1: only useEngineView.ts fetches; no component calls api( or useApi(.
 * FIX-257 (review of PR #257):
 *   (C8) the strip is behind GRIDIRON_ENGINE_STRIP (served as /status `strip`): off or
 *        missing renders nothing, preview mode shows the preview label, loading is silent;
 *   (C9) a tap on the strip opens a Sheet (DesignSystem) listing one typed row per producer;
 *   (C10) App.tsx mounts SnapshotProvider + EngineStatusStrip next to DataFreshnessBanner;
 *   (C11) ReasonChain is built on DesignSystem's DriverBars, deltas as stored, no derived total;
 *   (C12) EngineValue's source line is DesignSystem's Provenance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-engine-client-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const repoRequire = createRequire(new URL('../package.json', import.meta.url));
const src = p => new URL(`../client/src/${p}`, import.meta.url);
const exists = p => fs.existsSync(src(p));
const write = (name, text) => { fs.writeFileSync(path.join(temp, name), text); return pathToFileURL(path.join(temp, name)).href; };

const reactUrl = write('react.mjs', `import { createRequire } from 'node:module';
const R = createRequire(${JSON.stringify(repoRequire.resolve('react'))})(${JSON.stringify(repoRequire.resolve('react'))});
export default R; export const { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } = R;`);
const runtimeUrl = write('jsx-runtime.mjs', `import { createRequire } from 'node:module';
const rt = createRequire(${JSON.stringify(repoRequire.resolve('react/jsx-runtime'))})(${JSON.stringify(repoRequire.resolve('react/jsx-runtime'))});
export const jsx = rt.jsx; export const jsxs = rt.jsxs; export const Fragment = rt.Fragment;`);
const apiUrl = write('api.mjs', `export async function api(p) { return globalThis.__engineFetch(p); }`);
const hookStubUrl = write('hook-stub.mjs', `export function useEngineStatus() {
  return { data: globalThis.__engineStatus, error: globalThis.__engineError ?? null, loading: globalThis.__engineLoading === true };
}`);

/** Compile one client file and rewrite its imports; returns the module, or null when the file does not exist yet. */
async function load(file, rewrites) {
  if (!exists(file)) return null;
  const { outputText } = ts.transpileModule(fs.readFileSync(src(file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  let out = outputText;
  for (const [from, to] of [...rewrites, ["'react'", reactUrl], ['"react/jsx-runtime"', runtimeUrl]]) {
    out = out.split(from).join(`'${to}'`);
  }
  assert.doesNotMatch(out, /from '\.\.?\//, `${file} has an import the test did not map`);
  return import(write(`${file.replace(/\W/g, '_')}.mjs`, out));
}

const hook = await load('engine/useEngineView.ts', [["'../api'", apiUrl]]);
// The engine components import the shared design system (FIX-257-2); compile it once and map it.
await load('components/ui/DesignSystem.tsx', []);
const DS = ["'../ui/DesignSystem'", pathToFileURL(path.join(temp, 'components_ui_DesignSystem_tsx.mjs')).href];
const value = await load('components/engine/EngineValue.tsx', [DS]);
const reason = await load('components/engine/ReasonChain.tsx', [DS]);
const strip = await load('components/engine/EngineStatusStrip.tsx', [["'../../engine/useEngineView'", hookStubUrl], DS]);
const need = (mod, name) => assert.ok(mod, `client/src/${name} does not exist: the engine hook is not built`);

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const render = (C, props) => { const html = renderToStaticMarkup(React.createElement(C, props)); return { html, text: text(html) }; };

/** A mocked server: records every path, answers /snapshot with the current id. */
function mockServer() {
  const calls = [];
  let snapshotId = 41;
  const fetchJson = async p => {
    calls.push(p);
    if (p.startsWith('/engine/snapshot')) return { status: 'ok', snapshot: { id: snapshotId, league_id: 91, age_sec: 3 } };
    if (p.startsWith('/engine/view')) {
      const q = new URLSearchParams(p.split('?')[1]);
      return { view: q.get('view'), snapshot_id: Number(q.get('snapshot_id')), rows: [] };
    }
    if (p.startsWith('/engine/status')) return { daemon: { status: 'ok', age_sec: 30 }, producers: [], jev: { status: 'unknown' } };
    throw new Error(`unexpected ${p}`);
  };
  return { calls, fetchJson, bump() { snapshotId += 1; } };
}

/* --------------------------------------------------------------------- tests */
test('C1: two views on one page make one /snapshot call and read one snapshot id', async () => {
  need(hook, 'engine/useEngineView.ts');
  const srv = mockServer();
  const client = hook.createEngineClient(srv.fetchJson);
  const [a, b] = await Promise.all([client.view('my_team', 91), client.view('start_sit', 91)]);
  assert.equal(srv.calls.filter(c => c.startsWith('/engine/snapshot')).length, 1, srv.calls.join('\n'));
  assert.equal(a.snapshot_id, 41); assert.equal(b.snapshot_id, 41);
  for (const c of srv.calls.filter(x => x.startsWith('/engine/view'))) assert.match(c, /snapshot_id=41/);
  await client.view('my_team', 91);
  assert.equal(srv.calls.filter(c => c.startsWith('/engine/view')).length, 2, 'a view at the same snapshot is fetched once');
});

test('C2: a new snapshot id moves every view on the page together', async () => {
  need(hook, 'engine/useEngineView.ts');
  const srv = mockServer();
  const client = hook.createEngineClient(srv.fetchJson);
  await client.view('my_team', 91);
  assert.equal((await client.refresh(91)).changed, false, 'the same id is not a change');
  srv.bump();
  const r = await client.refresh(91);
  assert.equal(r.changed, true); assert.equal(r.snapshot.snapshot.id, 42);
  const [a, b] = await Promise.all([client.view('my_team', 91), client.view('start_sit', 91)]);
  assert.equal(a.snapshot_id, 42); assert.equal(b.snapshot_id, 42);
  assert.equal(hook.SNAPSHOT_POLL_MS, 60000, 'the page polls /snapshot every 60 s (§3.5)');
});

test('C3: the status strip\'s data is one /status request', async () => {
  need(hook, 'engine/useEngineView.ts');
  const srv = mockServer();
  const client = hook.createEngineClient(srv.fetchJson);
  await Promise.all([client.status(), client.status(), client.status()]);
  assert.equal(srv.calls.length, 1); assert.equal(srv.calls[0], '/engine/status');
});

const row = (status, extra = {}) => ({ entity_type: 'player', entity_id: '9201', league_id: 0, field: 'fx.points', status,
  reason: null, value: 17.25, fallback_used: false, fallback_field: null, producer: 'fx-proj', producer_version: '2',
  as_of: '2026-09-20T13:00:00.000Z', health: { status: 'ok' }, reason_chain: null, fresh_at: null, state_id: 7, ...extra });

test('C4: EngineValue renders each typed status distinctly and never a failed value', () => {
  need(value, 'components/engine/EngineValue.tsx');
  const V = value.default;
  const cases = {
    ok: render(V, { row: row('ok') }),
    zero: render(V, { row: row('zero', { value: null, reason: 'no adds in a covered window' }) }),
    unknown: render(V, { row: row('unknown', { value: null, reason: 'no_row_at_snapshot', producer: null }) }),
    stale: render(V, { row: row('stale', { age_min: 120 }) }),
    fallback: render(V, { row: row('fallback', { value: 11.5, fallback_used: true, fallback_field: 'fx.points_base',
      producer: 'fx-base', reason: 'fx.points failed in_range:0:60; serving fx.points_base' }) }),
    thin: render(V, { row: row('thin', { value: { n: 3, mean: 4 } }), format: v => String(v.mean) }),
    degraded: render(V, { row: row('degraded') }),
    last_good: render(V, { row: row('last_good', { value: 5, fallback_used: true, age_min: 60,
      reason: 'fx.lonely failed; last good, 60 min old' }) }),
  };
  assert.match(cases.ok.text, /^17\.25/);
  assert.match(cases.zero.text, /^0\b/);
  assert.match(cases.unknown.text, /not computed yet/); assert.match(cases.unknown.text, /no_row_at_snapshot/);
  assert.doesNotMatch(cases.unknown.text, /^0|—|^-$/, 'a missing row rendered as 0 or a dash');
  assert.match(cases.stale.text, /17\.25/); assert.match(cases.stale.text, /stale, 120 min old/);
  assert.match(cases.fallback.text, /11\.5/); assert.match(cases.fallback.text, /fallback: fx\.points_base/);
  assert.match(cases.fallback.text, /in_range/);
  assert.match(cases.thin.text, /thin \(n=3\)/); assert.match(cases.thin.html, /amber/);
  assert.match(cases.degraded.text, /degraded/);
  assert.match(cases.last_good.text, /^5\b/); assert.match(cases.last_good.text, /last good, 60 min old/);
  for (const [status, c] of Object.entries(cases)) {
    assert.match(c.html, new RegExp(`data-engine-status="${status}"`), `${status} has its own marker`);
  }
  assert.equal(new Set(Object.values(cases).map(c => c.text)).size, 8, 'every status renders differently');
  assert.match(cases.ok.html, /fx-proj@2/, 'the value names its producer@version');
  // An unrecognised status is never shown as if it were ok.
  assert.match(render(V, { row: row('failed', { value: 99 }) }).text, /not computed yet/);
  assert.doesNotMatch(render(V, { row: row('failed', { value: 99 }) }).text, /99/);
});

test('C5: ReasonChain renders every contribution with its signed delta', () => {
  need(reason, 'components/engine/ReasonChain.tsx');
  const chain = { v: 2, additive: true, space: 'pts', baseline: { value: 10, source: 'espn', text: 'ESPN 10.0' },
    contributions: [
      { source: 'injury', kind: 'event', event_ids: [3], state_ids: [], delta: 2.5, weight: null, text: 'starter out' },
      { source: 'script', kind: 'state', event_ids: [], state_ids: [9], delta: -1.25, weight: null, text: 'trailing script' },
    ], residual: 0, n: null };
  const { text: t } = render(reason.default, { chain });
  assert.match(t, /ESPN 10\.0/);
  // Each contribution's text with its signed delta as stored (DriverBars puts the label first: FIX-257-2).
  assert.match(t, /starter out \+2\.5/); assert.match(t, /trailing script -1\.25/);
  assert.match(render(reason.default, { chain: null }).text, /no reasons recorded/);
});

test('C6: UI-ENG-6 status strip: stale heartbeat red with age, fallbacks named, Jev typed', () => {
  need(strip, 'components/engine/EngineStatusStrip.tsx');
  const base = { daemon: { status: 'stale', age_sec: 3000, last_beat_at: '2026-09-20T12:00:00Z' },
    lock: { status: 'unknown' }, sources: [], snapshots: [],
    producers: [{ producer: 'fx-proj', version: '2', status: 'active', fallbacks: [
      { field: 'fx.points', fallback_field: 'fx.points_base', league_id: 92, reason: 'fixture: ours trails' }] }],
    jev: { status: 'unknown', reason: 'Jev not live: nothing writes engine.jev yet' }, strip: { enabled: true } };
  globalThis.__engineStatus = base;
  const s = render(strip.default, {});
  assert.match(s.html, /data-engine-daemon="stale"/); assert.match(s.html, /rose|red/);
  assert.match(s.text, /50 min/);
  assert.match(s.text, /fx\.points fallen back to fx\.points_base/); assert.match(s.text, /ours trails/);
  assert.match(s.text, /Jev not live/); assert.doesNotMatch(s.text, /\$0\.00/);
  globalThis.__engineStatus = { ...base, daemon: { status: 'ok', age_sec: 30 }, jev: { status: 'zero', spend_usd: 0 } };
  const z = render(strip.default, {});
  assert.match(z.html, /data-engine-daemon="ok"/); assert.match(z.text, /\$0\.00/);
  globalThis.__engineStatus = undefined;
  assert.match(render(strip.default, {}).text, /engine status not loaded/);
});

test('C7: UI-RED 1: only useEngineView.ts fetches; the components do no fetching', () => {
  for (const f of ['engine/useEngineView.ts', 'engine/SnapshotProvider.tsx', 'components/engine/EngineValue.tsx',
    'components/engine/ReasonChain.tsx', 'components/engine/EngineStatusStrip.tsx']) {
    assert.ok(exists(f), `client/src/${f} does not exist`);
    const code = fs.readFileSync(src(f), 'utf8');
    assert.doesNotMatch(code, /useApi\(|\bfetch\(/, `${f} fetches directly`);
    if (f !== 'engine/useEngineView.ts') assert.doesNotMatch(code, /\bapi\(/, `${f} calls api(`);
  }
  assert.match(fs.readFileSync(src('engine/SnapshotProvider.tsx'), 'utf8'), /createEngineClient/);
});

/* ------------------------------------------------------------ FIX-257 (PR #257 review) */
const okStatus = (extra = {}) => ({ daemon: { status: 'ok', age_sec: 30 }, lock: { status: 'unknown' }, sources: [], snapshots: [],
  producers: [], jev: { status: 'unknown', reason: 'Jev not live: nothing writes engine.jev yet' }, strip: { enabled: true }, ...extra });
function withStatus(data, fn, { loading = false, error = null } = {}) {
  globalThis.__engineStatus = data; globalThis.__engineLoading = loading; globalThis.__engineError = error;
  try { return fn(); } finally { globalThis.__engineStatus = undefined; globalThis.__engineLoading = false; globalThis.__engineError = null; }
}

test('C8: the strip is behind GRIDIRON_ENGINE_STRIP: off or missing renders nothing, preview is labelled', () => {
  need(strip, 'components/engine/EngineStatusStrip.tsx');
  const S = strip.default;
  assert.equal(withStatus(okStatus({ strip: { enabled: false, reason: 'default-off. Set GRIDIRON_ENGINE_STRIP=1' } }),
    () => render(S, {}).html), '', 'flag off: nothing on the page');
  assert.equal(withStatus(okStatus({ strip: undefined }), () => render(S, {}).html), '', 'no flag in the payload reads as off');
  assert.equal(withStatus(undefined, () => render(S, {}).html, { loading: true }), '', 'loading is silent (the flag is not known yet)');
  const on = withStatus(okStatus(), () => render(S, {}));
  assert.match(on.html, /data-engine-daemon="ok"/); assert.doesNotMatch(on.text, /Preview/);
  const pv = withStatus(okStatus({ strip: { enabled: true, preview: true, preview_reason: 'strip is default-off' } }), () => render(S, {}));
  assert.match(pv.text, /Preview/); assert.match(pv.html, /strip is default-off/);
  assert.match(withStatus(undefined, () => render(S, {}).text, { error: 'HTTP 500' }), /engine status failed: HTTP 500/,
    'a failed status read says so');
});

const PRODUCERS = [
  { producer: 'calendar', version: '1', status: 'active', health: 'error', reason: 'last run failed: fixture: feed 500',
    age_sec: 7200, last_run_at: '2026-09-20T12:00:00Z', last_error_at: '2026-09-20T14:00:00Z', fallbacks: [] },
  { producer: 'fx-base', version: '1', status: 'active', health: 'ok', reason: null, age_sec: 90, fallbacks: [] },
  { producer: 'fx-idle', version: '1', status: 'active', health: 'unknown', reason: 'has never run here', age_sec: null, fallbacks: [] },
  { producer: 'fx-proj', version: '2', status: 'active', health: 'fallback', reason: '1 field on its fallback: fx.points',
    age_sec: 300, fallbacks: [{ field: 'fx.points', fallback_field: 'fx.points_base', league_id: 92, reason: 'fixture: ours trails' }] },
];

test('C9: a tap on the strip opens a Sheet listing one typed row per producer', () => {
  need(strip, 'components/engine/EngineStatusStrip.tsx');
  assert.match(fs.readFileSync(src('components/engine/EngineStatusStrip.tsx'), 'utf8'),
    /import\s*\{[^}]*\bSheet\b[^}]*\}\s*from '\.\.\/ui\/DesignSystem'/, 'the sheet is the DesignSystem Sheet');
  const s = withStatus(okStatus({ producers: PRODUCERS }), () => render(strip.default, {}));
  assert.match(s.html, /<button[^>]*aria-haspopup="dialog"/, 'the strip is one tap target that opens a dialog');
  assert.match(s.html, /aria-label="[^"]*engine status[^"]*"/i);
  const Sheet = strip.EngineStatusSheet;
  assert.equal(typeof Sheet, 'function', 'EngineStatusStrip.tsx exports EngineStatusSheet');
  assert.equal(render(Sheet, { status: okStatus({ producers: PRODUCERS }), open: false, onClose() {} }).html, '');
  const open = render(Sheet, { status: okStatus({ producers: PRODUCERS }), open: true, onClose() {} });
  assert.match(open.html, /role="dialog"/);
  for (const p of PRODUCERS) {
    assert.match(open.text, new RegExp(`${p.producer}@${p.version}`), `${p.producer} row`);
    assert.match(open.html, new RegExp(`data-producer="${p.producer}"[^>]*data-producer-health="${p.health}"`), `${p.producer} typed`);
  }
  assert.match(open.text, /feed 500/); assert.match(open.text, /never run/);
  assert.match(open.text, /fx\.points fallen back to fx\.points_base/); assert.match(open.text, /ours trails/);
  assert.match(open.text, /5 min ago/, 'a producer\'s last run as an age');
  const empty = render(Sheet, { status: okStatus(), open: true, onClose() {} });
  assert.match(empty.text, /No producers registered/);
});

test('C10: App.tsx mounts SnapshotProvider and EngineStatusStrip next to DataFreshnessBanner', () => {
  const app = fs.readFileSync(src('App.tsx'), 'utf8');
  assert.match(app, /import SnapshotProvider from '\.\/engine\/SnapshotProvider'/);
  assert.match(app, /import EngineStatusStrip from '\.\/components\/engine\/EngineStatusStrip'/);
  assert.match(app, /<DataFreshnessBanner \/>\s*<SnapshotProvider[^>]*>\s*<EngineStatusStrip \/>\s*<\/SnapshotProvider>/,
    'the strip sits under the freshness banner inside its own snapshot provider');
});

test('C11: ReasonChain is built on DesignSystem DriverBars; deltas as stored, no derived total', () => {
  need(reason, 'components/engine/ReasonChain.tsx');
  assert.match(fs.readFileSync(src('components/engine/ReasonChain.tsx'), 'utf8'),
    /import\s*\{[^}]*\bDriverBars\b[^}]*\}\s*from '\.\.\/ui\/DesignSystem'/);
  const chain = { v: 2, additive: true, space: 'pts', baseline: { value: 10, source: 'espn', text: 'ESPN 10.0' },
    contributions: [
      { source: 'injury', kind: 'event', event_ids: [3], state_ids: [], delta: 2.5, weight: null, text: 'starter out' },
      { source: 'script', kind: 'state', event_ids: [], state_ids: [9], delta: -1.25, weight: null, text: 'trailing script' },
      { source: 'news', kind: 'event', event_ids: [4], state_ids: [], delta: null, weight: 0.5, text: 'coach quote' },
    ], residual: 0.25, n: null };
  const r = render(reason.default, { chain });
  assert.match(r.html, /rounded-full bg-slate-100/, 'the DriverBars track');
  assert.match(r.html, /bg-red-600/); assert.match(r.html, /bg-emerald-600/);
  assert.match(r.text, /-1\.25/); assert.doesNotMatch(r.text, /-1\.3\b/, 'a delta re-rounded instead of shown as stored');
  assert.doesNotMatch(r.text, /Total/, 'the client derives no total from engine values');
  assert.match(r.text, /coach quote/); assert.doesNotMatch(r.text, /\+0(\.0)?(?![.\d])/, 'a null delta is not drawn as 0');
  assert.match(r.text, /\+0\.25 not explained by the rows above/);
});

test('C12: EngineValue\'s source line is DesignSystem Provenance', () => {
  need(value, 'components/engine/EngineValue.tsx');
  assert.match(fs.readFileSync(src('components/engine/EngineValue.tsx'), 'utf8'),
    /import\s*\{[^}]*\bProvenance\b[^}]*\}\s*from '\.\.\/ui\/DesignSystem'/);
  const ok = render(value.default, { row: row('ok') });
  assert.match(ok.html, /<details/); assert.match(ok.text, /Source: fx-proj@2/);
  const unknown = render(value.default, { row: row('unknown', { value: null, producer: null }) });
  assert.doesNotMatch(unknown.text, /Source:/);
});
