/**
 * The fake "data healthy" banner dies in the same change that lands its
 * replacement — Nick's rule, "never a day with neither". These pin both halves
 * so a later edit cannot quietly bring the old one back or leave the app with
 * no freshness surface at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the old setup-status banner component is gone', () => {
  assert.throws(() => read('client/src/components/DataSetupBanner.tsx'),
    /ENOENT/, 'DataSetupBanner.tsx still exists');
});

test('App mounts the freshness banner and not the old one', () => {
  const app = read('client/src/App.tsx');
  assert.match(app, /import DataFreshnessBanner from '\.\/components\/DataFreshnessBanner'/,
    'App does not import the freshness banner');
  assert.match(app, /<DataFreshnessBanner \/>/, 'App does not render the freshness banner');
  assert.doesNotMatch(app, /DataSetupBanner/, 'App still references the old banner');
});

test('the freshness banner reads the freshness endpoint, not setup-status', () => {
  const c = read('client/src/components/DataFreshnessBanner.tsx');
  assert.match(c, /useApi<[^>]*>\('\/data-freshness'\)/, 'the banner does not call /data-freshness');
  assert.doesNotMatch(c, /setup-status/, 'the replacement still calls the fake-healthy endpoint');
});

test('the freshness banner shows a status word for each of the three states', () => {
  const c = read('client/src/components/DataFreshnessBanner.tsx');
  for (const state of ['fresh', 'stale', 'empty']) {
    assert.match(c, new RegExp(`${state}:`), `no rendering path for status "${state}"`);
  }
});

/**
 * The banner's own failure has to be visible, or it repeats the bug it replaced.
 *
 * `useApi` returns `{ data, error }`. The banner's early return was
 * `if (!report || report.all_fresh || dismissed) return null`, which collapses
 * two opposite situations into the same blank screen: "every source is current"
 * and "the freshness check did not run at all". On the second, the user sees no
 * warning and reads it as the first.
 *
 * That is precisely the fake-healthy banner's sin, committed by silence instead
 * of by a green tick, and it is live right now: /api/data-freshness is not
 * mounted (server/index.js belongs to the scheduler thread), so in the running
 * app this request 404s and the banner renders nothing at all.
 */
test('a failed freshness check is not rendered as an all-clear', () => {
  const c = read('client/src/components/DataFreshnessBanner.tsx');
  assert.match(c, /\berror\b/, 'the banner never looks at the request error');

  // Anchored on `if (error` rather than a full spelling: the guard may carry
  // extra conditions (it does — it also honours a dismissal), and a test that
  // pins punctuation fails on a correct change instead of on a wrong one.
  const errorGuard = c.indexOf('if (error');
  const silentReturn = c.indexOf('if (!report');
  // Both indices are checked against -1 first. `indexOf` returning -1 and being
  // compared directly is how an assertion like this passes while testing nothing.
  assert.ok(errorGuard >= 0, 'the banner has no branch for a failed freshness check');
  assert.ok(silentReturn >= 0,
    'the all-clear early return is gone; this test pins its ordering and needs rewriting');
  assert.ok(errorGuard < silentReturn,
    'the silent early return runs before the error branch, so a failed check renders nothing');
});

test('the failed-check message says the absence of a warning means nothing', () => {
  const c = read('client/src/components/DataFreshnessBanner.tsx');
  assert.match(c, /could not be checked/i,
    'nothing tells the user the freshness check itself failed');
  assert.match(c, /not the same as|does not mean|no warning/i,
    'the failure message does not say that silence here is not an all-clear');
});
