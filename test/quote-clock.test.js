import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteClockValid } from '../server/services/nfl-quote-clock.js';

test('current quote clock rejects malformed, future, expired and started events', () => {
  const now = Date.parse('2026-09-08T12:00:00Z');
  const q = { captured_at: '2026-09-08T11:55:00Z', commence_time: '2026-09-09T00:00:00Z' };
  assert.equal(quoteClockValid(q, now), true);
  for (const patch of [{ captured_at: 'bad' }, { commence_time: null },
    { captured_at: '2026-09-08T12:01:00Z' }, { captured_at: '2026-09-08T11:44:00Z' },
    { commence_time: '2026-09-08T12:00:00Z' }]) {
    assert.equal(quoteClockValid({ ...q, ...patch }, now), false);
  }
});
