import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAIN_CHECK_IDS } from '../server/services/campaign/plans-schema.js';
import { LIVE_CHECK } from '../server/services/eval/e3.js';

// 9/24 incident: the E3 grader emitted 'E3-live', the plans contract only allowed E1-E7,
// so every league's War Room plan failed validation and the screen went blank.
test('every check id the graders emit is allowed by the plans contract', () => {
  assert.ok(BRAIN_CHECK_IDS.includes(LIVE_CHECK), `${LIVE_CHECK} must be in BRAIN_CHECK_IDS`);
  for (const id of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']) assert.ok(BRAIN_CHECK_IDS.includes(id));
});
