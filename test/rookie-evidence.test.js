import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../server/services/nfl-rookie-ingest.js';

test('combine percentiles respect metric direction and ties', () => {
  assert.equal(__test.percentile([4.3, 4.4, 4.5], 4.3, false), 1);
  assert.equal(__test.percentile([30, 35, 40], 40, true), 1);
  assert.equal(__test.percentile([10, 10, 20], 10, true), 0.25);
});
