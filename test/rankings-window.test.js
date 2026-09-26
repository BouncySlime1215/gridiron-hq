/**
 * Players → Rankings draws only the rows near the screen (client/src/lib/windowRows.ts, in-repo, no
 * library): spacer rows keep the page's full height, so the scroll bar and position are unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-rows-'));
const file = path.join(dir, 'm.mjs');
// Only the pure part is needed here; the React import is stubbed.
const src = read('client/src/lib/windowRows.ts').replace(/^import .* from 'react';$/m, 'const useEffect=()=>{},useLayoutEffect=()=>{},useRef=()=>({}),useState=x=>[x,()=>{}];');
fs.writeFileSync(file, ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { windowRange, WINDOW_FROM } = await import(file);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const rows = n => Array.from({ length: n }, () => 45);

test('top of the list: the first screen plus overscan, the rest one spacer', () => {
  const r = windowRange(rows(106), 0, 900, 8);
  assert.equal(r.start, 0);
  assert.equal(r.end, Math.ceil(900 / 45) + 8);
  assert.equal(r.padTop, 0);
  assert.equal(r.padTop + (r.end - r.start) * 45 + r.padBottom, 106 * 45, 'full height kept');
});

test('middle and bottom: spacers add up to the rows left out', () => {
  const h = rows(106); h[10] = 25; h[40] = 25; // two tier breaks
  const total = h.reduce((a, b) => a + b, 0);
  for (const top of [0, 1000, 2500, 4200, 10000]) {
    const r = windowRange(h, top, top + 800, 8);
    const drawn = h.slice(r.start, r.end).reduce((a, b) => a + b, 0);
    assert.equal(r.padTop + drawn + r.padBottom, total, `at ${top}`);
    assert.ok(r.end - r.start <= Math.ceil(800 / 25) + 17, 'only a screenful and the overscan are drawn');
  }
  const bottom = windowRange(h, 10000, 10800, 8);
  assert.equal(bottom.end, 106);
  assert.equal(bottom.padBottom, 0);
});

test('short lists draw every row', () => {
  assert.equal(WINDOW_FROM, 40);
  const src2 = read('client/src/lib/windowRows.ts');
  assert.match(src2, /const on = kinds\.length >= WINDOW_FROM;/);
});

test('Rankings draws the window with a spacer each side and measures rows through StatRow', () => {
  const r = read('client/src/pages/Rankings.tsx');
  assert.match(r, /const win = useWindowedRows\(body, lines\.map\(l => l\.kind\)/);
  assert.match(r, /lines\.slice\(win\.start, win\.end\)/);
  assert.match(r, /data-spacer="top"/);
  assert.match(r, /data-spacer="bottom"/);
  assert.match(read('client/src/components/StatTable.tsx'), /<tr ref=\{rowRef\}/);
  assert.doesNotMatch(read('package.json'), /react-window|react-virtual|virtuoso/, 'no list library');
});
