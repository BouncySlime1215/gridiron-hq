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
