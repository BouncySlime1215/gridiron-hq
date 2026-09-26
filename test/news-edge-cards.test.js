/**
 * Trades -> News edge on a phone: one card per move (the route lists every news item, so "claim X"
 * can come from two reports) and the freshest five before "Show all". Presentation only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const src = fs.readFileSync(new URL('../client/src/components/trade/newsEdgeCards.ts', import.meta.url), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-edge-cards-'));
const file = path.join(dir, 'm.mjs');
fs.writeFileSync(file, ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { oneCardPerMove, FIRST } = await import(file);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const o = (kind, target, age) => ({ action: { kind, target }, age_hours: age });

test('one card per move, the freshest report kept, the rest counted on it', () => {
  const out = oneCardPerMove([o('claim_waiver', 'A', 1), o('buy_low', 'A', 2), o('claim_waiver', 'A', 3), o('claim_waiver', 'B', 4), o('claim_waiver', 'A', 5)]);
  assert.deepEqual(out.map(x => [x.action.kind, x.action.target, x.age_hours, x.more_reports]),
    [['claim_waiver', 'A', 1, 2], ['buy_low', 'A', 2, 0], ['claim_waiver', 'B', 4, 0]]);
  assert.deepEqual(oneCardPerMove([]), []);
});

test('the freshest five show first; the component folds the rest behind "Show all"', () => {
  assert.equal(FIRST, 5);
  const c = fs.readFileSync(new URL('../client/src/components/trade/NewsEdge.tsx', import.meta.url), 'utf8');
  assert.match(c, /const shown = all \? opps : opps\.slice\(0, FIRST\);/);
  assert.match(c, /Show all \$\{opps\.length\} moves/);
});
