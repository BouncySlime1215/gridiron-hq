/**
 * UX-08 (plan item D23, UI rule 9): the shared error card
 * (client/src/components/PageState.tsx `PageError`) rendered whatever the
 * server or a thrown fetch error said — including a file path and a table
 * name, confirmed on the Lineup page (docs/handoff/local/ui/UX-01-audit.md,
 * "grep Lineup": Lineup.tsx surfaced "nfl_availability_role_rates is
 * missing/empty (docs/tdd/play-chance.tdd.md)" straight onto the Start/Sit
 * card). This test renders PageError for real (TSX compiled with the repo's
 * own TypeScript, React renders it to markup) and asserts the rendered text
 * never contains that path or table name, only a plain-words state and a
 * retry control; the raw detail goes to console.error instead.
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-page-error-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const repoRequire = createRequire(new URL('../package.json', import.meta.url));
const write = (name, text) => { fs.writeFileSync(path.join(temp, name), text); return pathToFileURL(path.join(temp, name)).href; };

const runtimeUrl = write('jsx-runtime.mjs', `import { createRequire } from 'node:module';
const rt = createRequire(${JSON.stringify(repoRequire.resolve('react/jsx-runtime'))})(${JSON.stringify(repoRequire.resolve('react/jsx-runtime'))});
export const jsx = rt.jsx; export const jsxs = rt.jsxs; export const Fragment = rt.Fragment;`);
const linkStubUrl = write('react-router-dom.mjs', 'export function Link({ children }) { return children ?? null; }');

function loadPageState() {
  const source = fs.readFileSync(new URL('../client/src/components/PageState.tsx', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  let compiled = outputText;
  for (const [from, to] of [["'react-router-dom'", linkStubUrl], ['"react/jsx-runtime"', runtimeUrl]]) {
    assert.ok(compiled.includes(from), `the compiled PageState imports ${from}`);
    compiled = compiled.split(from).join(`'${to}'`);
  }
  return import(write(`PageState-${Date.now()}-${Math.random()}.mjs`, compiled));
}

const KNOWN_NONZERO = 'the network is unreachable';
const LEAKY = 'the fitted chance-to-play role layer is not running: ' +
  'nfl_availability_role_rates is missing/empty (docs/tdd/play-chance.tdd.md)';

test('control: a plain error message still renders (known-nonzero case)', async () => {
  const { PageError } = await loadPageState();
  const html = renderToStaticMarkup(React.createElement(PageError, { message: KNOWN_NONZERO }));
  // The control proves the harness can see message text at all — this one is
  // *not* asserted absent below, only the leaky one is.
  assert.ok(html.length > 0);
});

test('PageError never renders a file path or table name from the server message', async () => {
  const { PageError } = await loadPageState();
  const seen = [];
  const originalError = console.error;
  console.error = (...args) => seen.push(args.join(' '));
  let html;
  try {
    html = renderToStaticMarkup(React.createElement(PageError, { message: LEAKY, onRetry: () => {} }));
  } finally {
    console.error = originalError;
  }
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

  // Raw markup, not tag-stripped text: a title= or aria-label= leak must fail too
  // (skeptic mutants M1/M2 survived a text-only check).
  assert.ok(!html.includes('nfl_availability_role_rates'), `markup leaked the table name: ${html}`);
  assert.ok(!html.includes('docs/tdd/'), `markup leaked the file path: ${html}`);
  assert.ok(!text.includes(LEAKY), 'rendered text leaked the raw server message verbatim');

  // Plain words, not silence: still says what failed and offers a retry.
  assert.match(text, /couldn't load this/i);
  assert.match(text, /retry/i);

  // The technical detail is not swallowed — it goes to the console for debugging.
  assert.ok(seen.some(line => line.includes('nfl_availability_role_rates')),
    'the raw server detail should still reach console.error for debugging');
});
