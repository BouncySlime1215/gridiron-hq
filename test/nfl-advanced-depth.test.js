import test from 'node:test';
import assert from 'node:assert/strict';
import { depthChartReleaseUrl, normalizeDepthTeam } from '../server/services/nfl-advanced.js';

test('historical depth sync addresses the published plural uncompressed asset', () => {
  assert.equal(depthChartReleaseUrl(2021),
    'https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_2021.csv');
});

test('historical depth teams join the canonical schedule namespace', () => {
  assert.equal(normalizeDepthTeam('LA'), 'LAR');
  assert.equal(normalizeDepthTeam('JAC'), 'JAX');
  assert.equal(normalizeDepthTeam('OAK'), 'LV');
  assert.equal(normalizeDepthTeam('ARI'), 'ARI');
});
