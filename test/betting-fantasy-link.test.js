import test from 'node:test';
import assert from 'node:assert/strict';
import { bettingModelReliability } from '../server/services/betting-fantasy-link.js';

// This is the machine-readable contract fantasy-side code (and AI narration)
// relies on to know which betting-model signals are validated vs. descriptive
// only. A shape regression here would silently make every consumer trust the
// wrong things.
test('every reliability entry states proven status, a reason, and where the evidence lives', () => {
  const r = bettingModelReliability();
  for (const [key, entry] of Object.entries(r)) {
    assert.ok(['boolean', 'string'].includes(typeof entry.proven), `${key}.proven must be set`);
    assert.ok(entry.because?.length > 20, `${key}.because must explain itself, not just assert`);
    assert.ok(entry.evidence?.length > 0, `${key}.evidence must point somewhere checkable`);
  }
});

test('side-picking is explicitly marked unproven, matching the settled run 17 result', () => {
  assert.equal(bettingModelReliability().side_picking.proven, false);
});

test('player props are explicitly marked proven, matching the baseline gate results', () => {
  assert.equal(bettingModelReliability().player_props.proven, true);
});
