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

test('Leagues.tsx: the roster table has a mobile card fallback, not just overflow-x-auto', () => {
  const src = read('client/src/pages/Leagues.tsx');
  // The old defect: a bare `overflow-x-auto` wrapper around the <table> with nothing
  // else for narrow screens, so 375px scrolls horizontally (UX-01-audit.md line 11).
  const tableWrap = src.match(/<div className="([^"]*overflow-x-auto[^"]*)">\s*<table/);
  assert.ok(tableWrap, 'expected the table to still be wrapped for wide screens');
  assert.match(tableWrap[1], /hidden/, 'table wrapper must be hidden below the mobile breakpoint (e.g. "hidden sm:block overflow-x-auto")');
  // A sibling mobile-only card list must exist so roster data is still reachable at 375px.
  assert.match(src, /sm:hidden/, 'expected a sm:hidden mobile card fallback next to the desktop table');
});

test('TradeLab.tsx: the 6-tab strip does not rely on horizontal scroll to reach hidden tabs', () => {
  const src = read('client/src/pages/TradeLab.tsx');
  const tabBar = src.match(/<div className="([^"]*)">\s*\{TABS\.map/);
  assert.ok(tabBar, 'expected to find the TABS.map tab bar container');
  assert.doesNotMatch(tabBar[1], /overflow-x-auto/, 'tab bar must not depend on horizontal scroll (UX-01-audit.md: 6 tabs truncate to 4 at 375px)');
  assert.match(tabBar[1], /flex-wrap/, 'tab bar should wrap tabs onto more than one line instead of scrolling');
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
