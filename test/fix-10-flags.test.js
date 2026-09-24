/**
 * FIX-10: the two user-visible features that shipped without a flag get one.
 *
 *   GRIDIRON_NUMBER_HEALTH  the Settings "Number health" card + nav dot (#237) and the
 *                           GET /api/number-audit route they read. The refresh-loop audit
 *                           job is not flagged: it only writes the table.
 *   GRIDIRON_OFFER_LOOP     the TradeCard "I sent this" button + /offers/sent (#239).
 *
 * Each has one reader file that ORs in preview mode (previewUnconfirmed()) and puts the
 * preview label on the response. Route and card behaviour are pinned next to their own
 * fixtures: test/number-audit.test.js and test/trade-outcomes-route.test.js.
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

const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const NH = await import('../server/services/number-health-flag.js');
const OL = await import('../server/services/offer-loop-flag.js');

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

for (const [name, env, fields] of [
  ['number health', 'GRIDIRON_NUMBER_HEALTH', NH.numberHealthFields],
  ['offer loop', 'GRIDIRON_OFFER_LOOP', OL.offerLoopFields],
]) {
  test(`${name}: off by default, on only for exactly "1", preview turns it on labelled`, () => {
    withEnv({ [env]: undefined, [PREVIEW_ENV]: undefined }, () => {
      const off = fields();
      assert.equal(off.enabled, false);
      assert.match(off.reason, new RegExp(`Set ${env}=1`), 'the off reason names the switch');
      assert.equal(off.preview, undefined);
    });
    for (const v of ['0', 'true', '']) {
      withEnv({ [env]: v, [PREVIEW_ENV]: undefined }, () => assert.equal(fields().enabled, false, `${JSON.stringify(v)}: off`));
    }
    withEnv({ [env]: '1', [PREVIEW_ENV]: undefined }, () => assert.deepEqual(fields(), { enabled: true }, 'flag on: no preview label'));
    withEnv({ [env]: undefined, [PREVIEW_ENV]: '1' }, () => {
      const p = fields();
      assert.equal(p.enabled, true);
      assert.equal(p.preview, true);
      assert.match(p.preview_reason, /default-off/);
    });
    withEnv({ [env]: '1', [PREVIEW_ENV]: '1' }, () => assert.deepEqual(fields(), { enabled: true }, 'the site flag wins: not a preview'));
  });
}

test('preview-mode.js lists number health, the offer loop and the brain report as converted sites', () => {
  const src = fs.readFileSync(new URL('../server/services/preview-mode.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('Converted sites'), src.indexOf('*/'));
  assert.match(block, /number-health-flag\.js/);
  assert.match(block, /offer-loop-flag\.js/);
  assert.match(block, /brain-report/);
});

// ------------------------------------------------------------------ client: the button
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-fix-10-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const repoRequire = createRequire(new URL('../package.json', import.meta.url));
const write = (name, text) => { fs.writeFileSync(path.join(temp, name), text); return pathToFileURL(path.join(temp, name)).href; };
const source = fs.readFileSync(new URL('../client/src/components/trade/SentOfferButton.tsx', import.meta.url), 'utf8');
let compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const rt = JSON.stringify(repoRequire.resolve('react/jsx-runtime'));
const reactPath = JSON.stringify(repoRequire.resolve('react'));
for (const [from, to] of [
  ["'../../api'", write('api.mjs', 'export function useApi(p) { globalThis.__offerPath = p; return { data: globalThis.__offerFlag, loading: false, error: null }; } export async function api() { return {}; }')],
  ["'../../lib/errorSanitize'", write('sanitize.mjs', 'export function sanitizedMessage(_w, prefix) { return prefix; }')],
  ["'react'", write('react.mjs', `import { createRequire } from 'node:module'; const R = createRequire(${reactPath})(${reactPath}); export const useState = R.useState; export default R;`)],
  ['"react/jsx-runtime"', write('jsx-runtime.mjs', `import { createRequire } from 'node:module';
const rt = createRequire(${rt})(${rt}); export const jsx = rt.jsx; export const jsxs = rt.jsxs; export const Fragment = rt.Fragment;`)],
]) {
  assert.ok(compiled.includes(from), `the compiled button imports ${from}`);
  compiled = compiled.split(from).join(`'${to}'`);
}
const Btn = (await import(write('SentOfferButton.mjs', compiled))).default;
const DEAL = { id: 'a>b', partner_id: 4, i_give: [], i_get: [], acceptance: { band: { mid: 0.4 } } };
const render = deal => renderToStaticMarkup(React.createElement(Btn, { deal, leagueId: 44, onError() {} }));

test('"I sent this": absent when the flag is off, when the flag is unknown, or when the deal has no band', () => {
  globalThis.__offerFlag = { enabled: false, reason: 'off' };
  assert.equal(render(DEAL), '', 'off: no button');
  assert.equal(globalThis.__offerPath, '/trades/44/offers/sent', 'reads the league route for the flag');
  globalThis.__offerFlag = null;
  assert.equal(render(DEAL), '', 'not loaded yet: no button');
  globalThis.__offerFlag = { enabled: true };
  assert.equal(render({ ...DEAL, acceptance: null }), '', 'no band: no button');
});

test('"I sent this": shown when on; labelled a preview when on only through preview mode', () => {
  globalThis.__offerFlag = { enabled: true };
  const on = render(DEAL);
  assert.match(on, /I sent this/);
  assert.doesNotMatch(on, /Preview/);
  globalThis.__offerFlag = { enabled: true, preview: true, preview_reason: 'default-off: why' };
  const preview = render(DEAL);
  assert.match(preview, /I sent this/);
  assert.match(preview, /Preview \(unconfirmed forward\)/);
  assert.match(preview, /data-preview/);
});

test('TradeCard renders the button component instead of its own copy', () => {
  const card = fs.readFileSync(new URL('../client/src/components/TradeCard.tsx', import.meta.url), 'utf8');
  assert.match(card, /import SentOfferButton from '\.\/trade\/SentOfferButton'/);
  assert.match(card, /<SentOfferButton /);
  assert.doesNotMatch(card, /offers\/sent/, 'the POST lives in one place');
});
