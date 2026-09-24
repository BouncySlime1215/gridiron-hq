/**
 * Coordinator polish (9/24, from the live War Room audit): the send-when line printed
 * "around 11:00 UTC" and the People Board printed "5 of 2 offers this week".
 * Nick reads Eastern time, and an over-limit week should say it is over the limit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { easternHour, sendWindow } = await import('../server/services/trade-tactics.js');

test('a UTC busiest hour is shown as Eastern clock time, daylight time aware', () => {
  assert.equal(easternHour(11, Date.parse('2026-09-24T12:00:00Z')), '7 AM'); // EDT, UTC-4
  assert.equal(easternHour(11, Date.parse('2026-12-24T12:00:00Z')), '6 AM'); // EST, UTC-5
  assert.equal(easternHour(0, Date.parse('2026-09-24T12:00:00Z')), '8 PM');
});

test('the send window names Eastern time, never UTC', () => {
  const w = sendWindow({ decisions_n: 3, median_hours: 0.12, busiest_hour: 11, actions_n: 88, last_decline_at: null },
    { now: '2026-09-24T12:00:00Z' });
  assert.match(w.why, /around 7 AM ET \(88 actions\)/);
  assert.doesNotMatch(w.why, /UTC/);
});

test('the People Board budget says when the week is over the limit', async () => {
  const { loadWarRoom } = await import('./helpers/warroom-tsx.mjs');
  const wr = await loadWarRoom();
  const { budgetText } = await wr.mod('PeopleBoard');
  assert.equal(budgetText({ used: 5, limit: 2 }), '5 offers this week, over your 2-a-week limit');
  assert.equal(budgetText({ used: 1, limit: 2 }), '1 of 2 offers this week');
  assert.equal(budgetText({ used: 2, limit: null }), '2 offers this week (no weekly limit set)');
});
