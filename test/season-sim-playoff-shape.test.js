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

const { playoffRounds, simProjectionBasis, SIM_PROJECTION_MIN_GAMES } = await import('../server/services/season-sim.js');

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

/**
 * Which games the simulator's projections may see.
 *
 * The threshold is two games played, and that is a measured crossover rather than a chosen
 * number: on 2023, 2024 and 2025 independently, switching to this season's log after ONE
 * game made held-out mean absolute error worse (by 0.015, 0.052 and 0.025 points), and from
 * two games on it was better in all three with the advantage growing monotonically. The
 * cause is the season weighting: the current season gets full weight and last season drops
 * to 0.55, so a single game outweighs a complete prior year.
 */
test('week 1 reads last season, because there is nothing else to read', () => {
  const b = simProjectionBasis(1, 2026);
  assert.equal(b.through, 2025);
  assert.equal(b.throughWeek, null);
  assert.match(b.basis, /no games played yet/);
});

test('one game played is still last season, and the basis says why', () => {
  // This is the case that measured WORSE, so it must not switch. If someone later "fixes"
  // this to switch at one game, this test is what stops them.
  //
  // The third argument is how many weeks the usage log actually holds. It used to be absent
  // here, and this test passed while proving nothing about the data -- the function counted
  // the calendar. Every case now has to say what was synced, because that is the number the
  // threshold was measured against.
  const b = simProjectionBasis(2, 2026, 1);
  assert.equal(b.through, 2025);
  assert.equal(b.throughWeek, null);
  assert.match(b.basis, /too little to outweigh/);
});

test('from two games played the simulator reads this season, up to the week before', () => {
  // A log that has kept up with the calendar: every played week synced.
  for (const fromWeek of [3, 5, 9, 14]) {
    const b = simProjectionBasis(fromWeek, 2026, fromWeek - 1);
    assert.equal(b.through, 2026, `week ${fromWeek} reads this season`);
    // Never the week being simulated: that would leak the outcome of the first simulated week.
    assert.equal(b.throughWeek, fromWeek - 1, `week ${fromWeek} stops at ${fromWeek - 1}`);
    assert.match(b.basis, new RegExp(`2026 through week ${fromWeek - 1}`));
  }
});

test('the cutoff is never the week being simulated, at any week', () => {
  for (let w = 1; w <= 18; w++) {
    const b = simProjectionBasis(w, 2026);
    if (b.throughWeek != null) assert.ok(b.throughWeek < w, `week ${w} cutoff ${b.throughWeek} must precede it`);
  }
});

test('a missing or junk week falls back to week 1 rather than reading the future', () => {
  for (const bad of [undefined, null, 0, NaN, 'x']) {
    const b = simProjectionBasis(bad, 2026);
    assert.equal(b.through, 2025, `${String(bad)} falls back`);
    assert.equal(b.throughWeek, null);
  }
});

test('the minimum-games constant is the one the basis actually uses', () => {
  // Guards against the constant and the comparison drifting apart.
  assert.equal(SIM_PROJECTION_MIN_GAMES, 2);
  const atThreshold = simProjectionBasis(SIM_PROJECTION_MIN_GAMES + 1, 2026, SIM_PROJECTION_MIN_GAMES);
  const below = simProjectionBasis(SIM_PROJECTION_MIN_GAMES, 2026, SIM_PROJECTION_MIN_GAMES - 1);
  assert.equal(atThreshold.through, 2026);
  assert.equal(below.through, 2025);
});

/**
 * THE BASIS HAS TO BE MEASURED FROM THE DATA, NOT FROM THE CALENDAR.
 *
 * `simProjectionBasis` derived everything from `fromWeek - 1`: how many games had been
 * played, and therefore which projection world to use. It never asked whether the usage
 * log held those weeks. That is not a labelling nit here, because of the measurement this
 * threshold exists for: switching to this season's log on ONE game makes projections
 * measurably worse (Ja'Marr Chase 17.1 to 12.5 points a game on one week of evidence).
 *
 * nflverse settles a week's stats a day or two after the games -- `scheduler.js`'s
 * `nflverse_weekly_usage` header says so and polls every six hours for exactly that
 * reason. So the calendar routinely runs ahead of the log, and a calendar-only gate
 * selects the basis that measured WORSE while reporting a week count it does not have.
 * It also reads "2026 through week 2" against an empty 2026 log, which is what a fresh
 * volume or a machine in its first hours after a deploy actually has.
 */
test('the log being behind the calendar is what decides the basis, not the week number', () => {
  // Week 6 on the calendar, one week actually synced. One game measured WORSE than last
  // season, so this must not switch -- and it must say why rather than claiming five weeks.
  const behind = simProjectionBasis(6, 2026, 1);
  assert.equal(behind.through, 2025, 'one logged week does not outweigh a complete season');
  assert.equal(behind.throughWeek, null);
  assert.match(behind.basis, /too little to outweigh/);
});

test('an empty log for this season says so, instead of naming a week it cannot read', () => {
  const empty = simProjectionBasis(3, 2026, 0);
  assert.equal(empty.through, 2025);
  assert.equal(empty.throughWeek, null);
  assert.match(empty.basis, /usage log is empty/);
  // The old behaviour: "2026 through week 2", resting on 2021-2025 rows and nothing else.
  assert.doesNotMatch(empty.basis, /2026 through week/);
});

test('a log behind the calendar but past the threshold reads this season and states the gap', () => {
  const partial = simProjectionBasis(6, 2026, 3);
  assert.equal(partial.through, 2026);
  // The cutoff stays the calendar's, which is leak-safe and reads every row that exists up
  // to it. Using the logged COUNT as the cutoff would drop week 4 from a log of 1, 3, 4.
  assert.equal(partial.throughWeek, 5);
  assert.match(partial.basis, /only 3 of those 5 weeks/);
});

test('the logged count can never push the cutoff past the week being simulated', () => {
  // A log claiming more weeks than the calendar allows must not widen the window.
  for (const w of [1, 2, 3, 8, 14]) {
    const b = simProjectionBasis(w, 2026, 99);
    if (b.throughWeek != null) assert.ok(b.throughWeek < w, `week ${w} cutoff ${b.throughWeek}`);
  }
});
