/**
 * UX-08 (plan item D23, UI rule 9), second pass after skeptic review: every
 * component this unit changed renders plain words when the server hands it an
 * internal error string, and the string reaches neither the text nor any
 * attribute (title, aria-label) of the rendered markup. Assertions are made on
 * the RAW html string, not tag-stripped text, so an attribute leak fails too.
 *
 * Components covered (each is the real TSX, compiled with the repo's
 * TypeScript, imports swapped for stubs, rendered by React to markup):
 *   PostDraftPlan (useApi error, self_scout.error, trades.error)
 *   ModelRegistryPanel (useApi error)
 *   NewsHub (error prop)
 *   WaiverWire (data.error — sits on /lineup)
 *   MatchupPosture (data.error — sits on /lineup)
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ux08-components-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const repoRequire = createRequire(new URL('../package.json', import.meta.url));
const write = (name, text) => { fs.writeFileSync(path.join(temp, name), text); return pathToFileURL(path.join(temp, name)).href; };
const cjs = mod => `import { createRequire } from 'node:module';
const rt = createRequire(${JSON.stringify(repoRequire.resolve(mod))})(${JSON.stringify(repoRequire.resolve(mod))});`;

const runtimeUrl = write('jsx-runtime.mjs', `${cjs('react/jsx-runtime')}
export const jsx = rt.jsx; export const jsxs = rt.jsxs; export const Fragment = rt.Fragment;`);
const reactUrl = write('react.mjs', `${cjs('react')}
export default rt; export const useMemo = rt.useMemo; export const useState = rt.useState; export const useEffect = rt.useEffect;`);
const linkUrl = write('react-router-dom.mjs', 'export function Link({ children }) { return children ?? null; }');
const apiUrl = write('api.mjs', `export function useApi() { return globalThis.__api ?? { data: null, loading: false, error: null, refetch: () => {} }; }
export const headshotUrl = () => ''; export const api = {};`);
const headshotUrl = write('player-row.mjs', 'export function Headshot() { return null; }');
const newsFeedUrl = write('use-news-feed.mjs', 'export function useNewsFeed() { return {}; }');

function compile(rel, swaps) {
  const source = fs.readFileSync(new URL(`../client/src/${rel}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  let compiled = outputText;
  for (const [from, to, optional] of [...swaps, ['"react/jsx-runtime"', runtimeUrl]]) {
    if (optional && !compiled.includes(from)) continue;
    assert.ok(compiled.includes(from), `compiled ${rel} imports ${from}`);
    compiled = compiled.split(from).join(`'${to}'`);
  }
  return write(`${path.basename(rel)}-${Date.now()}-${Math.random()}.mjs`, compiled);
}
const pageStateUrl = () => compile('components/PageState.tsx', [["'react-router-dom'", linkUrl]]);

// Real internal detail this server has produced (contingency.js
// availabilityDegradation reason + fix), not a paraphrase.
const LEAKY = 'nfl_availability_role_rates is missing or empty, so the role layer is not running ' +
  '(docs/tdd/play-chance.tdd.md); run scripts/fit-availability.mjs';
const MARKERS = ['nfl_availability_role_rates', 'docs/tdd/', 'scripts/', '.mjs'];

function assertNoLeak(html, where) {
  for (const m of MARKERS) assert.ok(!html.includes(m), `${where} leaked "${m}" into markup: ${html}`);
}
// Silence and capture the console.error the components now route detail to.
function captureConsole(fn) {
  const orig = console.error; const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  try { return { out: fn(), seen }; } finally { console.error = orig; }
}

test('control: the harness sees component markup (known-nonzero render)', async () => {
  const { default: MatchupPosture } = await import(compile('components/lineup/MatchupPosture.tsx',
    [["'../PageState'", pageStateUrl()]]));
  const html = renderToStaticMarkup(React.createElement(MatchupPosture,
    { data: null, loading: false, error: null, onRetry: () => {} }));
  assert.match(html, /This matchup/);
  // And the marker check can fire: raw LEAKY contains every marker.
  for (const m of MARKERS) assert.ok(LEAKY.includes(m), `LEAKY contains ${m}`);
});

test('MatchupPosture: data.error is logged, not rendered', async () => {
  const { default: MatchupPosture } = await import(compile('components/lineup/MatchupPosture.tsx',
    [["'../PageState'", pageStateUrl()]]));
  const { out: html, seen } = captureConsole(() => renderToStaticMarkup(React.createElement(MatchupPosture,
    { data: { error: LEAKY }, loading: false, error: null, onRetry: () => {} })));
  assertNoLeak(html, 'MatchupPosture');
  assert.match(html, /No matchup read for this league right now/);
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')), 'detail goes to console.error');
});

test('WaiverWire: data.error is logged, not rendered', async () => {
  const { default: WaiverWire } = await import(compile('components/lineup/WaiverWire.tsx',
    [["'react'", reactUrl], ["'../PageState'", pageStateUrl()]]));
  const { out: html, seen } = captureConsole(() => renderToStaticMarkup(React.createElement(WaiverWire,
    { data: { error: LEAKY }, loading: false, error: null, onRetry: () => {}, out: new Map() })));
  assertNoLeak(html, 'WaiverWire');
  assert.match(html, /No waiver board for this league right now/);
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')), 'detail goes to console.error');
});

async function loadPostDraftPlan() {
  const { default: C } = await import(compile('components/PostDraftPlan.tsx',
    [["'../api'", apiUrl], ["'./PlayerRow'", headshotUrl], ["'./PageState'", pageStateUrl(), true]]));
  return C;
}

test('PostDraftPlan: a failed fetch is logged, not rendered', async () => {
  const C = await loadPostDraftPlan();
  globalThis.__api = { data: null, loading: false, error: LEAKY, refetch: () => {} };
  const { out: html, seen } = captureConsole(() => renderToStaticMarkup(React.createElement(C, { leagueId: 1, teamId: '1' })));
  globalThis.__api = null;
  assertNoLeak(html, 'PostDraftPlan (fetch error)');
  assert.match(html, /load the post-draft plan/);
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')));
});

test('PostDraftPlan: self_scout.error and trades.error are logged, not rendered', async () => {
  const C = await loadPostDraftPlan();
  globalThis.__api = { data: { drafted: true, self_scout: { error: LEAKY }, trades: { error: LEAKY }, lineup: null },
    loading: false, error: null, refetch: () => {} };
  const { out: html, seen } = captureConsole(() => renderToStaticMarkup(React.createElement(C, { leagueId: 1, teamId: '1' })));
  globalThis.__api = null;
  assertNoLeak(html, 'PostDraftPlan (section errors)');
  assert.match(html, /Self-scout isn/);
  assert.match(html, /Trade suggestions aren/);
  assert.equal(seen.filter(s => s.includes('nfl_availability_role_rates')).length >= 2, true);
});

test('ModelRegistryPanel: a failed fetch is logged, not rendered', async () => {
  const { default: C } = await import(compile('features/model-lab/ModelRegistryPanel.tsx', [["'../../api'", apiUrl]]));
  globalThis.__api = { data: null, loading: false, error: LEAKY, refetch: () => {} };
  const { out: html, seen } = captureConsole(() => renderToStaticMarkup(React.createElement(C)));
  globalThis.__api = null;
  assertNoLeak(html, 'ModelRegistryPanel');
  assert.match(html, /Model registry is unavailable/);
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')));
});

test('NewsHub: the error prop is logged, not rendered', async () => {
  const { default: C } = await import(compile('features/news/NewsHub.tsx',
    [["'react'", reactUrl], ["'react-router-dom'", linkUrl], ["'../../api'", apiUrl], ["'./useNewsFeed'", newsFeedUrl]]));
  const { out: html, seen } = captureConsole(() => renderToStaticMarkup(React.createElement(C, { stories: [], error: LEAKY })));
  assertNoLeak(html, 'NewsHub');
  assert.match(html, /News is degraded/);
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')));
});
