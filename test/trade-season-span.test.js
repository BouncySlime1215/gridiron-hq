/**
 * The season number in the trade explanation, and the weeks it actually covers.
 *
 * `season_delta` is the weekly lineup gain multiplied out. The explain prompt
 * told the model it was "a full 17-week season" every time, on every date — so
 * in week 15 a gain worth three more weeks was described to it as seventeen,
 * and the model reasoned about a number five times the real one.
 *
 * The lineup diff now serves what it actually multiplied by
 * (`season_delta_weeks`) and whether that is the weeks left or a season-length
 * default (`season_delta_basis`, feature audit D11, frozen at b048c86). This
 * pins that the sentence follows the served fields, and that a payload without
 * them keeps the old wording rather than inventing a count.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtSeasonSpan } from '../server/routes/trades.js';

test('D11a: the weeks left are named, in the plural the count calls for', () => {
  assert.match(fmtSeasonSpan({ season_delta_weeks: 3, season_delta_basis: 'weeks_remaining' }),
    /3 weeks left/);
  assert.match(fmtSeasonSpan({ season_delta_weeks: 1, season_delta_basis: 'weeks_remaining' }),
    /1 week left/);
  assert.doesNotMatch(fmtSeasonSpan({ season_delta_weeks: 1, season_delta_basis: 'weeks_remaining' }),
    /1 weeks/, 'a prompt that says "1 weeks" is a prompt the model marks down');
});

test('D11b: a season-length default says it is a default, not a measurement of this season', () => {
  const s = fmtSeasonSpan({ season_delta_weeks: 17, season_delta_basis: 'full_season_default' });
  assert.match(s, /17/);
  assert.match(s, /default/i, 'the model must not read an assumed span as a known one');
  assert.notEqual(s, fmtSeasonSpan({ season_delta_weeks: 17, season_delta_basis: 'weeks_remaining' }),
    'seventeen weeks left and seventeen weeks assumed are different claims');
});

test('D11c: a payload without the fields keeps today\'s sentence rather than inventing a count', () => {
  // The state of this branch until feature audit\'s change lands: the fields are
  // not served yet, and a guess at the weeks would be worse than the old wording.
  const old = /full 17-week season/;
  assert.match(fmtSeasonSpan({}), old);
  assert.match(fmtSeasonSpan({ season_delta_weeks: null, season_delta_basis: null }), old);
  assert.match(fmtSeasonSpan({ season_delta_weeks: 'four' }), old, 'and a non-number is not a count');
});
