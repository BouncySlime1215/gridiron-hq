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

function render(component, { data = null, error = null, dismissed = false }) {
  assert.equal(typeof component, 'function', 'the component under test is not exported');
  const calls = [];
  globalThis.__dataCreditApi = p => { calls.push(p); return { data, error, loading: false }; };
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: { getItem: k => (dismissed && k === 'data-freshness-dismissed' ? '1' : null), setItem() {} }
  });
  try {
    return { html: renderToStaticMarkup(React.createElement(component)), calls };
  } finally {
    if (saved) Object.defineProperty(globalThis, 'sessionStorage', saved);
    else delete globalThis.sessionStorage;
  }
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

test('App renders the credit once, on every page, outside any condition', () => {
  const appSource = read('client/src/App.tsx');
  assert.match(appSource, /import \{ DataCredit \} from '\.\/components\/DataFreshnessBanner';/, 'App does not import DataCredit');
  const uses = [...appSource.matchAll(/<DataCredit\b[^>]*\/>/g)];
  assert.equal(uses.length, 1, `App renders the credit ${uses.length} times; it should be one line`);
  const before = appSource.slice(0, uses[0].index);
  assert.ok(before.lastIndexOf('</main>') > before.lastIndexOf('<main'), 'the credit is not placed after the page content');
  assert.doesNotMatch(before, /(&&|\?|:|\()\s*$/, 'the credit sits behind a condition, so some state can hide it');
});
