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
const reactUrl = write('react.mjs', `${cjs('react')}
export default rt; export const useMemo = rt.useMemo; export const useState = rt.useState;
export const useEffect = rt.useEffect; export const useRef = rt.useRef;`);
const linkUrl = write('react-router-dom.mjs', 'export function Link({ children }) { return children ?? null; }');
// Generic "this module isn't under test, just needs to exist" stub: named
// exports resolve to no-op functions and a no-op default, so a real file's
// unrelated imports don't blow up the module graph.
let stubCounter = 0;
function namedStub(names) {
  return write(`stub-${stubCounter++}.mjs`,
    names.map(n => `export const ${n} = (...a) => {};`).join('\n') + `\nexport default (...a) => {};`);
}

function readSrc(rel) {
  return fs.readFileSync(new URL(`../client/src/${rel}`, import.meta.url), 'utf8');
}

function compile(rel, swaps = []) {
  const source = readSrc(rel);
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  let compiled = outputText;
  for (const [from, to, optional] of [...swaps, ['"react/jsx-runtime"', runtimeUrl, true], ["'react'", reactUrl, true]]) {
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

const errorSanitizeUrl = () => compile('lib/errorSanitize.ts');

const tradeCardSwaps = () => [
  ["'../lib/errorSanitize'", errorSanitizeUrl()],
  ["'../api'", namedStub(['api', 'headshotUrl'])],
  ["'./PlayerCard'", namedStub(['usePlayerCard'])],
  ["'./PlayerRow'", namedStub(['Headshot'])],
  ["'./trade/ManagerRead'", namedStub([])],
  ["'./trade/PlayerEvidence'", namedStub([])],
  ["'./trade/RiskStrip'", namedStub([])],
  ["'./warroom/HisScreen'", namedStub([])],
  ["'./trade/SentOfferButton'", namedStub([])],
  ["'./trade/types'", namedStub(['hasEvidence'])],
];

test('TradeCard.tsx:343 — sense.error is logged, not rendered (TradeSectionError)', async () => {
  const { TradeSectionError } = await import(compile('components/TradeCard.tsx', tradeCardSwaps()));
  const { out: html, seen } = captureConsole(() => renderToStaticMarkup(
    React.createElement(TradeSectionError, { where: 'TradeCard.senseCheck', error: LEAKY })));
  assertNoLeak(html, 'TradeCard sense.error');
  assert.match(html, /Couldn(&#x27;|')t check that/);
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')), 'detail goes to console.error');
});

test('TradeCard.tsx:372 — impact.error is logged, not rendered (TradeSectionError)', async () => {
  const { TradeSectionError } = await import(compile('components/TradeCard.tsx', tradeCardSwaps()));
  const { out: html, seen } = captureConsole(() => renderToStaticMarkup(
    React.createElement(TradeSectionError, { where: 'TradeCard.oddsImpact', error: LEAKY })));
  assertNoLeak(html, 'TradeCard impact.error');
  assert.ok(seen.some(s => s.includes('[TradeCard.oddsImpact]')), 'console.error tagged with the odds-impact site');
});

const pageExplainSwaps = () => [
  ["'../lib/errorSanitize'", errorSanitizeUrl()],
  ["'react-router-dom'", namedStub(['useLocation'])],
  ["'../api'", namedStub(['api', 'useApi'])],
  ["'../copy-constants'", namedStub(['NOT_PROVEN_MESSAGE'])],
];

test('PageExplainAssistant.tsx:177 — answer.error is logged, not rendered (AnswerBlock)', async () => {
  const { AnswerBlock } = await import(compile('components/PageExplainAssistant.tsx', pageExplainSwaps()));
  const { out: html, seen } = captureConsole(() => renderToStaticMarkup(
    React.createElement(AnswerBlock, { answer: { error: LEAKY } })));
  assertNoLeak(html, 'PageExplainAssistant answer.error');
  assert.match(html, /Couldn(&#x27;|')t get an answer/);
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')), 'detail goes to console.error');
});

test('control: AnswerBlock still renders the real paragraph for a normal answer', async () => {
  const { AnswerBlock } = await import(compile('components/PageExplainAssistant.tsx', pageExplainSwaps()));
  const html = renderToStaticMarkup(React.createElement(AnswerBlock,
    { answer: { paragraph: 'It uses last week’s snap share.', limitations: [] } }));
  assert.match(html, /snap share/);
});

const managerBoardSwaps = () => [
  ["'../../lib/errorSanitize'", errorSanitizeUrl()],
  ["'../PageState'", namedStub(['PageError', 'PageLoading'])],
  ["'../../api'", namedStub(['api'])],
  ["'./types'", namedStub(['TIERS', 'TIER_SHORT', 'TIER_STYLE', 'MIN_OBSERVATIONS', 'isThin', 'asText', 'metricLabel'])],
  ["'react-router-dom'", linkUrl],
];

test('ManagerBoard.tsx:223 — signals.error is logged, not interpolated into the shown reason', async () => {
  const { signalsRequestFailedReason } = await import(compile('components/brain/ManagerBoard.tsx', managerBoardSwaps()));
  const { out: reason, seen } = captureConsole(() => signalsRequestFailedReason(LEAKY));
  for (const m of MARKERS) assert.ok(!reason.includes(m), `reason leaked "${m}": ${reason}`);
  assert.equal(reason, 'The signals request failed. Try again in a moment.');
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')), 'detail goes to console.error');
});

test('control: signalsRequestFailedReason keeps the honest 404 explanation, no log needed', async () => {
  const { signalsRequestFailedReason } = await import(compile('components/brain/ManagerBoard.tsx', managerBoardSwaps()));
  const { out: reason, seen } = captureConsole(() => signalsRequestFailedReason('Not Found (404)'));
  assert.match(reason, /answered 404/);
  assert.equal(seen.length, 0, '404 case is an honest explanation, not server detail — nothing to log');
});

test('ManagerBoard.tsx:284 — p.error is logged, not rendered (ManagerProfilesGap)', async () => {
  const { ManagerProfilesGap } = await import(compile('components/brain/ManagerBoard.tsx', managerBoardSwaps()));
  const { out: html, seen } = captureConsole(() => renderToStaticMarkup(
    React.createElement(ManagerProfilesGap, { error: LEAKY })));
  assertNoLeak(html, 'ManagerBoard p.error');
  assert.match(html, /No managers to set yet/);
  assert.ok(seen.some(s => s.includes('nfl_availability_role_rates')), 'detail goes to console.error');
});

// ---- Catch-block evaluation: run the REAL catch body of each named site ----
//
// No jsdom here, so the click handler can't be driven. Instead the exact
// catch clause of each named try block is lifted out of the real .tsx with
// the TypeScript parser, transpiled, and executed with `e = new Error(LEAKY)`.
// Every free identifier it touches (alert, setMsg, setBm, ...) is a recorder;
// the real errorSanitize helpers are wired in when the file exists. Whatever
// the catch body hands to anything the user can see is serialised and checked
// for the markers — so concatenation, ternaries, String(e), optional chaining
// or a helper that's imported but not called all fail, not just one regex shape.

const sanitizePath = new URL('../client/src/lib/errorSanitize.ts', import.meta.url);
async function realHelpers() {
  // On the pre-fix tree the helper file doesn't exist; the catch bodies then
  // run against recorders only, so RED shows the leak itself, not an ENOENT.
  if (!fs.existsSync(sanitizePath)) return {};
  return import(compile('lib/errorSanitize.ts'));
}

function findCatch(rel, anchor) {
  const src = readSrc(rel);
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const hits = [];
  const walk = n => {
    if (ts.isTryStatement(n) && n.catchClause && n.tryBlock.getText(sf).includes(anchor)) hits.push(n.catchClause);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  assert.equal(hits.length, 1, `${rel}: exactly one try block contains ${JSON.stringify(anchor)}`);
  const cc = hits[0];
  return { varName: cc.variableDeclaration?.name.getText(sf) ?? '_e', body: cc.block.getText(sf) };
}

function serialise(v) {
  return JSON.stringify(v, (k, x) => (x instanceof Error ? `${String(x)} ${x.message}` : typeof x === 'function' ? String(x) : x));
}

async function runCatch(varName, body, helpers, overrides = {}) {
  const { outputText } = ts.transpileModule(`(async function (${varName}) ${body})`,
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  const shown = []; // every call the catch body (or a helper) makes that reaches the user
  const recorder = name => (...args) => {
    // functional state updates (setX(prev => ...)) — record what they'd store
    shown.push({ name, args: args.map(a => (typeof a === 'function' ? a({}) : a)) });
  };
  const scope = new Proxy({}, {
    has: (_, k) => typeof k === 'string' && (k === 'alert' || !(k in globalThis)),
    get: (_, k) => {
      if (k === Symbol.unscopables) return undefined;
      if (k in overrides) return overrides[k];
      if (k in helpers) return helpers[k];
      return recorder(k);
    },
  });
  // eslint-disable-next-line no-new-func
  const fn = new Function('__scope', `with (__scope) { return ${outputText.trim().replace(/;$/, '')}; }`)(scope);
  const origAlert = globalThis.alert;
  globalThis.alert = recorder('alert');
  const origErr = console.error; const logged = [];
  console.error = (...a) => logged.push(a.map(x => String(x)).join(' '));
  try { await fn(new Error(LEAKY)); } finally { globalThis.alert = origAlert; console.error = origErr; }
  return { shown, shownText: shown.map(serialise).join('\n'), logged: logged.join('\n') };
}

test('control: the catch evaluator sees a leak in the pre-fix Model.tsx shape and in a concatenation variant', async () => {
  for (const body of ['{ alert(`Sync failed: ${e.message}`); }', "{ alert('Sync failed: ' + e.message); }",
    '{ setMsg(silent ? `ESPN could not refresh your leagues: ${e.message}` : e.message); }']) {
    for (const silent of [true, false]) {
      const { shownText } = await runCatch('e', body, {}, { silent });
      assert.ok(shownText.includes('nfl_availability_role_rates'), `control body ${body} (silent=${silent}) must be seen leaking`);
    }
  }
});

// Each named site: file, an anchor unique to its try block, what the user must see.
const CATCH_SITES = [
  { site: 'Model.tsx:38', file: 'pages/Model.tsx', anchor: "'/model/sync'", shows: 'Sync failed. Try again in a moment.' },
  { site: 'TeamDetail.tsx:69', file: 'pages/TeamDetail.tsx', anchor: '/espn/sync-news?team=', shows: 'News pull failed. Try again in a moment.' },
  { site: 'MyTeam.tsx:86', file: 'pages/MyTeam.tsx', anchor: 'refetchData(); refetchLeagues()', shows: 'Sync failed. Try again in a moment.' },
  { site: 'Settings.tsx:42', file: 'pages/Settings.tsx', anchor: "'/espn/sync-players'", shows: 'Player sync failed. Try again in a moment.' },
  { site: 'Settings.tsx:50', file: 'pages/Settings.tsx', anchor: "'/espn/sync-news'", shows: 'News sync failed. Try again in a moment.' },
  { site: 'EspnConnect.tsx:64 (silent)', file: 'components/EspnConnect.tsx', anchor: "'/espn-connect/discover'", overrides: { silent: true },
    shows: 'ESPN could not refresh your leagues. Try again in a moment.' },
  { site: 'EspnConnect.tsx:64 (not silent)', file: 'components/EspnConnect.tsx', anchor: "'/espn-connect/discover'", overrides: { silent: false },
    shows: 'ESPN league lookup failed. Try again in a moment.' },
  { site: 'EspnConnect.tsx:102', file: 'components/EspnConnect.tsx', anchor: "'/espn-connect/add'",
    shows: 'Added, but the first sync failed. Try “Sync” in League Hub → Connections. Try again in a moment.' },
  { site: 'SourcePill.tsx:45', file: 'components/draft/SourcePill.tsx', anchor: 'capture-bookmarklet',
    shows: 'Bookmarklet unavailable. Try again in a moment.' },
];

for (const s of CATCH_SITES) {
  test(`${s.site} — the real catch body shows plain words, logs the detail`, async () => {
    const { varName, body } = findCatch(s.file, s.anchor);
    const { shown, shownText, logged } = await runCatch(varName, body, await realHelpers(), s.overrides);
    for (const m of MARKERS) assert.ok(!shownText.includes(m), `${s.site} leaked "${m}" to the user: ${shownText}`);
    assert.ok(shown.length > 0, `${s.site}: the catch body still tells the user something`);
    assert.ok(shownText.includes(JSON.stringify(s.shows).slice(1, -1)), `${s.site}: user sees exactly ${JSON.stringify(s.shows)}; got ${shownText}`);
    assert.ok(logged.includes('nfl_availability_role_rates'), `${s.site}: the detail reaches console.error`);
  });
}

// ---- Rendered sites: token-level check over the whole file ----
//
// In the four files with rendered `.error` sites, every `x.error` / `x?.error`
// read must sit in a position that can't put its text on screen: a condition
// (`x.error && ...` left side, `!x.error`, ternary/if test), an argument to a
// sanitizing helper, or the `error` prop of a component that logs instead of
// rendering. Anything else — a JSX child, another prop, a template string, a
// setter — fails. This catches a new sibling `<p>{impact?.error}</p>`, not
// just the one line that used to leak.

const SAFE_CALLS = new Set(['logServerDetail', 'sanitizedMessage', 'sanitizedAlert', 'signalsRequestFailedReason']);
const SAFE_PROPS = new Set(['TradeSectionError.error', 'ManagerProfilesGap.error']);

function unsafeErrorReads(rel) {
  const src = readSrc(rel);
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const bad = [];
  const verdict = node => {
    let cur = node;
    for (;;) {
      const p = cur.parent;
      if (!p) return 'unknown';
      if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p)
        || ts.isTemplateSpan(p) || ts.isTemplateExpression(p)) { cur = p; continue; }
      if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return null;
      if (ts.isBinaryExpression(p)) {
        const op = p.operatorToken.kind;
        if ((op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) && p.left === cur) return null;
        if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(op)) return null;
        cur = p; continue; // right side of &&/||/??, string +: the value flows on
      }
      if (ts.isConditionalExpression(p)) { if (p.condition === cur) return null; cur = p; continue; }
      if (ts.isIfStatement(p) && p.expression === cur) return null;
      if (ts.isCallExpression(p) && p.arguments.includes(cur)) {
        return SAFE_CALLS.has(p.expression.getText(sf)) ? null : `argument to ${p.expression.getText(sf)}()`;
      }
      if (ts.isPropertyAccessExpression(p) && p.expression === cur) { cur = p; continue; }
      if (ts.isJsxExpression(p)) {
        const gp = p.parent;
        if (ts.isJsxAttribute(gp)) {
          const tag = gp.parent.parent.tagName.getText(sf);
          const key = `${tag}.${gp.name.getText(sf)}`;
          return SAFE_PROPS.has(key) ? null : `prop ${key}`;
        }
        return 'JSX child (rendered)';
      }
      return `unhandled position (${ts.SyntaxKind[p.kind]})`;
    }
  };
  const walk = n => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'error') {
      const why = verdict(n);
      if (why) bad.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.getText(sf)} — ${why}`);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return bad;
}

test('control: the token check flags the pre-fix and the skeptic-variant shapes', () => {
  const tmpRel = 'ux08b-control.tsx';
  const p = new URL(`../client/src/${tmpRel}`, import.meta.url);
  fs.writeFileSync(p, `export const A = ({ sense, impact, p, signals }: any) => <div>
    {sense?.error && <p className="x">{sense.error}</p>}
    {impact?.error && <p className="x">{impact?.error}</p>}
    <S reason={\`The signals request failed: \${signals.error}.\`} />
    <PageError message={p.error} />
  </div>;`);
  try {
    const bad = unsafeErrorReads(tmpRel);
    assert.equal(bad.length, 4, `all four leak shapes flagged: ${bad.join('; ')}`);
  } finally { fs.rmSync(p, { force: true }); }
});

for (const rel of ['components/TradeCard.tsx', 'components/PageExplainAssistant.tsx',
  'components/brain/ManagerBoard.tsx', 'components/draft/SourcePill.tsx']) {
  test(`token check: no .error read in ${rel} can reach the screen`, () => {
    const bad = unsafeErrorReads(rel);
    assert.deepEqual(bad, [], `unsafe .error reads:\n${bad.join('\n')}`);
  });
}

test('reach: TradeCard/ManagerBoard call sites actually route through the logging components', () => {
  const tc = readSrc('components/TradeCard.tsx');
  assert.ok(/sense\?\.error && <TradeSectionError/.test(tc));
  assert.ok(/impact\?\.error && <TradeSectionError/.test(tc));
  const mb = readSrc('components/brain/ManagerBoard.tsx');
  assert.ok(mb.includes('reason={signalsRequestFailedReason(signals.error)}'));
  assert.ok(/p\?\.error && <ManagerProfilesGap/.test(mb));
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
