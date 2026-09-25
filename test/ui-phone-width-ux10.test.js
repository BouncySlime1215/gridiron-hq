// UX-10: phone-width fixes (Leagues raw table, Trade Lab 6-tab strip, Teams grid truncation).
//
// The app has no jsdom/testing-library/Playwright dependency (checked: neither is in
// package-lock.json), and jsdom has no real layout engine anyway, so a literal
// scrollWidth-vs-clientWidth assertion isn't available inside `npm test`. These tests
// instead assert on the exact source-level properties that determine phone-width
// behaviour: the Tailwind classes Nick's audit named as the defect (UX-01-audit.md,
// docs/handoff/local/ui/UX-01-audit.md), so a regression back to the old classes fails
// the suite. The DOM-width assertion (real Chrome, 375px viewport, scrollWidth vs
// clientWidth) was run manually against the live dev server and is recorded with its
// exact JS output in docs/tdd/2026-09-23-ux-10-phone-width.tdd.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// Drop JS block/line comments and JSX {/* */} comments so assertions only see real code.
const stripComments = (src) => src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// 375px phone viewport minus main's p-4 (16px each side) = 343px of content width.
const PHONE_CONTENT_PX = 375 - 2 * 16;
// Unprefixed (applies at phone width) fixed `w-*` / `min-w-*` classes wider than the phone
// content box. Responsive-prefixed ones (sm:w-..., [&_x]:w-...) are skipped because the
// token must start at a class boundary. max-w-* never forces width, so it is not matched.
function oversizeWidths(src) {
  const out = [];
  const re = /(?<=^|[\s"'`{])(min-w|w)-(?:\[(\d+(?:\.\d+)?)(px|rem)\]|(\d+(?:\.\d+)?))(?=$|[\s"'`}])/g;
  for (const m of stripComments(src).matchAll(re)) {
    const px = m[2] ? Number(m[2]) * (m[3] === 'rem' ? 16 : 1) : Number(m[4]) * 4;
    if (px > PHONE_CONTENT_PX) out.push(`${m[0]} (${px}px)`);
  }
  return out;
}

test('Leagues.tsx: the roster table has a mobile card fallback, not just overflow-x-auto', () => {
  const src = read('client/src/pages/Leagues.tsx');
  // The old defect: a bare `overflow-x-auto` wrapper around the <table> with nothing
  // else for narrow screens, so 375px scrolls horizontally (UX-01-audit.md line 11).
  const tableWrap = src.match(/<div className="([^"]*overflow-x-auto[^"]*)">\s*<table/);
  assert.ok(tableWrap, 'expected the table to still be wrapped for wide screens');
  assert.match(tableWrap[1], /hidden/, 'table wrapper must be hidden below the mobile breakpoint (e.g. "hidden sm:block overflow-x-auto")');
  // A sibling mobile-only card list must exist so roster data is still reachable at 375px.
  // Anchored to the real element (class attribute immediately followed by the roster map),
  // with comments stripped, so a comment mentioning "sm:hidden" cannot satisfy it.
  const code = stripComments(src);
  assert.match(
    code,
    /<div className="[^"]*\bsm:hidden\b[^"]*">\s*\{analysis\.rosters\.map/,
    'expected a sm:hidden element whose direct child is {analysis.rosters.map(...)} (the phone card list)',
  );
  assert.equal((code.match(/analysis\.rosters\.map/g) || []).length, 2, 'roster data must be rendered twice: desktop table + phone cards');
});

test('Trades: the view tabs wrap instead of relying on horizontal scroll (Trade Lab\'s strip is gone)', () => {
  // UI consolidation: Trade Lab's 6-tab strip was retired; its tools are views of the Trades area.
  const src = read('client/src/pages/Trades.tsx');
  assert.match(src, /<div className="mb-5 ds-tabs-wrap"><Tabs label="Trades views"/, 'the Trades tab row opts into wrapping');
  assert.match(read('client/src/styles/ui.css'), /\.ds-tabs-wrap \.ds-tabs \{ flex-wrap: wrap;[^}]*overflow-x: visible; \}/,
    'tab bar should wrap tabs onto more than one line instead of scrolling (UX-01-audit.md: 6 tabs truncate to 4 at 375px)');
});

test('Teams.tsx: the per-division team grid reflows to one column on phones', () => {
  const src = read('client/src/pages/Teams.tsx');
  const grid = src.match(/<div className="(grid grid-cols-2[^"]*)">/);
  assert.equal(grid, null, 'the inner team grid must not be a bare grid-cols-2 (no reflow below any breakpoint) — UX-01-audit.md: Teams.tsx:27');
  assert.match(src, /grid-cols-1 sm:grid-cols-2/, 'expected the team grid to start at 1 column and widen at sm+');
});

test('Teams.tsx: team names wrap at word boundaries instead of being cut mid-word', () => {
  const src = read('client/src/pages/Teams.tsx');
  const nameLine = src.match(/<div className="([^"]*)">\{t\.name\}<\/div>/);
  assert.ok(nameLine, 'expected to find the team name element');
  assert.doesNotMatch(nameLine[1], /\btruncate\b/, 'team name must not use `truncate` (audit: "New Englan…" mid-word cut, Teams.tsx:27)');
  assert.match(nameLine[1], /break-words/, 'expected the team name to wrap at word boundaries via break-words');
});

// Width guards (skeptic, 2026-09-23): no test previously failed when a fixed width wider
// than the phone forced horizontal page scroll. These assert the source-level cause of
// scrollWidth > clientWidth at 375px on the three routes and their shared <main>.
test('App.tsx: <main> keeps min-w-0 and no fixed width wider than a phone', () => {
  const src = read('client/src/App.tsx');
  const main = src.match(/<main className="([^"]*)"/);
  assert.ok(main, 'expected the <main> element');
  assert.match(main[1], /(?:^|\s)min-w-0(?:\s|$)/, '<main> is a flex child: without min-w-0 its content can push the page wider than 375px');
  assert.deepEqual(oversizeWidths(`"${main[1]}"`), [], '<main> must not carry a fixed width wider than the phone content box');
});

for (const file of ['client/src/pages/Leagues.tsx', 'client/src/pages/TradeLab.tsx', 'client/src/pages/Teams.tsx']) {
  test(`${file}: no unprefixed w-*/min-w-* class wider than ${PHONE_CONTENT_PX}px`, () => {
    assert.deepEqual(oversizeWidths(read(file)), [], 'a fixed width wider than the phone content box forces horizontal scroll at 375px');
  });
}

test('Trades/Teams: wrapping containers do not opt back into nowrap', () => {
  const tabBar = read('client/src/pages/Trades.tsx').match(/<div className="([^"]*ds-tabs-wrap[^"]*)">/);
  assert.ok(tabBar);
  assert.doesNotMatch(tabBar[1], /whitespace-nowrap|flex-nowrap/, 'the tab bar itself must wrap');
  const name = read('client/src/pages/Teams.tsx').match(/<div className="([^"]*)">\{t\.name\}<\/div>/);
  assert.ok(name);
  assert.doesNotMatch(name[1], /whitespace-nowrap/, 'team names must be allowed to wrap');
});
