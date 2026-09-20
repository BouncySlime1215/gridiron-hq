/**
 * The deep dive, held to the five things that make it a drill-down rather than
 * a marketing panel.
 *
 * The one worth stating up front is layer 4. A drill-down that only explains
 * how a number is built is advertising. This app has numbers that were tested
 * and FAILED — matchups.js:28-63 records a pre-registered out-of-sample test
 * where every defence-vs-position multiplier came out worse than no adjustment,
 * which is why every one of them is hard-coded to 1 with `signal: false` — and
 * a panel that shows that history without the sentence saying it did not
 * predict is worse than showing nothing at all. So layer 4 cannot be silently
 * omitted: `undefined` (the caller forgot) and `null` (the caller is saying it
 * was never tested) are different, and only the second is allowed to be quiet.
 *
 * Same honest limit as the two steps before: node:test, no DOM, so these read
 * source text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const dive = read('client/src/components/ui/DeepDive.tsx');
const design = read('client/src/components/ui/DesignSystem.tsx');
const css = read('client/src/index.css');
const doc = read('docs/design/design-system.md');

test('there are five layers and they are the five the design system names', () => {
  const titles = dive.match(/const LAYER_TITLES = \[(.*?)\] as const/s);
  assert.ok(titles, 'the layer list moved');
  const count = [...titles[1].matchAll(/'[^']+'/g)].length;
  assert.equal(count, 5, `the drawer has ${count} layers; the design system specifies five`);
  assert.match(doc, /Five layers/, 'the document no longer specifies five layers');
});

test('how well it does is never silently missing', () => {
  // undefined = the caller forgot. null = the caller says it was never tested.
  // The first must not render as an absent section, because an absent section
  // reads as "there is nothing to say here" and there always is.
  assert.match(dive, /layers\.tested === undefined/, 'the forgot/never-tested distinction is gone');
  assert.match(dive, /never been tested against a season it was not built on/,
    'the untested sentence is gone, so an untested number now shows no layer at all');
  // And layer 4 is not in the list that can be null-skipped.
  const bodies = dive.slice(dive.indexOf('const bodies'), dive.indexOf('return ('));
  assert.match(bodies, /<div key="4">\{tested\}<\/div>/, 'layer 4 became skippable like the optional ones');
});

test('each input carries its own basis', () => {
  // A measured number built from three assumed ones is not a measured number,
  // and layer 2 is the only place that can say so.
  const iface = dive.slice(dive.indexOf('interface DeepDiveInput'), dive.indexOf('export interface DeepDiveLayers'));
  assert.match(iface, /basis: Basis;/, 'an input can now be listed with no basis');
  assert.doesNotMatch(iface, /basis\?: Basis/, 'an input basis became optional');
  assert.match(dive, /<BasisChip basis=\{input\.basis\}/, 'inputs no longer render their basis');
});

test('the raw column is a footnote, never a heading', () => {
  // A manager should never have to learn a column name to read a page, and an
  // engineer should still be able to find one.
  assert.match(dive, /className="deep-dive-raw"/, 'the raw field lost its own treatment');
  assert.match(css, /\.deep-dive-raw \{[^}]*font-family: var\(--font-mono\)/s, 'the raw field is no longer in the mono face');
  assert.match(css, /\.deep-dive-raw \{[^}]*color: var\(--subtle\)/s, 'the raw field is no longer subordinate');
  const heads = dive.match(/const LAYER_TITLES = \[(.*?)\] as const/s)[1];
  assert.doesNotMatch(heads, /\./, 'a layer title now looks like a column name');
});

test('it opens over the page and not on a route', () => {
  // Nick's own line: "a deep dive into the stats but not new pages". A route
  // loses the number the manager was looking at.
  assert.doesNotMatch(dive, /useNavigate|<Link|react-router/, 'the drawer now navigates');
  assert.match(dive, /import \{ Sheet \} from '\.\/DesignSystem'/, 'the drawer stopped using the one overlay');
});

test('closing puts focus back where the manager was', () => {
  assert.match(dive, /returnFocusTo\?\.current \?\? opener\.current/, 'focus restore is gone');
  assert.match(dive, /document\.contains\(back\)/,
    'focus can now be sent to a removed node, which drops a keyboard user at the top of the document');
});

test('the overlay it is built on traps tab and stops the page scrolling', () => {
  // Both were missing from Sheet, which had no consumer at all. Without the
  // trap, one Tab past the last control lands behind an aria-modal overlay —
  // invisible focus. Without the lock, a swipe over the backdrop moves the page
  // underneath and the manager closes the drawer somewhere else entirely.
  const sheet = design.slice(design.indexOf('export function Sheet'), design.indexOf('export type DataColumn'));
  assert.match(sheet, /e\.key !== 'Tab'/, 'the focus trap is gone');
  assert.match(sheet, /document\.body\.style\.overflow = 'hidden'/, 'the scroll lock is gone');
  assert.match(sheet, /const prev = document\.body\.style\.overflow/,
    'the scroll lock no longer restores what the page had, so two overlays can leave it stuck');
  assert.match(sheet, /ref=\{panelRef\}/, 'the trap has nothing to search');
});

test('one layer at a time, and nothing moves on first paint that should not', () => {
  assert.match(dive, /if \(i > shown - 1 && i !== shown\) return null/, 'every layer now opens at once');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.deep-dive-layer \{ animation: none; \} \}/,
    'the layer reveal no longer respects reduced motion');
  assert.match(css, /animation: dd-reveal var\(--motion-reveal\)/, 'the reveal stopped using the design token');
});
