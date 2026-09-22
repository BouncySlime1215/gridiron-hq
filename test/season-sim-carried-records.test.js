/**
 * The record a simulation carries in has to be a record that was played.
 *
 * `initialRecords` reads a league's stored schedule to seed the simulated window with the wins
 * and points a team has already earned, and `fromWeek` is CALLER-SUPPLIED: a `from_week` query
 * parameter on `/simulate`, and `target.week` from the trade engine's horizon read. Nothing
 * bounds it to the weeks a league has actually played.
 *
 * It used to admit any period before `fromWeek` whose two sides carried finite numbers. An
 * unplayed ESPN period comes back `0-0` -- two finite numbers -- so it was a tie, so half a win
 * to each team. The result says `standings_carried_in: true`, which tells a reader these are the
 * league's real standings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-carried-records-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { __test } = await import('../server/services/season-sim.js');
const TEAMS = ['1', '2', '3', '4'].map(roster_id => ({ roster_id }));

/** An ESPN payload: `weeksPlayed` real weeks, the rest present and UNDECIDED at 0-0. */
function espn({ weeksPlayed = 2, regularPeriods = 13, inProgress = null } = {}) {
  const schedule = [];
  for (let w = 1; w <= regularPeriods; w++) {
    const live = w === inProgress;
    const played = w <= weeksPlayed;
    schedule.push({ matchupPeriodId: w, winner: played && !live ? 'HOME' : 'UNDECIDED',
      home: { teamId: 1, totalPoints: live ? 58.4 : played ? 110 + w : 0 },
      away: { teamId: 2, totalPoints: live ? 41.2 : played ? 90 + w : 0 } });
    schedule.push({ matchupPeriodId: w, winner: played && !live ? 'AWAY' : 'UNDECIDED',
      home: { teamId: 3, totalPoints: live ? 30.0 : played ? 80 + w : 0 },
      away: { teamId: 4, totalPoints: live ? 44.5 : played ? 120 + w : 0 } });
  }
  return { id: 7, league_id: 'L7', season: 2026, payload_season: 2026,
    payload: JSON.stringify({ teams: [1, 2, 3, 4].map(id => ({ id })), schedule,
      settings: { scheduleSettings: { matchupPeriodCount: regularPeriods, playoffTeamCount: 2 } } }) };
}

const summarise = recs => Object.fromEntries(
  [...recs.entries()].map(([id, r]) => [id, { w: r.w, pf: Math.round(r.pf) }]));

test('a window opened past the played weeks carries no wins from the weeks not played', () => {
  // THE MEASUREMENT. Two weeks played, window opened at 14: eleven unplayed periods, each one
  // formerly a 0-0 tie, each formerly worth half a win to both sides. 5.5 wins per team.
  const lg = espn({ weeksPlayed: 2, regularPeriods: 13 });
  const atThree = summarise(__test.initialRecords(lg, TEAMS, 3));
  const atFourteen = summarise(__test.initialRecords(lg, TEAMS, 14));

  assert.deepEqual(atThree, {
    1: { w: 2, pf: 223 }, 2: { w: 0, pf: 183 }, 3: { w: 0, pf: 163 }, 4: { w: 2, pf: 243 }
  }, 'the two real weeks, as the schedule records them');
  assert.deepEqual(atFourteen, atThree,
    'opening the window later cannot invent a result that has not happened');

  // Said as the defect rather than as the fix, so the assertion cannot pass vacuously on a
  // function that stopped reading the schedule at all.
  for (const [id, r] of Object.entries(atFourteen)) {
    assert.equal(Number.isInteger(r.w), true, `team ${id} has a whole number of wins`);
    assert.ok(r.pf > 100, `team ${id} still carries its real points (${r.pf})`);
  }
});

test('the record and the points cannot disagree, which is what the old bug looked like', () => {
  // The signature of the defect: an unplayed week added 0.5 wins and 0 points, so a team with
  // the fewest points in the league carried 5.5 wins. Any team with no wins must have fewer
  // points than the team that beat it, every week.
  const recs = __test.initialRecords(espn({ weeksPlayed: 2 }), TEAMS, 14);
  const byId = summarise(recs);
  assert.ok(byId[1].w > byId[2].w && byId[1].pf > byId[2].pf, 'winner outscored loser');
  assert.ok(byId[4].w > byId[3].w && byId[4].pf > byId[3].pf);
  const totalWins = Object.values(byId).reduce((s, r) => s + r.w, 0);
  assert.equal(totalWins, 4, 'two weeks, two matchups each: four wins exist in total');
});

test('a week in progress is not a result, even with real points on the board', () => {
  // A partial 58.4 is a plausible weekly score, and awarding the win from it is a result the
  // league does not have yet. Only `winner` can tell; the zero test cannot see this one.
  const lg = espn({ weeksPlayed: 3, regularPeriods: 13, inProgress: 3 });
  const recs = summarise(__test.initialRecords(lg, TEAMS, 14));
  assert.equal(Object.values(recs).reduce((s, r) => s + r.w, 0), 4,
    'weeks 1 and 2 only: the week being played is not counted');
  assert.equal(recs[1].pf, 223, 'and its partial points are not banked either');
});

test('a Sleeper league gets the same rule, and it had the same bug', () => {
  // Sleeper carries no `winner`, so the zero test is the whole test there. An unplayed week is
  // two zeroes in `matchups`, and it was a tie.
  const matchups = {};
  for (let w = 1; w <= 13; w++) {
    const played = w <= 2;
    matchups[w] = [
      { matchup_id: 1, roster_id: 1, points: played ? 110 + w : 0 },
      { matchup_id: 1, roster_id: 2, points: played ? 90 + w : 0 },
      { matchup_id: 2, roster_id: 3, points: played ? 80 + w : 0 },
      { matchup_id: 2, roster_id: 4, points: played ? 120 + w : 0 }
    ];
  }
  const lg = { id: 8, league_id: 'S8', platform: 'sleeper', season: 2026,
    payload: JSON.stringify({ matchups }) };
  const recs = summarise(__test.initialRecords(lg, TEAMS, 14));
  assert.equal(Object.values(recs).reduce((s, r) => s + r.w, 0), 4);
  assert.deepEqual(recs, {
    1: { w: 2, pf: 223 }, 2: { w: 0, pf: 183 }, 3: { w: 0, pf: 163 }, 4: { w: 2, pf: 243 }
  });
});

test('a real shutout is still a win, on both platforms', () => {
  // `anyPoints` is `||` and not `&&` for this. A 0 on one side of a completed week is a result,
  // and dropping it would be the same class of error in the other direction.
  const lg = espn({ weeksPlayed: 1, regularPeriods: 13 });
  const payload = JSON.parse(lg.payload);
  for (const m of payload.schedule) {
    if (m.matchupPeriodId !== 1) continue;
    if (m.home.teamId === 1) m.away.totalPoints = 0;
  }
  const recs = summarise(__test.initialRecords({ ...lg, payload: JSON.stringify(payload) }, TEAMS, 14));
  assert.equal(recs[1].w, 1, 'the team that scored still won');
  assert.equal(recs[2].w, 0);
  assert.equal(recs[2].pf, 0, 'and its zero is its real points, not a missing week');
});

test('both readers of this schedule use one rule, not two', () => {
  // The unification the fix is for: `espnWeeklyRows` reads the same schedule for weekly scores
  // and had the stricter rule all along. Two readers of one quantity with two rules is how a
  // league ends up with two records, so the rule has one home and this asserts it is imported
  // rather than re-implemented here.
  const src = fs.readFileSync('server/services/season-sim.js', 'utf8');
  assert.match(src, /import \{ periodPlayed \} from '\.\/espn-weekly-scores\.js'/);
  assert.equal(/UNDECIDED/.test(src), false,
    'no second copy of the marker: the rule is not re-derived here');
});
