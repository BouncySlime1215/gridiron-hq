/**
 * Today and the header hold their places while the War Room plans load (5-10 s after a server
 * restart): the hero and the title-odds chip used to be absent, then popped in above the page.
 * Source-level (the pages are TSX with no DOM here); the browser check measured the layout
 * shift when the plans land at under 0.002 at 375, 768 and 1440 px.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('Today draws the hero placeholder while the plans are loading, and only then', () => {
  const src = read('client/src/pages/Today.tsx');
  assert.match(src, /\{activeId != null && wr\.loading && !wr\.data && <TodaySkeleton \/>\}/);
  assert.match(src, /function TodaySkeleton\(\)[\s\S]*className="today-skel mb-8" aria-busy="true"/);
  const css = read('client/src/styles/ui.css');
  assert.match(css, /\.today-skel-hero \{ min-height: 807px; \}/, 'the phone hero height it arrives at');
  assert.match(css, /@media \(min-width: 700px\) \{ \.today-skel-hero \{ min-height: 540px; \} \}/);
});

test('the header draws the title-odds chip placeholder while the plans are loading', () => {
  const coach = read('client/src/components/AppCoach.tsx');
  assert.match(coach, /const loading = activeId != null && wr\.loading && !wr\.data;/);
  assert.match(coach, /\{loading && <>[\s\S]*data-testid="app-odds-skeleton"[\s\S]*<\/>\}/);
  assert.match(read('client/src/state/coach.tsx'), /loading\?: boolean;/);
});
