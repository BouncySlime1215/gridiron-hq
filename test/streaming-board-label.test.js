/**
 * WV-01-ON (NICK-WV01 ruling, WORK-QUEUE.md section 12): the Stream-a-defense
 * card on the Start/Sit page must label the replay line
 * "history-tested (2022-25), not yet confirmed on 2026 games" whenever the
 * server says the result is unconfirmed forward, and show no such line when it
 * is not.
 *
 * Renders the real client/src/components/lineup/StreamingBoard.tsx (TSX
 * compiled with the repo's own TypeScript, PageState compiled the same way,
 * react-router-dom's Link stubbed) to static markup, the same harness as
 * test/lineup-error-no-leak.test.js.
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-streaming-label-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const repoRequire = createRequire(new URL('../package.json', import.meta.url));
const write = (name, text) => { fs.writeFileSync(path.join(temp, name), text); return pathToFileURL(path.join(temp, name)).href; };

const runtimeUrl = write('jsx-runtime.mjs', `import { createRequire } from 'node:module';
const rt = createRequire(${JSON.stringify(repoRequire.resolve('react/jsx-runtime'))})(${JSON.stringify(repoRequire.resolve('react/jsx-runtime'))});
export const jsx = rt.jsx; export const jsxs = rt.jsxs; export const Fragment = rt.Fragment;`);
const linkStubUrl = write('react-router-dom.mjs', 'export function Link({ children }) { return children ?? null; }');

function compile(rel, swaps, outName) {
  const source = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  let compiled = outputText;
  for (const [from, to] of swaps) {
    assert.ok(compiled.includes(from), `${rel} imports ${from}`);
    compiled = compiled.split(from).join(`'${to}'`);
  }
  return write(outName, compiled);
}

async function loadStreamingBoard() {
  const pageStateUrl = compile('../client/src/components/PageState.tsx',
    [["'react-router-dom'", linkStubUrl], ['"react/jsx-runtime"', runtimeUrl]], 'page-state.mjs');
  const boardUrl = compile('../client/src/components/lineup/StreamingBoard.tsx',
    [["'../PageState'", pageStateUrl], ['"react/jsx-runtime"', runtimeUrl]], 'streaming-board.mjs');
  return (await import(boardUrl)).default;
}

const clean = h => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const LABEL = 'history-tested (2022-25), not yet confirmed on 2026 games';

const board = unconfirmed => ({
  season: 2026, week: 3, position: 'D/ST', min_edge: 1,
  candidates: [], my_defenses: [],
  suggestion: { action: null, why: null },
  unconfirmed_forward: unconfirmed,
});

const render = async data => {
  const StreamingBoard = await loadStreamingBoard();
  return clean(renderToStaticMarkup(React.createElement(StreamingBoard,
    { data, loading: false, error: null, onRetry: () => {} })));
};

test('StreamingBoard: unconfirmed_forward=true shows the exact NICK-WV01 label', async () => {
  const text = await render(board(true));
  assert.ok(text.includes(LABEL), `label missing; card text: ${text}`);
  assert.ok(!/unconfirmed forward/i.test(text), 'old "unconfirmed forward" wording is gone');
});

test('StreamingBoard: unconfirmed_forward=false shows no history label', async () => {
  const text = await render(board(false));
  assert.ok(!text.includes(LABEL), `label shown when not unconfirmed; card text: ${text}`);
  assert.ok(!text.includes('Replayed on 2022-2025'), 'replay line hidden when not unconfirmed');
  assert.ok(text.includes('Stream a defense'), 'card itself still renders');
});
