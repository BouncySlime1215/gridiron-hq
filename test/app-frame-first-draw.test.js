/**
 * The app frame on first draw (the #420 review and the #419 flag):
 *  - the header's league picker never shrinks to an empty box on a phone (it rendered only its
 *    chevron at 375 px): it keeps a minimum width and truncates the name with an ellipsis, and the
 *    sync-state chip is the icon alone below `sm`;
 *  - nothing jumps when the page fills in: the page area is at least a screen tall (the credit
 *    under it starts below the fold), the freshness bar holds its last height while the check runs,
 *    and the header and My Team draw placeholders at the size of what replaces them.
 * Source-level; the browser measurements are in the PR (layout shift per route and width).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the header league picker keeps room for the name on a phone', () => {
  const sw = read('client/src/components/LeagueSwitcher.tsx');
  assert.match(sw, /className="input league-select min-w-\[5\.5rem\]/, 'the select has a minimum width');
  assert.match(read('client/src/styles/ui.css'), /\.league-select \{ text-overflow: ellipsis;/, 'and truncates with an ellipsis');
  assert.match(sw, /<Icon name="warn" size=\{12\} \/><span className="hidden sm:inline">/, 'the sync chip is icon-only on a phone');
  assert.match(sw, /aria-label=\{active\.connection_status === 'needs_reconnect'/, 'and still names its state for a screen reader');
  assert.match(read('client/src/App.tsx'), /<div className="min-w-\[8rem\] flex-1 sm:flex-none/, 'the picker slot in the header has a floor');
});

test('first draw: the page area is a screen tall and the freshness bar holds its place', () => {
  assert.match(read('client/src/App.tsx'), /<main className="app-main /);
  assert.match(read('client/src/styles/ui.css'), /\.app-main \{ min-height: calc\(100dvh - 3\.5rem\); \}/);
  const bar = read('client/src/components/DataFreshnessBanner.tsx');
  assert.match(bar, /if \(!report && !error && !dismissed && reserved > 0\) \{/, 'a placeholder at the remembered height while the check runs');
  assert.ok(bar.indexOf('if (error') < bar.indexOf('if (!report && !error'), 'a failed check still shows its own message first');
  assert.match(bar, /localStorage\.setItem\(BAR_KEY, '0'\)/, 'an all-clear forgets the height, so no empty bar is held next time');
});

test('first draw: header and My Team placeholders', () => {
  assert.match(read('client/src/components/LeagueSwitcher.tsx'), /if \(loading && !leagues\.length\) return <Skeleton /);
  const mt = read('client/src/pages/MyTeam.tsx');
  assert.match(mt, /\{synced && !sim && simLoading && \(/, 'the title-odds card has a placeholder while the simulation runs');
  assert.match(mt, /\) : lgLoading && <Skeleton className="h-9 w-\[12rem\] max-w-full" \/>\}/, 'the team picker has a same-size placeholder');
});
