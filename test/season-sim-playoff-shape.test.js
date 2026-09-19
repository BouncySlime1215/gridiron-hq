/**
 * The bracket's shape comes from the league, not from a constant.
 *
 * `season-sim.js` played every league's playoffs on NFL weeks 15, 16 and 17, one week
 * per round, while reading `playoffTeamCount` per league from the same payload.
 * matchups.js:392 already said that default was "wrong for leagues 1 and 3 as synced".
 *
 * The fixtures below are the REAL `scheduleSettings` read off the synced leagues on
 * 2026-09-19, not invented ones, because the point of this test is that actual leagues
 * disagree with the constant. League 5 agrees with it and league 4 does not, and both
 * cases have to keep working.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { playoffRounds } = await import('../server/services/season-sim.js');

/** League 5 / league 2 as synced: 14 regular periods, 6 playoff teams, one-week rounds. */
const ESPN_ONE_WEEK_ROUNDS = {
  platform: 'espn',
  payload: JSON.stringify({
    settings: { scheduleSettings: {
      matchupPeriodCount: 14, playoffTeamCount: 6, playoffMatchupPeriodLength: 1,
      matchupPeriods: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [String(i + 1), [i + 1]]))
    } }
  })
};

/** League 4 as synced: 13 regular periods, 4 playoff teams, TWO-week rounds. */
const ESPN_TWO_WEEK_ROUNDS = {
  platform: 'espn',
  payload: JSON.stringify({
    settings: { scheduleSettings: {
      matchupPeriodCount: 13, playoffTeamCount: 4, playoffMatchupPeriodLength: 2,
      matchupPeriods: {
        ...Object.fromEntries(Array.from({ length: 13 }, (_, i) => [String(i + 1), [i + 1]])),
        14: [14, 15], 15: [16, 17]
      }
    } }
  })
};

test('a league whose bracket matches the old constant still gets 15, 16, 17', () => {
  const { rounds, basis } = playoffRounds(ESPN_ONE_WEEK_ROUNDS, 6);
  assert.deepEqual(rounds, [[15], [16], [17]]);
  assert.equal(basis, 'league_schedule');
});

test('a two-week-round league gets its real bracket, which the constant got wrong', () => {
  const { rounds, basis } = playoffRounds(ESPN_TWO_WEEK_ROUNDS, 4);
  // Semifinal over weeks 14-15, final over 16-17. The constant played single weeks 15
  // and 16, so week 14 and week 17 were never simulated and each round was decided on
  // half the points it is really decided on.
  assert.deepEqual(rounds, [[14, 15], [16, 17]]);
  assert.equal(basis, 'league_schedule');
  const weeks = rounds.flat();
  assert.ok(weeks.includes(14), 'week 14 is part of this league\'s playoffs');
  assert.ok(weeks.includes(17), 'and so is week 17');
});

test('the number of rounds is what the field needs, not how many periods are listed', () => {
  // 4 teams need 2 rounds. The one-week-round payload lists 3 playoff periods; a 4-team
  // field must not gain a third round from that.
  const { rounds } = playoffRounds(ESPN_ONE_WEEK_ROUNDS, 4);
  assert.equal(rounds.length, 2);
  assert.deepEqual(rounds, [[15], [16]]);

  // 6 and 8 teams both need 3.
  assert.equal(playoffRounds(ESPN_ONE_WEEK_ROUNDS, 6).rounds.length, 3);
  assert.equal(playoffRounds(ESPN_ONE_WEEK_ROUNDS, 8).rounds.length, 3);
  // 2 teams need 1.
  assert.equal(playoffRounds(ESPN_ONE_WEEK_ROUNDS, 2).rounds.length, 1);
});

test('a schedule with fewer playoff periods than the field needs says so', () => {
  // 8 teams need 3 rounds; this payload lists 2. Inventing a third week that is not in
  // the league's schedule would be worse than reporting the disagreement.
  const short = { platform: 'espn', payload: JSON.stringify({
    settings: { scheduleSettings: {
      matchupPeriodCount: 13, playoffTeamCount: 8,
      matchupPeriods: { 14: [14, 15], 15: [16, 17] }
    } }
  }) };
  const { rounds, basis, rounds_needed } = playoffRounds(short, 8);
  assert.equal(basis, 'league_schedule_short_of_field');
  assert.equal(rounds_needed, 3);
  assert.equal(rounds.length, 2, 'it uses what the league actually lists');
});

test('Sleeper is read from playoff_week_start, one week per round', () => {
  const sleeper = { platform: 'sleeper', payload: JSON.stringify({ settings: { playoff_week_start: 15 } }) };
  assert.deepEqual(playoffRounds(sleeper, 6).rounds, [[15], [16], [17]]);
  assert.equal(playoffRounds(sleeper, 6).basis, 'sleeper_playoff_week_start');

  // A league that starts its bracket earlier is followed, not overridden by the constant.
  const early = { platform: 'sleeper', payload: JSON.stringify({ settings: { playoff_week_start: 14 } }) };
  assert.deepEqual(playoffRounds(early, 4).rounds, [[14], [15]]);
});

test('a payload that cannot answer falls back to the constant, and says which', () => {
  for (const lg of [
    { platform: 'espn', payload: '{"settings":{}}' },
    { platform: 'espn', payload: 'not json at all' },
    { platform: 'espn', payload: null },
    { platform: 'sleeper', payload: '{"settings":{}}' },
    // matchupPeriodCount present but no periods map (an older sync).
    { platform: 'espn', payload: JSON.stringify({ settings: { scheduleSettings: { matchupPeriodCount: 14 } } }) },
    // A periods map that stops at the regular season: no bracket to read.
    { platform: 'espn', payload: JSON.stringify({ settings: { scheduleSettings: {
      matchupPeriodCount: 14,
      matchupPeriods: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [String(i + 1), [i + 1]]))
    } } }) }
  ]) {
    const { rounds, basis } = playoffRounds(lg, 6);
    assert.equal(basis, 'default_weeks_15_17', `expected the fallback for ${String(lg.payload).slice(0, 40)}`);
    assert.deepEqual(rounds, [[15], [16], [17]], 'and the fallback is exactly the old behaviour');
  }
});

test('the fallback is the old behaviour exactly, for any field size', () => {
  // If this ever drifts, a league we cannot read would silently change its odds.
  const unreadable = { platform: 'espn', payload: '{}' };
  assert.deepEqual(playoffRounds(unreadable, 4).rounds, [[15], [16]]);
  assert.deepEqual(playoffRounds(unreadable, 6).rounds, [[15], [16], [17]]);
  assert.deepEqual(playoffRounds(unreadable, 8).rounds, [[15], [16], [17]]);
});

test('malformed week entries inside a real periods map are dropped, not trusted', () => {
  const messy = { platform: 'espn', payload: JSON.stringify({
    settings: { scheduleSettings: {
      matchupPeriodCount: 13, playoffTeamCount: 4,
      matchupPeriods: { 14: [14, 'x', null, 15], 15: [], 16: [16, 17] }
    } }
  }) };
  const { rounds } = playoffRounds(messy, 4);
  // Period 15 is empty and drops out entirely; the surviving rounds keep only real weeks.
  assert.deepEqual(rounds, [[14, 15], [16, 17]]);
});

test('a single-team or zero-team field still produces one round rather than none', () => {
  // ceil(log2(n)) is 0 or negative infinity for these; the bracket loop needs a round
  // to read, so the floor is 1.
  for (const teams of [0, 1, 2]) {
    assert.ok(playoffRounds(ESPN_ONE_WEEK_ROUNDS, teams).rounds.length >= 1, `teams=${teams}`);
  }
});
