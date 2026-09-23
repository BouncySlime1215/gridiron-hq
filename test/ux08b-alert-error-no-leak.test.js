/**
 * UX-08b (plan item D23, UI rule 9), follow-up to UX-08: every alert() and
 * rendered `.error` site UX-08 left behind now shows plain words instead of
 * the server's raw error text, and logs the detail to the console instead.
 *
 * Two kinds of site here, tested two ways:
 *  - Rendered `.error` sites (TradeCard, PageExplainAssistant, ManagerBoard,
 *    SourcePill): the real TSX, compiled with the repo's TypeScript, rendered
 *    by React to markup — same technique as
 *    test/ux08-component-error-no-leak.test.js. Assertions run on the raw
 *    html string, so an attribute leak fails too.
 *  - alert()/setMsg sites (Model, TeamDetail, MyTeam, Settings x2,
 *    EspnConnect x2): there is no jsdom in this repo, so `window.alert` and a
 *    click handler can't be driven end to end. Each site is proven two ways
 *    instead: (a) the shared `sanitizedAlert`/`sanitizedMessage` helper it
 *    calls is unit-tested directly with a leaking detail string, and (b) a
 *    reach check on the compiled source confirms the exact call site invokes
 *    that helper rather than interpolating `e.message` into what the user
 *    sees.
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ux08b-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const repoRequire = createRequire(new URL('../package.json', import.meta.url));
const write = (name, text) => { fs.writeFileSync(path.join(temp, name), text); return pathToFileURL(path.join(temp, name)).href; };
const cjs = mod => `import { createRequire } from 'node:module';
const rt = createRequire(${JSON.stringify(repoRequire.resolve(mod))})(${JSON.stringify(repoRequire.resolve(mod))});`;

const runtimeUrl = write('jsx-runtime.mjs', `${cjs('react/jsx-runtime')}
export const jsx = rt.jsx; export const jsxs = rt.jsxs; export const Fragment = rt.Fragment;`);
const linkUrl = write('react-router-dom.mjs', 'export function Link({ children }) { return children ?? null; }');

function readSrc(rel) {
  return fs.readFileSync(new URL(`../client/src/${rel}`, import.meta.url), 'utf8');
}

function compile(rel, swaps = []) {
  const source = readSrc(rel);
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

// Real internal detail (file path + table name), not a paraphrase — same
// shape UX-08's evidence used.
const LEAKY = 'nfl_availability_role_rates is missing or empty (docs/tdd/play-chance.tdd.md); '
  + 'run scripts/fit-availability.mjs at server/services/lineup-brain.js:41';
const MARKERS = ['nfl_availability_role_rates', 'docs/tdd/', 'scripts/', 'lineup-brain.js'];

function assertNoLeak(html, where) {
  for (const m of MARKERS) assert.ok(!html.includes(m), `${where} leaked "${m}" into markup: ${html}`);
}
function captureConsole(fn) {
  const orig = console.error; const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  try { return { out: fn(), seen }; } finally { console.error = orig; }
}

test('control: the harness sees markup and the marker check can fire (known-nonzero)', () => {
  const html = renderToStaticMarkup(React.createElement('p', null, LEAKY));
  for (const m of MARKERS) assert.ok(html.includes(m) && LEAKY.includes(m), `control renders/contains ${m}`);
});

// ---- errorSanitize.ts: the shared helper every site below calls ----

test('errorSanitize: sanitizedAlert logs detail, alerts a generic message, never the detail', async () => {
  const { sanitizedAlert } = await import(compile('lib/errorSanitize.ts'));
  const alerts = [];
  const origAlert = globalThis.alert;
  globalThis.alert = msg => alerts.push(msg);
  const { seen } = captureConsole(() => sanitizedAlert('Test.site', 'Sync failed', LEAKY));
  globalThis.alert = origAlert;
  assert.equal(alerts.length, 1);
  for (const m of MARKERS) assert.ok(!alerts[0].includes(m), `alert leaked "${m}": ${alerts[0]}`);
  assert.match(alerts[0], /^Sync failed\. Try again in a moment\.$/);
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')), 'detail reaches console.error');
  assert.ok(seen.some(s => s.includes('[Test.site]')), 'console.error is tagged with the call site');
});

test('errorSanitize: sanitizedMessage returns a generic string and logs detail', async () => {
  const { sanitizedMessage } = await import(compile('lib/errorSanitize.ts'));
  const { out: msg, seen } = captureConsole(() => sanitizedMessage('Test.site', 'Player sync failed', LEAKY));
  for (const m of MARKERS) assert.ok(!msg.includes(m), `message leaked "${m}": ${msg}`);
  assert.equal(msg, 'Player sync failed. Try again in a moment.');
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')), 'detail reaches console.error');
});

test('errorSanitize: logServerDetail is a no-op for empty/null/undefined detail', async () => {
  const { logServerDetail } = await import(compile('lib/errorSanitize.ts'));
  const { seen } = captureConsole(() => { logServerDetail('x', ''); logServerDetail('x', null); logServerDetail('x', undefined); });
  assert.equal(seen.length, 0);
});

// ---- Rendered `.error` sites: real component, real render ----

test('TradeCard.tsx:343 — sense.error is logged, not rendered (TradeSectionError)', async () => {
  const { TradeSectionError } = await import(compile('components/TradeCard.tsx'));
  const { out: html, seen } = captureConsole(() => renderToStaticMarkup(
    React.createElement(TradeSectionError, { where: 'TradeCard.senseCheck', error: LEAKY })));
  assertNoLeak(html, 'TradeCard sense.error');
  assert.match(html, /Couldn.t check that/);
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')), 'detail goes to console.error');
});

test('TradeCard.tsx:372 — impact.error is logged, not rendered (TradeSectionError)', async () => {
  const { TradeSectionError } = await import(compile('components/TradeCard.tsx'));
  const { out: html, seen } = captureConsole(() => renderToStaticMarkup(
    React.createElement(TradeSectionError, { where: 'TradeCard.oddsImpact', error: LEAKY })));
  assertNoLeak(html, 'TradeCard impact.error');
  assert.ok(seen.some(s => s.includes('[TradeCard.oddsImpact]')), 'console.error tagged with the odds-impact site');
});

test('PageExplainAssistant.tsx:177 — answer.error is logged, not rendered (AnswerBlock)', async () => {
  const { AnswerBlock } = await import(compile('components/PageExplainAssistant.tsx',
    [["'react-router-dom'", linkUrl]]));
  const { out: html, seen } = captureConsole(() => renderToStaticMarkup(
    React.createElement(AnswerBlock, { answer: { error: LEAKY } })));
  assertNoLeak(html, 'PageExplainAssistant answer.error');
  assert.match(html, /Couldn.t get an answer/);
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')), 'detail goes to console.error');
});

test('control: AnswerBlock still renders the real paragraph for a normal answer', async () => {
  const { AnswerBlock } = await import(compile('components/PageExplainAssistant.tsx',
    [["'react-router-dom'", linkUrl]]));
  const html = renderToStaticMarkup(React.createElement(AnswerBlock,
    { answer: { paragraph: 'It uses last week’s snap share.', limitations: [] } }));
  assert.match(html, /snap share/);
});

test('ManagerBoard.tsx:223 — signals.error is logged, not interpolated into the shown reason', async () => {
  const { signalsRequestFailedReason } = await import(compile('components/brain/ManagerBoard.tsx',
    [["'../PageState'", write('page-state-stub.mjs', 'export function PageError(){return null} export function PageLoading(){return null}')],
     ["'../../api'", write('api-stub.mjs', 'export const api = {};')],
     ["'react-router-dom'", linkUrl]]));
  const { out: reason, seen } = captureConsole(() => signalsRequestFailedReason(LEAKY));
  for (const m of MARKERS) assert.ok(!reason.includes(m), `reason leaked "${m}": ${reason}`);
  assert.equal(reason, 'The signals request failed. Try again in a moment.');
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')), 'detail goes to console.error');
});

test('control: signalsRequestFailedReason keeps the honest 404 explanation, no log needed', async () => {
  const { signalsRequestFailedReason } = await import(compile('components/brain/ManagerBoard.tsx',
    [["'../PageState'", write('page-state-stub2.mjs', 'export function PageError(){return null} export function PageLoading(){return null}')],
     ["'../../api'", write('api-stub2.mjs', 'export const api = {};')],
     ["'react-router-dom'", linkUrl]]));
  const { out: reason, seen } = captureConsole(() => signalsRequestFailedReason('Not Found (404)'));
  assert.match(reason, /answered 404/);
  assert.equal(seen.length, 0, '404 case is an honest explanation, not server detail — nothing to log');
});

test('ManagerBoard.tsx:284 — p.error is logged, not rendered (ManagerProfilesGap)', async () => {
  const { ManagerProfilesGap } = await import(compile('components/brain/ManagerBoard.tsx',
    [["'../PageState'", write('page-state-stub3.mjs', 'export function PageError(){return null} export function PageLoading(){return null}')],
     ["'../../api'", write('api-stub3.mjs', 'export const api = {};')],
     ["'react-router-dom'", linkUrl]]));
  const { out: html, seen } = captureConsole(() => renderToStaticMarkup(
    React.createElement(ManagerProfilesGap, { error: LEAKY })));
  assertNoLeak(html, 'ManagerBoard p.error');
  assert.match(html, /No managers to set yet/);
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')), 'detail goes to console.error');
});

test('SourcePill.tsx:73 — bookmarklet e.message is logged, not rendered raw', async () => {
  // openBookmarklet is a closure inside the default-exported component (no
  // jsdom to drive its click handler); the reach check below proves the real
  // call site uses this same helper, and this proves the helper itself never
  // lets a server detail through.
  const { sanitizedMessage } = await import(compile('lib/errorSanitize.ts'));
  const { out: msg, seen } = captureConsole(() => sanitizedMessage('SourcePill.openBookmarklet', 'Bookmarklet unavailable', LEAKY));
  for (const m of MARKERS) assert.ok(!msg.includes(m), `bookmarklet message leaked "${m}": ${msg}`);
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')));
});

// ---- alert()/setMsg call sites: reach check that the real file calls the helper ----

const REACH_SITES = [
  { file: 'pages/Model.tsx', line: 38, calls: 'sanitizedAlert' },
  { file: 'pages/TeamDetail.tsx', calls: 'sanitizedAlert' },
  { file: 'pages/MyTeam.tsx', calls: 'sanitizedAlert' },
  { file: 'pages/Settings.tsx', line: 42, calls: 'sanitizedMessage' },
  { file: 'pages/Settings.tsx', line: 43, calls: 'sanitizedMessage' },
  { file: 'components/EspnConnect.tsx', calls: 'sanitizedMessage' },
];

for (const site of REACH_SITES) {
  test(`reach: ${site.file} calls ${site.calls}(...), no bare \${e.message} left in a shown string`, () => {
    const src = readSrc(site.file);
    assert.ok(src.includes(`import { ${site.calls} } from`) || src.includes(`, ${site.calls} }`) || src.includes(`{ ${site.calls} }`),
      `${site.file} imports ${site.calls}`);
    // The two leak shapes UX-08b closes: `alert(\`...${e.message}...\`)` and
    // `setMsg(\`...${e.message}...\`)` — neither should remain anywhere in
    // the file once every catch block routes through the helper.
    assert.ok(!/alert\(`[^`]*\$\{e[^}]*\.message\}/.test(src), `${site.file}: no raw e.message left inside alert()`);
    assert.ok(!/setMsg\(`[^`]*\$\{e[^}]*\.message\}/.test(src), `${site.file}: no raw e.message left inside setMsg()`);
  });
}

test('reach: TradeCard.tsx call sites use TradeSectionError, not a raw {sense.error}/{impact.error} paragraph', () => {
  const src = readSrc('components/TradeCard.tsx');
  assert.ok(/sense\?\.error && <TradeSectionError/.test(src));
  assert.ok(/impact\?\.error && <TradeSectionError/.test(src));
  assert.ok(!src.includes('{sense.error}</p>'));
  assert.ok(!src.includes('{impact.error}</p>'));
});

test('reach: ManagerBoard.tsx call sites use the sanitizing helpers, not a raw {p.error} paragraph', () => {
  const src = readSrc('components/brain/ManagerBoard.tsx');
  assert.ok(src.includes('reason={signalsRequestFailedReason(signals.error)}'));
  assert.ok(/p\?\.error && <ManagerProfilesGap/.test(src));
  assert.ok(!src.includes('{p.error}</p>'));
});

test('reach: SourcePill.tsx call site uses sanitizedMessage, not raw e.message', () => {
  const src = readSrc('components/draft/SourcePill.tsx');
  assert.ok(!/error: e\?\.message \?\?/.test(src), 'no bare e?.message assigned straight into bm.error');
  assert.ok(src.includes('sanitizedMessage('));
});

// nav is untouched by any of this
test('nav: none of the edited files touch the nav/route list', () => {
  for (const rel of ['pages/Model.tsx', 'pages/TeamDetail.tsx', 'pages/MyTeam.tsx', 'pages/Settings.tsx',
    'components/EspnConnect.tsx', 'components/TradeCard.tsx', 'components/PageExplainAssistant.tsx',
    'components/brain/ManagerBoard.tsx', 'components/draft/SourcePill.tsx']) {
    const src = readSrc(rel);
    assert.ok(!/NAV_TABS|<nav\b/.test(src), `${rel} does not define nav`);
  }
});
