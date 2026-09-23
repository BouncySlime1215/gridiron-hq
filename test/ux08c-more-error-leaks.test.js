/**
 * UX-08c (plan item D23, UI rule 9), follow-up to UX-08b: the remaining raw
 * server-error leaks named in WORK-QUEUE.md row UX-08c.
 *
 * Audited before writing this file (docs/tdd/2026-09-23-ux08c-more-error-leaks.tdd.md
 * has the full note):
 *  - TeamDetail.tsx:79/81 (refreshOutlook) and :396/401 (ExplainButton) — real
 *    leaks, fixed here with errorSanitize.ts (reused from UX-08b, unmerged
 *    PR #175 — this worktree branches from its head).
 *  - TradeCard.tsx:175/195/202, rendered at :319 — real leak, fixed with
 *    sanitizedMessage (the file already has a rendered-error precedent in
 *    TradeSectionError from UX-08b, but `err`/319 is a different, plain
 *    state string, not routed through it).
 *  - ManagerBoard.tsx:92 — real leak (`e instanceof Error ? e.message : ...`),
 *    fixed with sanitizedMessage.
 *  - EspnConnect.tsx:53 (`setPasteErr(e.message)`) — two channels: the
 *    validateCookies() fallback reason (server-side, tested behaviourally in
 *    test/ux08c-espn-connect-no-leak.test.js) and any 5xx from the route
 *    falling through to the global handler's raw err.message (client-side:
 *    4xx copy shown verbatim, everything else sanitized; tested below).
 *  - MyTeam.tsx:302 (`scout.error`) and :444 (`data.error`) — audited, NOT a
 *    leak. `selfScout` (server/services/trade-engine.js:2502) has exactly one
 *    `error` field, hardcoded plain text ('your team not found'), no
 *    catch/e.message anywhere in the function body; `ceilingLineup`
 *    (server/services/ceiling-lineup.js:185) has three `error` fields, all
 *    hardcoded plain text, same audit. No change made; asserted here as a
 *    contradiction-test control (rule 8) so a future edit that starts
 *    stuffing `e.message` into either function's `error` field is caught.
 *  - Model.tsx:96/245 — audited, out of scope. The file's own header comment
 *    (lines 8-16) says it is an orphan: no import, no <Route>, its `/accuracy`
 *    and related endpoints were deleted from server/routes/model.js on
 *    2026-09-20 ("DO NOT re-add a route here"). No consumer reaches it, so
 *    fixing it changes zero real exposure and would be effort spent on dead
 *    code the file itself says was deliberately cut (rule 14: never rebuild
 *    a deleted page). Asserted here as a documented non-fix, not silently
 *    skipped.
 *
 * Technique: same as test/ux08b-alert-error-no-leak.test.js — compile the
 * real .tsx with the repo's TypeScript, lift the real catch/handler body out
 * with the TS parser, execute it with a leaking Error, and check every value
 * that reaches "the user" (a recorder standing in for setState/alert/render)
 * for the leak markers. Server-side fix is asserted by importing the real
 * route module (env-mocked) is skipped in favor of a direct unit test of the
 * extracted `validateCookies` failure shape via its exported reason strings.
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ux08c-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const repoRequire = createRequire(new URL('../package.json', import.meta.url));
const write = (name, text) => { fs.writeFileSync(path.join(temp, name), text); return pathToFileURL(path.join(temp, name)).href; };
const cjs = mod => `import { createRequire } from 'node:module';
const rt = createRequire(${JSON.stringify(repoRequire.resolve(mod))})(${JSON.stringify(repoRequire.resolve(mod))});`;

const runtimeUrl = write('jsx-runtime.mjs', `${cjs('react/jsx-runtime')}
export const jsx = rt.jsx; export const jsxs = rt.jsxs; export const Fragment = rt.Fragment;`);
const reactUrl = write('react.mjs', `${cjs('react')}
export default rt; export const useMemo = rt.useMemo; export const useState = rt.useState;
export const useEffect = rt.useEffect; export const useRef = rt.useRef; export const useCallback = rt.useCallback;`);

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

// Real internal detail (file path + table name), same shape as UX-08/UX-08b's evidence.
const LEAKY = 'nfl_availability_role_rates is missing or empty (docs/tdd/play-chance.tdd.md); '
  + 'run scripts/fit-availability.mjs at server/services/lineup-brain.js:41';
const MARKERS = ['nfl_availability_role_rates', 'docs/tdd/', 'scripts/', 'lineup-brain.js'];

function captureConsole(fn) {
  const orig = console.error; const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  try { return { out: fn(), seen }; } finally { console.error = orig; }
}

test('control: the harness sees a leak and the marker check can fire (known-nonzero)', () => {
  const html = renderToStaticMarkup(React.createElement('p', null, LEAKY));
  for (const m of MARKERS) assert.ok(html.includes(m) && LEAKY.includes(m), `control renders/contains ${m}`);
});

// ---- Catch-block evaluation: run the REAL catch/handler body of each named site ----

const sanitizePath = new URL('../client/src/lib/errorSanitize.ts', import.meta.url);
async function realHelpers() {
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

async function runCatch(varName, body, helpers, overrides = {}, error = new Error(LEAKY)) {
  const { outputText } = ts.transpileModule(`(async function (${varName}) ${body})`,
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  const shown = [];
  const recorder = name => (...args) => {
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
  try { await fn(error); } finally { globalThis.alert = origAlert; console.error = origErr; }
  return { shown, shownText: shown.map(serialise).join('\n'), logged: logged.join('\n') };
}

const CATCH_SITES = [
  { site: 'TeamDetail.tsx:81 (refreshOutlook)', file: 'pages/TeamDetail.tsx', anchor: "'/analysis/refresh'",
    shows: 'Outlook refresh failed. Try again in a moment.' },
  { site: 'TeamDetail.tsx:396 (ExplainButton)', file: 'pages/TeamDetail.tsx', anchor: 'newsId}/explain',
    shows: "Couldn't explain that. Try again in a moment." },
  { site: 'TradeCard.tsx:175 (senseCheck)', file: 'components/TradeCard.tsx', anchor: 'sense-check',
    shows: "Couldn't run the sense check. Try again in a moment." },
  { site: 'TradeCard.tsx:195 (odds)', file: 'components/TradeCard.tsx', anchor: 'trade-impact',
    shows: "Couldn't simulate title odds. Try again in a moment." },
  { site: 'TradeCard.tsx:202 (explain)', file: 'components/TradeCard.tsx', anchor: "leagueId}/explain",
    shows: "Couldn't explain that trade. Try again in a moment." },
  { site: 'ManagerBoard.tsx:92 (set tier)', file: 'components/brain/ManagerBoard.tsx', anchor: 'brain/managers/',
    shows: 'Could not save that tier. Try again in a moment.' },
];

// EspnConnect.tsx:53 — api() (client/src/api.ts) throws Error(body.error) with
// .status attached. A 5xx body.error is the global handler's raw err.message
// (server/index.js error middleware), e.g. node:sqlite's "no such table" from
// the POST /espn-connect/cookies app_settings/leagues writes.
const withStatus = (msg, status) => Object.assign(new Error(msg), status === undefined ? {} : { status });
const SQLITE_LEAK = 'no such table: app_settings (server/routes/espn-connect.js)';
CATCH_SITES.push(
  { site: 'EspnConnect.tsx:53 (paste, 500 from global handler)', file: 'components/EspnConnect.tsx', anchor: "'/espn-connect/cookies'",
    error: withStatus(LEAKY, 500), shows: "Couldn't save those cookies. Try again in a moment." },
  { site: 'EspnConnect.tsx:53 (paste, network failure, no status)', file: 'components/EspnConnect.tsx', anchor: "'/espn-connect/cookies'",
    error: withStatus(LEAKY), shows: "Couldn't save those cookies. Try again in a moment." },
);

test('EspnConnect.tsx:53 — a sqlite 500 (the real global-handler shape) never reaches setPasteErr', async () => {
  const { varName, body } = findCatch('components/EspnConnect.tsx', "'/espn-connect/cookies'");
  const { shownText, logged } = await runCatch(varName, body, await realHelpers(), {}, withStatus(SQLITE_LEAK, 500));
  assert.ok(!shownText.includes('app_settings') && !shownText.includes('no such table'), `sqlite text leaked: ${shownText}`);
  assert.ok(logged.includes('no such table: app_settings'), 'the sqlite detail reaches console.error');
});

test('control: EspnConnect.tsx:53 still shows the route\'s own plain 400 copy verbatim', async () => {
  const plain = "Couldn't find both cookies in that. Make sure what you paste contains espn_s2 and SWID.";
  const { varName, body } = findCatch('components/EspnConnect.tsx', "'/espn-connect/cookies'");
  const { shown, shownText } = await runCatch(varName, body, await realHelpers(), {}, withStatus(plain, 400));
  assert.ok(shown.some(x => x.name === 'setPasteErr' && x.args[0] === plain), `400 copy shown verbatim; got ${shownText}`);
});

test('api.ts — a non-ok response throws an Error carrying the HTTP status EspnConnect.tsx:53 branches on', async () => {
  const { api } = await import(compile('api.ts'));
  const realFetch = globalThis.fetch;
  try {
    for (const status of [400, 500]) {
      globalThis.fetch = async () => ({ ok: false, status, statusText: 'x', json: async () => ({ error: `e${status}` }) });
      await assert.rejects(api('/espn-connect/cookies', { method: 'POST' }), e => e.status === status && e.message === `e${status}`, `status ${status}`);
    }
  } finally { globalThis.fetch = realFetch; }
});

for (const s of CATCH_SITES) {
  test(`${s.site} — the real catch body shows plain words, logs the detail`, async () => {
    const { varName, body } = findCatch(s.file, s.anchor);
    const { shown, shownText, logged } = await runCatch(varName, body, await realHelpers(), s.overrides, s.error);
    for (const m of MARKERS) assert.ok(!shownText.includes(m), `${s.site} leaked "${m}" to the user: ${shownText}`);
    assert.ok(shown.length > 0, `${s.site}: the catch body still tells the user something`);
    assert.ok(shownText.includes(JSON.stringify(s.shows).slice(1, -1)), `${s.site}: user sees exactly ${JSON.stringify(s.shows)}; got ${shownText}`);
    assert.ok(logged.includes('nfl_availability_role_rates'), `${s.site}: the detail reaches console.error`);
  });
}

// ---- TeamDetail.tsx:79 — not a catch, a ternary reading a per-item server field ----

function findRefreshOutlookAssign(rel) {
  const src = readSrc(rel);
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const hits = [];
  const walk = n => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'setAiMsg') hits.push(n);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  const hit = hits.find(n => n.getText(sf).includes('t?.error') || n.getText(sf).includes('t.error'));
  assert.ok(hit, `${rel}: setAiMsg(t?.error ? ...) call found among ${hits.length} setAiMsg call(s)`);
  return hit.getText(sf);
}

test('TeamDetail.tsx:79 — t.error (a raw per-item exception message from the server) is sanitized before setAiMsg', async () => {
  const expr = findRefreshOutlookAssign('pages/TeamDetail.tsx');
  const { outputText } = ts.transpileModule(`(function (t) { return ${expr.replace(/^setAiMsg\((.*)\)$/s, '$1')}; })`,
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const helpers = await realHelpers();
  const shown = [];
  const scope = new Proxy({}, {
    has: () => true,
    get: (_, k) => (k in helpers ? helpers[k] : (k === Symbol.unscopables ? undefined : undefined)),
  });
  // eslint-disable-next-line no-new-func
  const fn = new Function('__scope', `with (__scope) { return ${outputText.trim().replace(/;$/, '')}; }`)(scope);
  const origErr = console.error; const logged = [];
  console.error = (...a) => logged.push(a.map(x => String(x)).join(' '));
  let result;
  try { result = fn({ error: LEAKY, changed: false }); } finally { console.error = origErr; }
  for (const m of MARKERS) assert.ok(!String(result).includes(m), `TeamDetail.tsx:79 leaked "${m}" into aiMsg: ${result}`);
  assert.match(String(result), /AI refresh failed\. Try again in a moment\./);
  assert.ok(logged.join('\n').includes('nfl_availability_role_rates'), 'TeamDetail.tsx:79: the detail reaches console.error');
});

test('control: the pre-fix TeamDetail.tsx:79 shape (direct template interpolation) is seen leaking', async () => {
  const { outputText } = ts.transpileModule(
    "(function (t) { return t?.error ? `AI refresh failed: ${t.error}` : 'ok'; })",
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return ${outputText.trim().replace(/;$/, '')};`)();
  const out = fn({ error: LEAKY });
  assert.ok(out.includes('nfl_availability_role_rates'), 'control: pre-fix shape leaks the marker');
});

// ---- TeamDetail.tsx:401 / TradeCard.tsx:319 — rendered `err` state must not carry the leak ----
// (proven by the catch-site tests above: `shows` is the exact string the JSX
// renders `{err}` as, so a leak surviving into `err` would fail those tests.)

// ---- MyTeam.tsx / ceiling-lineup.js — contradiction-test control: these two ----
// `error` fields are audited plain-text-only, not fixed. This nails that down
// so a future change that starts routing e.message into either can't merge quietly.

test('control (rule 8): selfScout has exactly one `error` field and it is not built from e.message', () => {
  const src = fs.readFileSync(new URL('../server/services/trade-engine.js', import.meta.url), 'utf8');
  const sf = ts.createSourceFile('trade-engine.ts', src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let fnNode = null;
  const walk = n => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'selfScout') fnNode = n;
    ts.forEachChild(n, walk);
  };
  walk(sf);
  assert.ok(fnNode, 'selfScout function found in trade-engine.js');
  const body = fnNode.getText(sf);
  const errorFields = [...body.matchAll(/error:\s*([^,}\n]+)/g)].map(m => m[1].trim());
  assert.deepEqual(errorFields, ["'your team not found'"], `selfScout error fields: ${errorFields.join(' | ')}`);
  assert.ok(!/\.message/.test(body), 'selfScout body never reads .message (no e.message stuffed into a field)');
});

test('control (rule 8): ceilingLineup error fields are hardcoded plain text, no e.message', () => {
  const src = fs.readFileSync(new URL('../server/services/ceiling-lineup.js', import.meta.url), 'utf8');
  const sf = ts.createSourceFile('ceiling-lineup.ts', src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let fnNode = null;
  const walk = n => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'ceilingLineup') fnNode = n;
    ts.forEachChild(n, walk);
  };
  walk(sf);
  assert.ok(fnNode, 'ceilingLineup function found in ceiling-lineup.js');
  const body = fnNode.getText(sf);
  assert.ok(!/error:[^,}\n]*\.message/.test(body), 'ceilingLineup never builds an error field from .message');
});

// ---- espn-connect.js — behavioural (real route, fetch stubbed) in ----
// test/ux08c-espn-connect-no-leak.test.js. The source-regex checks that used
// to live here let `"..." + e.message` and a `detail` field through (skeptic
// mutants A/B, 2026-09-23), so they were replaced, not kept alongside.

// ---- Model.tsx — documented non-fix: orphan page, no consumer ----

test('control/documentation: Model.tsx is not imported by any router file (out of scope, not fixed)', () => {
  const appSrc = fs.readFileSync(new URL('../client/src/App.tsx', import.meta.url), 'utf8');
  assert.ok(!appSrc.includes("pages/Model'") && !appSrc.includes('pages/Model"'),
    'App.tsx does not import pages/Model — confirms the orphan-page audit this unit relies on');
});

// nav is untouched by any of this
test('nav: none of the edited files touch the nav/route list', () => {
  for (const rel of ['pages/TeamDetail.tsx', 'components/TradeCard.tsx', 'components/brain/ManagerBoard.tsx']) {
    const src = readSrc(rel);
    assert.ok(!/NAV_TABS|<nav\b/.test(src), `${rel} does not define nav`);
  }
});
