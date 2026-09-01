import test from 'node:test';
import assert from 'node:assert/strict';
import { NFL_HISTORICAL_REPLAY_POLICY, NFL_PRODUCTION_POLICY } from '../server/services/nfl-policy.js';

test('historical replay and live publication have explicit different calibration contracts', () => {
  assert.equal(NFL_PRODUCTION_POLICY.requireCalibratedAdvantage, true);
  assert.equal(NFL_HISTORICAL_REPLAY_POLICY.requireCalibratedAdvantage, false);
  assert.equal(NFL_HISTORICAL_REPLAY_POLICY.authority, 'diagnostic_only');
  assert.notEqual(NFL_HISTORICAL_REPLAY_POLICY.id, NFL_PRODUCTION_POLICY.id);
});
