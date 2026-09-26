/**
 * Item 58 ACCESSIBILITY PASS (docs/tdd/2026-09-26-accessibility-pass-prereg.md):
 * contrast on the tokens, the TSX scan, the keyboard structure of the shell, the key helpers the
 * Tabs and Sheet primitives use, and the CI gate (GRIDIRON_A11Y_CHECK=enforce).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { parseColor, contrastRatio, checkContrast } from '../scripts/a11y/contrast.mjs';
import { scanSource, isProtected } from '../scripts/a11y/scan-jsx.mjs';
import { checkStructure } from '../scripts/a11y/structure.mjs';
import { runA11y, readMode } from '../scripts/check-a11y.mjs';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8');
const rules = src => scanSource(src, 'client/src/x.tsx').map(f => f.rule);

// The pure key helpers, transpiled from the client source (same pattern as rankings-window.test.js).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-keys-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const keysFile = path.join(dir, 'k.mjs');
fs.writeFileSync(keysFile, ts.transpileModule(read('client/src/lib/rovingFocus.ts'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { rovingIndex, trapTab } = await import(keysFile);

test('contrast maths: black on white is 21:1, alpha is composited, bad colours throw', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
  assert.equal(contrastRatio('#777', '#777'), 1);
  assert.deepEqual(parseColor('rgb(10 20 30 / .5)'), [10, 20, 30, 0.5]);
  assert.equal(contrastRatio('rgb(0 0 0 / 0)', '#ffffff'), 1, 'a transparent colour is the surface');
  assert.throws(() => parseColor('var(--x)'));
  assert.throws(() => contrastRatio('#000', 'rgb(0 0 0 / .5)'), /opaque/);
});

test('B1: every token pair meets AA in light and dark', () => {
  const { rows, failures } = checkContrast(read('client/src/styles/tokens.css'));
  assert.ok(rows.length >= 70, `checked ${rows.length} pairs`);
  assert.ok(rows.some(r => r.theme === 'dark' && r.fg === 'subtle'), 'dark set is read (not the comment that names it)');
  assert.deepEqual(failures.map(f => `${f.theme} ${f.fg} on ${f.bg} ${f.ratio}`), []);
});

test('scan: an icon-only button or link without a name is flagged; text, sr-only text or aria-label names it', () => {
  assert.deepEqual(rules('<button onClick={f}><Icon name="close" /></button>'), ['icon-button-name']);
  assert.deepEqual(rules('<a href="/x"><span><svg><path d="M0" /></svg></span></a>'), ['icon-button-name']);
  assert.deepEqual(rules('<button aria-label="Close"><Icon name="close" /></button>'), []);
  assert.deepEqual(rules('<button><Icon name="close" /><span className="sr-only">Close</span></button>'), []);
  assert.deepEqual(rules('<button>{label}</button>'), [], 'an expression may be text: not flagged');
  assert.deepEqual(rules('<button {...props}><Icon name="x" /></button>'), [], 'a spread may carry the label');
});

test('scan: click-only elements are flagged unless they are keyboard-operable, a stopPropagation, or a scrim with Escape', () => {
  assert.deepEqual(rules('<div onClick={go}>x</div>'), ['click-no-keyboard']);
  assert.deepEqual(rules('<g onClick={go}><rect /></g>'), ['click-no-keyboard']);
  assert.deepEqual(rules('<div role="button" tabIndex={0} onKeyDown={k} onClick={go}>x</div>'), []);
  assert.deepEqual(rules('<div onClick={e => e.stopPropagation()}>x</div>'), []);
  assert.deepEqual(rules('<div aria-hidden="true" onClick={close} />'), []);
  const scrim = '<div onClick={close}><section role="dialog" aria-label="A">x</section></div>';
  assert.deepEqual(rules(scrim), ['click-no-keyboard'], 'a scrim with no Escape handler leaves the keyboard stuck');
  assert.deepEqual(rules(`const k = e => e.key === 'Escape' && close();\n${scrim}`), []);
});

test('scan: img alt, positive tabIndex, and unlabeled controls', () => {
  assert.deepEqual(rules('<img src={s} />'), ['img-alt']);
  assert.deepEqual(rules('<img src={s} alt="" />'), []);
  assert.deepEqual(rules('<div tabIndex={2}>x</div>'), ['positive-tabindex']);
  assert.deepEqual(rules('<div tabIndex={-1}>x</div>'), []);
  assert.deepEqual(rules('<input value={v} placeholder="Search" />'), ['control-label'], 'a placeholder is not a label');
  assert.deepEqual(rules('<select value={v}><option>a</option></select>'), ['control-label']);
  assert.deepEqual(rules('<input aria-label="Search" />'), []);
  assert.deepEqual(rules('<label>Name <input value={v} /></label>'), []);
  assert.deepEqual(rules('<input type="hidden" value={v} />'), []);
});

test('protected files: Trades client, War Room, Coach, Numbers & People, AI spend', () => {
  for (const f of ['client/src/pages/Trades.tsx', 'client/src/pages/TradeLab.tsx', 'client/src/components/TradeCard.tsx',
    'client/src/components/warroom/ReplyTable.tsx', 'client/src/components/trade/NumbersPeople.tsx',
    'client/src/components/AppCoach.tsx', 'client/src/components/warroom/coach/CoachDrawer.tsx']) assert.ok(isProtected(f), f);
  for (const f of ['client/src/pages/Today.tsx', 'client/src/App.tsx', 'client/src/components/ui/DesignSystem.tsx']) assert.ok(!isProtected(f), f);
});

test('B2-B4: no enforced scan finding anywhere in the client', () => {
  const r = runA11y(REPO);
  assert.deepEqual(r.enforced.map(f => `${f.rule} ${f.file}:${f.line}`), []);
  assert.ok(r.files > 100, `scanned ${r.files} files`);
});

test('B5: the keyboard path through the seven areas has no gap', () => {
  assert.deepEqual(checkStructure(read).map(s => `${s.rule}: ${s.detail}`), []);
});

test('B5 keys: rovingIndex moves with arrows (wrapping), Home and End; other keys do nothing', () => {
  assert.equal(rovingIndex('ArrowRight', 0, 7), 1);
  assert.equal(rovingIndex('ArrowRight', 6, 7), 0);
  assert.equal(rovingIndex('ArrowLeft', 0, 7), 6);
  assert.equal(rovingIndex('ArrowDown', 2, 7), 3);
  assert.equal(rovingIndex('ArrowUp', 2, 7), 1);
  assert.equal(rovingIndex('Home', 4, 7), 0);
  assert.equal(rovingIndex('End', 1, 7), 6);
  assert.equal(rovingIndex('Enter', 1, 7), null);
  assert.equal(rovingIndex('ArrowRight', 0, 0), null);
});

test('B5 keys: trapTab wraps Tab at the edges of a dialog and leaves the middle alone', () => {
  const [a, b, c] = ['a', 'b', 'c'];
  assert.equal(trapTab([a, b, c], c, false), a, 'Tab on the last goes to the first');
  assert.equal(trapTab([a, b, c], a, true), c, 'Shift+Tab on the first goes to the last');
  assert.equal(trapTab([a, b, c], b, false), null);
  assert.equal(trapTab([a, b, c], 'outside', false), a, 'focus that escaped comes back in');
  assert.equal(trapTab([], a, false), null);
});

test('B6: flag values, and the gate fails an enforced file but only reports a protected one', () => {
  assert.equal(readMode({}), 'report');
  assert.equal(readMode({ GRIDIRON_A11Y_CHECK: 'enforce' }), 'enforce');
  assert.throws(() => readMode({ GRIDIRON_A11Y_CHECK: 'on' }), /one of/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-root-'));
  try {
    for (const rel of ['client/src/styles/tokens.css', 'client/src/App.tsx', 'client/src/navigation.ts', 'client/src/components/ui/DesignSystem.tsx']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
    }
    const cli = env => spawnSync(process.execPath, [path.join(REPO, 'scripts/check-a11y.mjs'), '--root', root], { env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.equal(cli({ GRIDIRON_A11Y_CHECK: 'enforce' }).status, 0, 'clean tree passes');

    fs.mkdirSync(path.join(root, 'client/src/components/warroom'), { recursive: true });
    fs.writeFileSync(path.join(root, 'client/src/components/warroom/Bad.tsx'), 'export const B = () => <div onClick={go}>x</div>;');
    const prot = cli({ GRIDIRON_A11Y_CHECK: 'enforce' });
    assert.equal(prot.status, 0, 'a protected file is report-only');
    assert.match(prot.stdout, /\[report\] click-no-keyboard client\/src\/components\/warroom\/Bad\.tsx/);

    fs.writeFileSync(path.join(root, 'client/src/Bad.tsx'), 'export const B = () => <button><Icon name="x" /></button>;');
    const bad = cli({ GRIDIRON_A11Y_CHECK: 'enforce' });
    assert.equal(bad.status, 1, bad.stdout);
    assert.match(bad.stdout, /icon-button-name client\/src\/Bad\.tsx:1/);
    assert.equal(cli({ GRIDIRON_A11Y_CHECK: 'report' }).status, 0, 'report mode never fails');
    assert.equal(cli({ GRIDIRON_A11Y_CHECK: 'off' }).status, 0);
    assert.equal(cli({ GRIDIRON_A11Y_CHECK: 'yes' }).status, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('B6: CI runs the gate in enforce mode', () => {
  const ci = read('.github/workflows/ci.yml');
  const step = ci.slice(ci.indexOf('name: Accessibility check'));
  assert.ok(ci.includes('name: Accessibility check'), 'ci.yml has the step');
  assert.match(step, /run: npm run check:a11y/);
  assert.match(step, /GRIDIRON_A11Y_CHECK: 'enforce'/);
  assert.equal(JSON.parse(read('package.json')).scripts['check:a11y'], 'node scripts/check-a11y.mjs');
});
