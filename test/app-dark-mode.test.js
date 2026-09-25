/**
 * App-wide dark mode (client/tailwind.config.js, state/theme.tsx, index.html, MoreMenu.tsx).
 *
 * Every page reads Tailwind colours; the config turns each family into a CSS variable with a
 * light set (Tailwind's own values) and a dark set. These tests read the real config and check
 * the pairs the pages actually use keep their contrast in dark, that the light set is unchanged,
 * and that the pre-paint script, the store and the menu agree on the storage key and choices.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import colors from 'tailwindcss/colors.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: config } = await import(path.join(REPO, 'client/tailwind.config.js'));
const base = {};
for (const p of config.plugins) (p.handler ?? p)({ addBase: b => Object.assign(base, b) });
const lightKey = Object.keys(base).find(k => k.startsWith(':root'));
const L = base[lightKey], D = base['[data-theme="dark"]'];

const rgb = t => t.split(' ').map(Number);
const lum = c => { const f = x => { x /= 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const CARD = [18, 20, 25];

test('the light palette is Tailwind\'s own, unchanged', () => {
  for (const fam of ['slate', 'emerald', 'amber', 'rose', 'sky']) for (const s of ['50', '500', '900']) {
    const hex = colors[fam][s]; const n = parseInt(hex.slice(1), 16);
    assert.equal(L[`--tw-${fam}-${s}`], `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`, `${fam}-${s}`);
  }
  assert.equal(config.theme.extend.colors.slate['500'], 'rgb(var(--tw-slate-500) / <alpha-value>)', 'classes read the variable, alpha modifiers still work');
});

test('dark: the text-on-surface pairs the pages use keep their contrast', () => {
  const soft = rgb(D['--tw-slate-50']);
  for (const [s, min] of [['900', 7], ['800', 7], ['700', 4.5], ['600', 4.5], ['500', 4.5], ['400', 3]]) {
    const c = rgb(D[`--tw-slate-${s}`]);
    assert.ok(ratio(c, CARD) >= min, `text-slate-${s} on a card: ${ratio(c, CARD).toFixed(2)} < ${min}`);
    assert.ok(ratio(c, soft) >= min, `text-slate-${s} on bg-slate-50: ${ratio(c, soft).toFixed(2)} < ${min}`);
  }
  for (const fam of ['emerald', 'amber', 'rose', 'sky', 'red', 'violet', 'indigo']) for (const t of ['700', '800', '900']) for (const b of ['50', '100']) {
    const r = ratio(rgb(D[`--tw-${fam}-${t}`]), rgb(D[`--tw-${fam}-${b}`]));
    assert.ok(r >= 4.5, `text-${fam}-${t} on bg-${fam}-${b}: ${r.toFixed(2)}`);
  }
});

test('dark: solid fills keep their colour (white text on them), and always-dark panels keep the light palette', () => {
  assert.deepEqual(base['[data-theme="dark"] .bg-rose-600'], { backgroundColor: colors.rose[600] });
  assert.ok(ratio([255, 255, 255], rgb(L['--tw-emerald-700'])) >= 4.5, 'white on emerald-700');
  const panel = Object.keys(base).find(k => k.includes('.surface-deep'));
  assert.ok(panel && base[panel]['--tw-slate-300'] === L['--tw-slate-300'], 'inside .surface-deep, slate-300 is the light (pale) one');
  const white = Object.keys(base).find(k => k.includes('.bg-white'));
  assert.deepEqual(base[white], { backgroundColor: 'var(--c-card)' }, 'a white surface is the dark card');
});

test('pre-paint script, store and menu agree', () => {
  const html = fs.readFileSync(path.join(REPO, 'client/index.html'), 'utf8');
  const store = fs.readFileSync(path.join(REPO, 'client/src/state/theme.tsx'), 'utf8');
  const menu = fs.readFileSync(path.join(REPO, 'client/src/components/MoreMenu.tsx'), 'utf8');
  const key = store.match(/THEME_KEY = '([^']+)'/)[1];
  assert.ok(html.includes(`localStorage.getItem('${key}')`), 'index.html reads the same key before first paint');
  assert.match(html, /prefers-color-scheme: dark/, 'and follows the system when nothing is chosen');
  assert.match(html, /setAttribute\('data-theme'/);
  for (const id of ['system', 'light', 'dark']) assert.match(menu, new RegExp(`id: '${id}'`), `the More menu offers ${id}`);
  const main = fs.readFileSync(path.join(REPO, 'client/src/main.tsx'), 'utf8');
  assert.match(main, /<ThemeProvider>/, 'the store wraps the app');
  const app = fs.readFileSync(path.join(REPO, 'client/src/App.tsx'), 'utf8');
  assert.match(app, /<MoreMenu \/>/, 'the header shows the More menu');
});

test('the War Room planner follows the app theme and keeps none of its own', () => {
  // The full-screen shell (WarRoomV2 + useDocTheme) is retired; its parts render inside the app frame.
  for (const f of ['WarRoomV2.tsx', 'useDocTheme.ts']) assert.ok(!fs.existsSync(path.join(REPO, 'client/src/components/warroom', f)), `${f} is gone`);
  for (const f of fs.readdirSync(path.join(REPO, 'client/src/components/warroom')).filter(x => /\.tsx$/.test(x))) {
    const src = fs.readFileSync(path.join(REPO, 'client/src/components/warroom', f), 'utf8');
    assert.doesNotMatch(src, /useState<'light' \| 'dark'>|data-theme=/, `${f} has no theme state of its own`);
  }
});
