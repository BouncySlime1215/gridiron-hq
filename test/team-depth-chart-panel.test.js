/**
 * The depth-chart panel has to render the honesty the service already computes.
 *
 * `teamDepthChart` picks the freshest of three non-interchangeable listings and
 * returns `source`, `captured`, `stale` and `unavailable_reason` alongside the
 * players — the whole point of that work being that a depth chart is a listing,
 * not a measurement, so the reader must be told which listing and when. All of
 * it is currently served and rendered nowhere: `TeamDetail.tsx` draws depth from
 * the ESPN roster path instead, so no page has ever shown which source it is
 * looking at.
 *
 * Two traps this panel must not walk into, both of which this branch has already
 * hit once elsewhere:
 *
 *   1. A failed request must not render as an empty or absent panel. That is the
 *      bug just fixed in DataFreshnessBanner — silence reading as an all-clear.
 *   2. `snap_share` must be read through `snap_share_basis`. A defender carries
 *      null with basis `not_applicable_to_this_position`, and printing that as
 *      "0%" is exactly the lie the basis field was added to prevent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const PANEL = 'client/src/components/DepthChartPanel.tsx';

test('TeamDetail mounts the depth-chart panel', () => {
  const app = read('client/src/pages/TeamDetail.tsx');
  assert.match(app, /import DepthChartPanel from '\.\.\/components\/DepthChartPanel'/,
    'TeamDetail does not import the panel');
  assert.match(app, /<DepthChartPanel\b/, 'TeamDetail does not render the panel');
});

test('the panel reads the depth-chart route', () => {
  const c = read(PANEL);
  assert.match(c, /useApi<[^>]*>\(\s*`?\/teams\/\$\{[^}]+\}\/depth-chart/,
    'the panel does not call the depth-chart route');
});

test('the panel names which listing it is showing and when it was captured', () => {
  const c = read(PANEL);
  assert.match(c, /\bsource\b/, 'the panel never reads the source');
  assert.match(c, /\bcaptured\b/, 'the panel never reads the capture time');
});

test('an opening-week chart is labelled as one rather than passed off as current', () => {
  const c = read(PANEL);
  assert.match(c, /\bstale\b/, 'the panel ignores the stale flag');
  assert.match(c, /opening[- ]week/i,
    'nothing tells the reader a stale chart is an opening-week ordering');
});

test('no chart on file is said out loud, not rendered as an empty panel', () => {
  const c = read(PANEL);
  assert.match(c, /unavailable_reason/, 'the panel ignores unavailable_reason');
});

test('a failed request is not rendered as an absent panel', () => {
  const c = read(PANEL);
  const errorGuard = c.indexOf('if (error');
  const nullReturn = c.indexOf('return null');
  assert.ok(errorGuard >= 0, 'the panel has no branch for a failed request');
  // -1 checked before comparing: comparing a -1 directly is how this assertion
  // passes while testing nothing.
  assert.ok(nullReturn >= 0, 'the panel no longer has a null return; rewrite this ordering check');
  assert.ok(errorGuard < nullReturn,
    'the panel returns null before looking at the error, so a failed request renders nothing');
});

test('snap share is read through its basis, never printed as a bare zero', () => {
  const c = read(PANEL);
  assert.match(c, /snap_share_basis/,
    'the panel renders snap_share without consulting the basis that says whether it describes the player');
  assert.match(c, /not_applicable_to_this_position/,
    'the panel has no branch for a player the stat cannot describe');
  assert.match(c, /not_measured/,
    'the panel does not distinguish an unmeasured player from a measured zero');
});
