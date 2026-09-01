import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRosterMove } from '../server/services/nfl-player-state.js';

test('official roster moves receive team-facing state transitions', () => {
  assert.deepEqual(classifyRosterMove('Acquired QB Kyle McCord from Green Bay Packers for a pick.'),
    { event_type: 'traded', roster_status: 'active', direction: 'to' });
  assert.deepEqual(classifyRosterMove('Waived RB Example Player.'),
    { event_type: 'waived', roster_status: 'free_agent', direction: 'from' });
  assert.deepEqual(classifyRosterMove('Signed WR Example Player to the practice squad.'),
    { event_type: 'practice_squad_signed', roster_status: 'practice_squad', direction: 'to' });
  assert.deepEqual(classifyRosterMove('Placed LB Example Player on injured reserve.'),
    { event_type: 'reserve', roster_status: 'reserve', direction: 'same' });
  assert.equal(classifyRosterMove('Announced the preseason schedule.'), null);
});

test('trade classifier leaves mirrored-wire direction to player grammar', () => {
  const move = classifyRosterMove('Acquired a pick from Arizona for TE Hunter Long.');
  assert.equal(move.event_type, 'traded');
  assert.equal(move.direction, 'to');
  // The materializer then checks whether “for” occurs before the resolved
  // player; this story is the outgoing side, unlike “Acquired TE Hunter”.
  const normalized = value => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const text = normalized('Acquired a pick from Arizona for TE Hunter Long.');
  assert.ok(text.search(/\b(?:for|in exchange for)\b/) < text.indexOf(normalized('Hunter Long')));
});
