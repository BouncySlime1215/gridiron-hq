import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../server/services/nfl-expert-coordinator.js';

test('weekly diagnosis labels phase, market shape, disagreement, and evidence coverage', () => {
  const experts = new Map([
    ['rulebook', -6], ['player_builder', 7], ['game_replay', 5], ['similar_games', null]
  ]);
  const labels = __test.regimeLabels({ week: 2, marketMargin: 7, marketTotal: 49, experts });
  assert.ok(labels.includes('phase:early'));
  assert.ok(labels.includes('spread:large'));
  assert.ok(labels.includes('total:high'));
  assert.ok(labels.includes('disagreement:high'));
  assert.ok(labels.includes('coverage:sparse'));
});
