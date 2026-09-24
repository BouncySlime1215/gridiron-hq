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
  return { data: globalThis.__engineStatus, error: null, loading: false };
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
const value = await load('components/engine/EngineValue.tsx', []);
const reason = await load('components/engine/ReasonChain.tsx', []);
const strip = await load('components/engine/EngineStatusStrip.tsx', [["'../../engine/useEngineView'", hookStubUrl]]);
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
  assert.match(t, /\+2\.5 starter out/); assert.match(t, /-1\.25 trailing script/);
  assert.match(render(reason.default, { chain: null }).text, /no reasons recorded/);
});

test('C6: UI-ENG-6 status strip: stale heartbeat red with age, fallbacks named, Jev typed', () => {
  need(strip, 'components/engine/EngineStatusStrip.tsx');
  const base = { daemon: { status: 'stale', age_sec: 3000, last_beat_at: '2026-09-20T12:00:00Z' },
    lock: { status: 'unknown' }, sources: [], snapshots: [],
    producers: [{ producer: 'fx-proj', version: '2', status: 'active', fallbacks: [
      { field: 'fx.points', fallback_field: 'fx.points_base', league_id: 92, reason: 'fixture: ours trails' }] }],
    jev: { status: 'unknown', reason: 'Jev not live: nothing writes engine.jev yet' } };
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
