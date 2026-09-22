/**
 * The data licences the app depends on ask for a visible credit, and nothing on
 * screen gives one.
 *
 * nflverse-data is CC BY 4.0 (its master/LICENSE.md). FTN's charting, which
 * nflverse redistributes and `ingestCharting` loads into `nfl_play_charting`, is
 * CC BY-SA 4.0 and must be credited as "FTN Data via nflverse" (nflreadr's
 * R/load_ftn_charting.R). ffopportunity's expected-points data is CC BY-SA 4.0
 * (its README, "Terms of Use"), although its descriptor here said CC BY 4.0.
 * Each licence's one real obligation is attribution: name the source, link the
 * licence, say the data was changed.
 *
 * The obvious home, the freshness banner, returns null when every table is
 * current or the banner was dismissed (DataFreshnessBanner.tsx, the
 * `if (!report || report.all_fresh || dismissed) return null` line), so a
 * credit inside it would be gone on exactly the days the data is healthy.
 * These tests render the components for real (TSX transpiled with the repo's
 * own TypeScript, rendered with react-dom/server) in those states, and hold the
 * credit's list to the `sources` the freshness route serves, so the two cannot
 * drift apart.
 *
 * react-dom/server runs no effects and has no `window`, and stripped text says
 * nothing about CSS, so three things it cannot see are pinned another way: the
 * credit is stateless (called outside a render, swept across browser states,
 * and read from source, closures included), no element of it is hidden, and
 * App mounts it as a plain sibling of <main> (read with the TypeScript AST).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-data-credit-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
delete process.env.NFL_WEEK;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const requireFromTest = createRequire(import.meta.url);

const { db } = await import('../server/db/index.js');
const { FFOPPORTUNITY_SOURCE } = await import('../server/services/ffopportunity.js');
const { default: dataFreshnessRouter } = await import('../server/routes/data-freshness.js');

const app = express();
app.use('/api/data-freshness', dataFreshnessRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const BY = 'https://creativecommons.org/licenses/by/4.0/';
const BY_SA = 'https://creativecommons.org/licenses/by-sa/4.0/';

/** A module that does not exist yet is an assertion failure, not a crash of the whole file. */
async function optionalImport(specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  }
}

/**
 * The banner file, transpiled by the repo's TypeScript and imported as ESM.
 * `../api` is replaced by a stub whose `useApi` answers from
 * `globalThis.__dataCreditApi`, so each render picks its own freshness state.
 * Any other import fails the harness loudly instead of being silently skipped.
 */
async function loadBannerFile() {
  const { outputText } = ts.transpileModule(read('client/src/components/DataFreshnessBanner.tsx'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  });
  const stub = path.join(temp, 'api-stub.mjs');
  fs.writeFileSync(stub, 'export function useApi(p) { return globalThis.__dataCreditApi(p); }\n');
  const specifiers = {
    react: pathToFileURL(requireFromTest.resolve('react')).href,
    'react/jsx-runtime': pathToFileURL(requireFromTest.resolve('react/jsx-runtime')).href,
    '../api': pathToFileURL(stub).href
  };
  const unstubbed = [];
  const code = outputText.replace(/from (['"])([^'"]+)\1/g, (whole, _quote, spec) => {
    if (!(spec in specifiers)) { unstubbed.push(spec); return whole; }
    return `from '${specifiers[spec]}'`;
  });
  assert.deepEqual(unstubbed, [], 'DataFreshnessBanner.tsx imports a module this harness does not stub');
  const file = path.join(temp, 'DataFreshnessBanner.mjs');
  fs.writeFileSync(file, code);
  return import(pathToFileURL(file).href);
}

const banner = await loadBannerFile();

/**
 * Renders `component` with the freshness route answering `data`/`error`, the
 * banner dismissed or not, and, with `browser`, the globals a browser has
 * (`window`, `document`, `localStorage`) all saying "dismissed", so a component
 * that checks `typeof window` takes its browser branch here too.
 */
function render(component, { data = null, error = null, dismissed = false, browser = false }) {
  assert.equal(typeof component, 'function', 'the component under test is not exported');
  const calls = [];
  globalThis.__dataCreditApi = p => { calls.push(p); return { data, error, loading: false }; };
  const store = { getItem: k => (dismissed && k === 'data-freshness-dismissed' ? '1' : null), setItem() {}, removeItem() {} };
  const globals = { sessionStorage: store };
  if (browser) {
    Object.assign(globals, {
      localStorage: store,
      window: { sessionStorage: store, localStorage: store, location: { pathname: '/settings' }, matchMedia: () => ({ matches: true }) },
      document: { cookie: dismissed ? 'data-freshness-dismissed=1' : '', hidden: false, visibilityState: 'visible' }
    });
  }
  const saved = Object.fromEntries(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, value });
  try {
    return { html: renderToStaticMarkup(React.createElement(component)), calls };
  } finally {
    for (const [k, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete globalThis[k];
    }
  }
}

/**
 * Tailwind classes that hide an element or shrink it to nothing. A variant
 * prefix (`max-sm:hidden`, `!hidden`) still hides on some screen, so it counts.
 */
const HIDING_CLASSES = new Set(['hidden', 'sr-only', 'invisible', 'collapse', 'opacity-0', 'text-transparent',
  'h-0', 'max-h-0', 'w-0', 'max-w-0', 'size-0', 'scale-0', 'text-[0px]', 'text-[0]']);
const HIDING_STYLE = /display\s*:\s*['"]?none|visibility\s*:\s*['"]?hidden|opacity\s*:\s*['"]?0(?![.\d])|font-size\s*:\s*['"]?0(?![.\d])/i;
const hidingTokens = classText => classText.split(/\s+/).filter(Boolean)
  .filter(token => HIDING_CLASSES.has(token.replace(/^!/, '').split(':').pop().replace(/^!/, '')));

/** Everything in rendered markup that would keep an element off the screen or out of the accessibility tree. */
function hidingMarksInHtml(html) {
  const marks = [];
  for (const [, tag, attrs] of html.matchAll(/<([a-zA-Z][\w-]*)([^>]*)>/g)) {
    if (/\shidden(?=[\s=>/]|$)/.test(attrs)) marks.push(`<${tag} hidden>`);
    if (/\sinert(?=[\s=>/]|$)/.test(attrs)) marks.push(`<${tag} inert>`);
    if (/\saria-hidden="true"/.test(attrs)) marks.push(`<${tag} aria-hidden>`);
    const style = attrs.match(/\sstyle="([^"]*)"/)?.[1];
    if (style && HIDING_STYLE.test(style)) marks.push(`<${tag} style="${style}">`);
    for (const token of hidingTokens(attrs.match(/\sclass="([^"]*)"/)?.[1] ?? '')) marks.push(`<${tag} class ${token}>`);
  }
  return marks;
}

const text = html => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');

const usage = status => ({
  table: 'player_week_usage', label: 'Weekly usage', row_count: 1200, earliest: 2021, latest: 2026,
  last_write: '2026-09-21T12:00:00Z', current_rule: 'rows for 2026 week 2', status, note: null,
  grain: 'week', reader: null
});
const report = allFresh => ({
  season: 2026, week: 3, all_fresh: allFresh, tables: [usage(allFresh ? 'fresh' : 'stale')], sources: []
});

/** The three credits the licences require, and the licence each one sits under. */
const REQUIRED = [
  { name: 'nflverse', license: 'CC BY 4.0', licenseUrl: BY },
  { name: 'FTN Data via nflverse', license: 'CC BY-SA 4.0', licenseUrl: BY_SA },
  { name: 'ffopportunity', license: 'CC BY-SA 4.0', licenseUrl: BY_SA }
];

function assertCredits(html, state) {
  const t = text(html);
  for (const { name, license } of REQUIRED) {
    assert.ok(new RegExp(`(?<!via )\\b${name}\\s*\\(${license}\\)`).test(t),
      `with ${state}, the credit does not name "${name}" under ${license}; it read: ${JSON.stringify(t)}`);
  }
}

test('the credit renders when every source is current and the banner is dismissed (the DataFreshnessBanner.tsx:132 path)', () => {
  // Known-nonzero control first: the harness renders the banner at all, so an
  // empty render below is the component's own null, not a broken harness.
  const behind = render(banner.default, { data: report(false) });
  assert.match(text(behind.html), /not current for 2026 week 3/, 'control: the harness does not render the banner for a behind table');
  assert.deepEqual(behind.calls, ['/data-freshness'], 'control: the banner did not ask the stubbed freshness route');

  const states = [
    ['all_fresh=true and dismissed=true', { data: report(true), dismissed: true }],
    ['all_fresh=true', { data: report(true) }],
    ['a behind table, dismissed', { data: report(false), dismissed: true }]
  ];
  for (const [state, opts] of states) {
    assert.equal(render(banner.default, opts).html, '', `with ${state}, the banner should render nothing (the :132 early return)`);
    assertCredits(render(banner.DataCredit, opts).html, state);
  }
});

test('the credit still renders while the freshness check is loading or after it fails', () => {
  assertCredits(render(banner.DataCredit, { data: null }).html, 'no report yet');
  assertCredits(render(banner.DataCredit, { data: null, error: 'HTTP 404' }).html, 'a failed freshness check');
});

test('each credit links its source and its licence, and says the data was changed', () => {
  const { html } = render(banner.DataCredit, { data: report(true), dismissed: true });
  for (const { license, licenseUrl } of REQUIRED) {
    assert.ok(html.includes(`href="${licenseUrl}"`), `no link to the ${license} licence (${licenseUrl})`);
  }
  for (const href of ['https://github.com/nflverse/nflverse-data', 'https://github.com/ffverse/ffopportunity']) {
    assert.ok(html.includes(`href="${href}`), `no link to the licensed material at ${href}`);
  }
  assert.match(text(html), /adapted|modified|changed/i, 'the credit does not say the data was changed (CC BY Section 3(a)(1)(B))');
  assert.equal((html.match(/<footer\b/g) ?? []).length, 1, 'the credit is not one footer line');
});

test('the credit is visible: no element of it is hidden by a class, an attribute or an inline style', () => {
  // Known-nonzero control: the checker finds each kind of hiding it claims to.
  assert.deepEqual(
    hidingMarksInHtml('<footer class="border-t hidden"><span class="max-sm:hidden">a</span><a hidden href="x" aria-hidden="true" style="display: none">b</a><i class="sr-only" inert>c</i></footer>'),
    ['<footer class hidden>', '<span class max-sm:hidden>', '<a hidden>', '<a aria-hidden>', '<a style="display: none">', '<i inert>', '<i class sr-only>'],
    'control: the hiding checker misses a hidden element');
  assert.deepEqual(hidingMarksInHtml('<footer class="border-t text-slate-500"><a href="x" rel="license">b</a></footer>'), [],
    'control: the hiding checker flags an element that is not hidden');

  for (const [state, opts] of [
    ['all_fresh=true and dismissed=true', { data: report(true), dismissed: true }],
    ['a failed freshness check, in a browser', { data: null, error: 'HTTP 404', dismissed: true, browser: true }]
  ]) {
    const { html } = render(banner.DataCredit, opts);
    assert.match(html, /^<footer\b/, `with ${state}, the credit does not render its footer`);
    assert.deepEqual(hidingMarksInHtml(html), [], `with ${state}, part of the credit is hidden`);
  }
});

test('the credit takes no props, calls no hooks and reads no browser state, so nothing after mount can hide it', () => {
  // react-dom/server runs no effects and has no `window`, so a credit that hid
  // itself in a useEffect, or only in a browser, would pass every render above.
  // Three pins close that: a plain call, a browser-state sweep, and the source.

  // 1. Called as a plain function, outside any React render, a component that
  //    calls a hook throws. Control: the banner itself (useState) does.
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(' ')); };
  let bannerThrew = null;
  let creditThrew = null;
  let creditElement;
  try {
    try { banner.default(); } catch (error) { bannerThrew = error; }
    try { creditElement = banner.DataCredit(); } catch (error) { creditThrew = error; }
  } finally {
    console.error = consoleError;
  }
  // React's development build logs "Invalid hook call" and then throws reading
  // the null dispatcher; the production build only throws. Either is a throw.
  assert.ok(bannerThrew, `control: calling a hook-using component outside a render did not throw (logged ${JSON.stringify(errors)})`);
  assert.equal(creditThrew, null, `DataCredit calls a hook: called outside a render it threw ${creditThrew}`);
  assert.ok(React.isValidElement(creditElement), 'DataCredit() outside a render did not return an element');
  assert.equal(banner.DataCredit.length, 0, 'DataCredit declares parameters; it should take no props');

  // 2. Every browser state the banner reacts to renders the same credit, and the
  //    credit never asks the freshness route.
  const states = [
    ['no report, no browser', { data: null }],
    ['all fresh, dismissed', { data: report(true), dismissed: true }],
    ['behind, not dismissed, in a browser', { data: report(false), browser: true }],
    ['all fresh, dismissed, in a browser', { data: report(true), dismissed: true, browser: true }],
    ['failed check, dismissed, in a browser', { data: null, error: 'HTTP 404', dismissed: true, browser: true }]
  ];
  const baseline = render(banner.DataCredit, states[0][1]).html;
  assertCredits(baseline, states[0][0]);
  for (const [state, opts] of states) {
    const { html, calls } = render(banner.DataCredit, opts);
    assert.equal(html, baseline, `with ${state}, the credit renders differently`);
    assert.deepEqual(calls, [], `with ${state}, the credit asked the freshness route`);
  }

  // 3. The source uses no hook and names no browser global. Control: the same
  //    pattern finds useState and sessionStorage in the banner.
  const stateful = /\buse[A-Z]\w*\s*\(|\b(?:sessionStorage|localStorage|window|document|globalThis|navigator|location|matchMedia)\b/g;
  assert.deepEqual([...new Set(banner.default.toString().match(stateful))].sort(), ['sessionStorage', 'useApi(', 'useState('],
    'control: the pattern does not find the hooks and storage the banner uses');
  assert.deepEqual(banner.DataCredit.toString().match(stateful), null, 'DataCredit reads a hook or a browser global');

  // 4. Nor through anything it closes over: from outside its own body DataCredit
  //    may use only DATA_CREDITS and creditLink, and both must be literal data,
  //    so a value read from the browser when the module loads cannot reach it.
  //    Control: the same walk finds the banner's hooks and sessionStorage.
  const sf = ts.createSourceFile('DataFreshnessBanner.tsx', read('client/src/components/DataFreshnessBanner.tsx'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = name => sf.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  const constant = name => sf.statements.filter(ts.isVariableStatement).flatMap(s => s.declarationList.declarations)
    .find(d => d.name.getText(sf) === name);
  const bannerFn = sf.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'DataFreshnessBanner');
  assert.ok(bannerFn && fn('DataCredit'), 'DataFreshnessBanner.tsx no longer declares DataFreshnessBanner and DataCredit; this check needs rewriting');
  assert.ok(['useApi', 'useState', 'sessionStorage'].every(n => freeIdentifiers(bannerFn, sf).includes(n)),
    `control: the free-identifier walk misses the banner's hooks; it found ${JSON.stringify(freeIdentifiers(bannerFn, sf))}`);
  assert.deepEqual(freeIdentifiers(fn('DataCredit'), sf), ['DATA_CREDITS', 'creditLink'],
    'DataCredit uses something from outside its body other than DATA_CREDITS and creditLink');
  for (const name of ['DATA_CREDITS', 'creditLink']) {
    const decl = constant(name);
    assert.ok(decl?.initializer && ts.isVariableDeclarationList(decl.parent) && (decl.parent.flags & ts.NodeFlags.Const),
      `${name} is not a module-level const`);
    assert.deepEqual(freeIdentifiers(decl.initializer, sf), [], `${name} is computed from something rather than written out as data`);
  }
});

/**
 * The names a node's code reads from outside itself, found from the source
 * alone: every identifier that is not a property name, a JSX attribute name, an
 * intrinsic tag (footer, a, span), a type, or a name declared inside the node.
 */
function freeIdentifiers(node, sf) {
  const used = new Set();
  const declared = new Set();
  const isIntrinsicTag = n => (ts.isJsxOpeningElement(n.parent) || ts.isJsxClosingElement(n.parent) || ts.isJsxSelfClosingElement(n.parent))
    && n.parent.tagName === n && /^[a-z]/.test(n.text);
  (function walk(n) {
    if (ts.isTypeNode(n) || ts.isTypeParameterDeclaration(n)) return;
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isDeclaration = (ts.isParameter(p) || ts.isVariableDeclaration(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p)) && p.name === n;
      if (isDeclaration) declared.add(n.text);
      else if (!((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n)
        || (ts.isJsxAttribute(p) && p.name === n) || isIntrinsicTag(n))) used.add(n.text);
    }
    ts.forEachChild(n, walk);
  })(ts.isFunctionDeclaration(node) ? node.body : node);
  if (ts.isFunctionDeclaration(node)) node.parameters.forEach(p => declared.add(p.name.getText(sf)));
  return [...used].filter(name => !declared.has(name)).sort();
}

test('the credit line and GET /api/data-freshness name the same sources under the same licences', async () => {
  const body = await (await fetch(`${base}/api/data-freshness`)).json();
  assert.ok(Array.isArray(body.sources), 'the report has a sources array');
  assert.ok(Array.isArray(banner.DATA_CREDITS), 'DataFreshnessBanner.tsx exports no DATA_CREDITS list');
  const key = (repo, dataset) => `${repo}#${dataset ?? ''}`;
  const served = new Map(body.sources.map(s => [key(s.repo, s.dataset), [s.data_license, s.license_url ?? null]]));
  const shown = new Map(banner.DATA_CREDITS.map(c => [key(c.repo, c.dataset), [c.license, c.licenseUrl]]));
  assert.deepEqual([...shown.keys()].sort(), [...served.keys()].sort(), 'the credit line and the route list different sources');
  for (const [k, licence] of served) assert.deepEqual(shown.get(k), licence, `${k}: the credit line and the route disagree on the licence`);
});

test('the FTN descriptor names the release the charting loader fetches, under CC BY-SA 4.0, credited as FTN Data via nflverse', async () => {
  const mod = await optionalImport('../server/services/ftn-charting-source.js');
  const src = mod?.FTN_CHARTING_SOURCE;
  assert.ok(src, 'server/services/ftn-charting-source.js exports FTN_CHARTING_SOURCE');
  assert.ok(Object.isFrozen(src), 'the descriptor is frozen, like NFLVERSE_SOURCE');
  assert.equal(src.repo, 'nflverse/nflverse-data');
  assert.equal(src.dataset, 'ftn_charting');
  assert.equal(src.attribution, 'FTN Data via nflverse');
  assert.equal(src.data_license, 'CC BY-SA 4.0');
  assert.equal(src.license_url, BY_SA);
  assert.equal(src.modified, true);

  // Tie the descriptor to the loader that actually runs, so it cannot credit a
  // release the app does not read, or miss one it does.
  const formations = read('server/services/nfl-formations.js');
  const baseUrl = formations.match(/const BASE = '([^']+)';/)?.[1];
  assert.ok(baseUrl, 'nfl-formations.js no longer declares BASE; this check needs rewriting');
  assert.match(formations, /fetch\(`\$\{BASE\}\/ftn_charting\/ftn_charting_\$\{season\}\.csv`/,
    'ingestCharting no longer fetches ftn_charting from BASE; this check needs rewriting');
  assert.equal(src.release_url, `${baseUrl}/ftn_charting`, 'the descriptor names a release the loader does not fetch');

  const body = await (await fetch(`${base}/api/data-freshness`)).json();
  assert.deepEqual(body.sources.find(s => s.dataset === 'ftn_charting'), { ...src }, 'the route does not serve the FTN descriptor verbatim');
});

test('ffopportunity data is CC BY-SA 4.0, as its README Terms of Use says, not CC BY 4.0', () => {
  assert.equal(FFOPPORTUNITY_SOURCE.data_license, 'CC BY-SA 4.0');
  assert.equal(FFOPPORTUNITY_SOURCE.license_url, BY_SA);
});

/** Hiding marks on a JSX opening tag in App.tsx: the same classes and attributes as the rendered check, read from source. */
function hidingMarksInJsx(opening, sf) {
  const marks = [];
  for (const attr of opening.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attr)) { marks.push(`{${attr.getText(sf)}}`); continue; }
    const name = attr.name.getText(sf);
    const value = attr.initializer ? attr.initializer.getText(sf) : '';
    if (name === 'hidden' || name === 'inert') marks.push(name);
    if (name === 'aria-hidden' && !['"false"', '{false}', '{"false"}', "{'false'}"].includes(value.replace(/\s/g, ''))) marks.push(`aria-hidden=${value}`);
    if (name === 'style' && HIDING_STYLE.test(value)) marks.push(`style=${value}`);
    if (name === 'className') {
      // Every literal piece of the class, whether a plain string or inside a template or ternary.
      const pieces = [];
      (function collect(n) {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) pieces.push(n.text);
        else if (ts.isTemplateExpression(n)) { pieces.push(n.head.text); n.templateSpans.forEach(s => { collect(s.expression); pieces.push(s.literal.text); }); }
        else ts.forEachChild(n, collect);
      })(attr.initializer);
      for (const token of hidingTokens(pieces.join(' '))) marks.push(`className ${token}`);
    }
  }
  return marks;
}

test('App renders the credit once, on every page of the app chrome: a plain sibling of <main>, with no condition or hidden element above it', () => {
  const appSource = read('client/src/App.tsx');
  assert.match(appSource, /import \{ DataCredit \} from '\.\/components\/DataFreshnessBanner';/, 'App does not import DataCredit');
  const sf = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const tag = n => n.tagName.getText(sf);
  let app = null;
  const credits = [];
  const mains = [];
  const openings = [];
  (function walk(n) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'App') app = n;
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      openings.push(n);
      if (tag(n) === 'DataCredit') credits.push(n);
      if (tag(n) === 'main' && ts.isJsxOpeningElement(n)) mains.push(n.parent);
    }
    ts.forEachChild(n, walk);
  })(sf);
  assert.ok(app?.body, 'App.tsx declares no function App');
  assert.equal(credits.length, 1, `App mounts the credit ${credits.length} times; it should be one line`);
  assert.equal(mains.length, 1, `App has ${mains.length} <main> elements; this check needs rewriting`);

  // Known-nonzero control: the JSX checker finds real hiding in this file (the
  // header's `hidden sm:inline` label and the drawer's aria-hidden overlay).
  const hiddenInApp = openings.flatMap(o => hidingMarksInJsx(o, sf));
  assert.ok(hiddenInApp.includes('className hidden') && hiddenInApp.includes('aria-hidden="true"'),
    `control: the JSX checker finds no hidden element in App.tsx; it found ${JSON.stringify(hiddenInApp)}`);

  const [credit] = credits;
  const [main] = mains;
  assert.ok(ts.isJsxSelfClosingElement(credit) && credit.attributes.properties.length === 0,
    `the credit is mounted as "${credit.getText(sf)}"; it takes no props or children`);
  const describe = n => `${ts.SyntaxKind[n.kind]} "${n.getText(sf).replace(/\s+/g, ' ').slice(0, 80)}"`;
  assert.ok(credit.parent === main.parent,
    `the credit is not a direct sibling of <main>, so something other than the page layout decides whether it shows; its parent is ${describe(credit.parent)}`);
  const siblings = main.parent.children;
  assert.ok(siblings.indexOf(credit) > siblings.indexOf(main), 'the credit is not placed after the page content');

  // From the credit up to App's return, only plain elements and fragments: no
  // `&&`, ternary, callback or call, and nothing hidden.
  let node = credit.parent;
  while (!ts.isReturnStatement(node)) {
    assert.ok(ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isParenthesizedExpression(node),
      `the credit sits inside ${describe(node)}, so some state can hide it`);
    if (ts.isJsxElement(node)) {
      const marks = hidingMarksInJsx(node.openingElement, sf);
      assert.deepEqual(marks, [], `<${tag(node.openingElement)}> above the credit hides it (${marks.join(', ')})`);
    }
    node = node.parent;
  }
  // That return is App's last top-level statement: the one every page inside
  // the chrome goes through. The early return before it is sign-in, which
  // renders outside the chrome and fetches only /api/auth endpoints.
  // (Identity is compared with assert.ok: assert.equal on two TypeScript nodes
  // prints a diff of the whole circular syntax tree.)
  assert.ok(node.parent === app.body, 'the return that mounts the credit is nested inside a branch of App');
  assert.ok(app.body.statements.at(-1) === node, 'the return that mounts the credit is not App\'s last statement');
});
