/**
 * Real public-league history (Sleeper) for the Team Outlook — the pure parsing layer.
 *
 * Plan section 00.2d-bis: thousands of completed redraft league-seasons with real
 * managers, used to measure how much early-season results actually mean. These tests
 * pin the parsing so a malformed league can never become a silently wrong outcome.
 * Fixtures are copied from the real API shapes (league 289646328504385536, 2018).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isEligibleLeague, scoringType, regularSeasonWeeks, playoffTeams, champion,
  buildTeamSeasons, allPlayByWeek,
} from '../server/services/sleeper-history.js';

const league = (over = {}) => ({
  league_id: 'L1', season: '2024', status: 'complete', sport: 'nfl',
  settings: { type: 0, num_teams: 4, playoff_teams: 2, playoff_week_start: 4, best_ball: 0, ...(over.settings ?? {}) },
  scoring_settings: { rec: 1, ...(over.scoring_settings ?? {}) },
  roster_positions: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BN'],
  ...Object.fromEntries(Object.entries(over).filter(([k]) => !['settings', 'scoring_settings'].includes(k))),
});

test('eligibility: completed redraft NFL leagues of 8-14 teams with real playoffs only', () => {
  const ok = league({ settings: { num_teams: 10, playoff_teams: 4, playoff_week_start: 15 } });
  assert.equal(isEligibleLeague(ok, { seasons: [2024] }), true);
  assert.equal(isEligibleLeague({ ...ok, status: 'in_season' }, { seasons: [2024] }), false, 'not finished');
  assert.equal(isEligibleLeague({ ...ok, season: '2019' }, { seasons: [2024] }), false, 'outside the seasons');
  assert.equal(isEligibleLeague(league({ settings: { type: 2, num_teams: 10, playoff_teams: 4, playoff_week_start: 15 } }), { seasons: [2024] }), false, 'dynasty');
  assert.equal(isEligibleLeague(league({ settings: { best_ball: 1, num_teams: 10, playoff_teams: 4, playoff_week_start: 15 } }), { seasons: [2024] }), false, 'best ball has no managed lineups');
  assert.equal(isEligibleLeague(league({ settings: { num_teams: 6, playoff_teams: 2, playoff_week_start: 15 } }), { seasons: [2024] }), false, 'too small');
  assert.equal(isEligibleLeague(league({ settings: { num_teams: 10, playoff_teams: 0, playoff_week_start: 15 } }), { seasons: [2024] }), false, 'no playoffs');
  assert.equal(isEligibleLeague(league({ settings: { num_teams: 10, playoff_teams: 4, playoff_week_start: 9 } }), { seasons: [2024] }), false, 'implausible playoff start');
  assert.equal(isEligibleLeague(null, { seasons: [2024] }), false);
});

test('scoring type and the regular-season weeks', () => {
  assert.equal(scoringType({ rec: 1 }), 'ppr');
  assert.equal(scoringType({ rec: 0.5 }), 'half');
  assert.equal(scoringType({ rec: 0 }), 'std');
  assert.equal(scoringType({}), 'std');
  assert.deepEqual(regularSeasonWeeks(league({ settings: { playoff_week_start: 4 } })), [1, 2, 3]);
});

// The real 2018 bracket: six teams, champion roster 6 (the p:1 match).
const BRACKET = [
  { m: 1, r: 1, l: 5, w: 1, t1: 5, t2: 1 }, { m: 2, r: 1, l: 10, w: 2, t1: 2, t2: 10 },
  { m: 3, r: 2, l: 1, w: 6, t1: 6, t2: 1, t2_from: { w: 1 } }, { m: 4, r: 2, l: 2, w: 3, t1: 3, t2: 2, t2_from: { w: 2 } },
  { m: 5, p: 5, r: 2, l: 5, w: 10, t1: 5, t2: 10 }, { m: 6, p: 1, r: 3, l: 3, w: 6, t1: 6, t2: 3 },
  { m: 7, p: 3, r: 3, l: 2, w: 1, t1: 1, t2: 2 },
];

test('playoff teams come from the bracket (byes included) and the champion from the title game', () => {
  assert.deepEqual([...playoffTeams(BRACKET)].sort((a, b) => a - b), [1, 2, 3, 5, 6, 10]);
  assert.equal(champion(BRACKET), 6);
  // No placement flags: the final is the last-round match that is not a consolation game.
  assert.equal(champion([{ m: 1, r: 1, w: 2, l: 1, t1: 1, t2: 2 }, { m: 2, r: 2, w: 3, l: 2, t1: 3, t2: 2 }]), 3);
  assert.equal(champion([]), null);
  assert.equal(champion(null), null);
});

// Four teams, three regular-season weeks; roster 4 misses week 3 (no row).
const MATCHUPS = {
  1: [{ roster_id: 1, matchup_id: 1, points: 100, starters: ['a', 'b'] }, { roster_id: 2, matchup_id: 1, points: 90, starters: ['c'] },
      { roster_id: 3, matchup_id: 2, points: 120, starters: [] }, { roster_id: 4, matchup_id: 2, points: 80, starters: [] }],
  2: [{ roster_id: 1, matchup_id: 1, points: 70, starters: [] }, { roster_id: 3, matchup_id: 1, points: 110, starters: [] },
      { roster_id: 2, matchup_id: 2, points: 95, starters: [] }, { roster_id: 4, matchup_id: 2, points: 95, starters: [] }],
  3: [{ roster_id: 1, matchup_id: 1, points: 130, starters: [] }, { roster_id: 4, matchup_id: 1, points: 0, starters: [] },
      { roster_id: 2, matchup_id: 2, points: 60, starters: [] }, { roster_id: 3, matchup_id: 2, points: 100, starters: [] }],
};

test('all-play counts wins against every other team that week, ties as half', () => {
  const ap = allPlayByWeek(MATCHUPS, [1, 2, 3]);
  assert.equal(ap.get(1)[0], 2 / 3);      // week 1: 100 beats 90 and 80, loses to 120
  assert.equal(ap.get(2)[1], 0.5);        // week 2: 95 beats 70, ties 95, loses to 110 -> 1.5/3
  assert.equal(ap.get(4)[1], 0.5);
  assert.equal(ap.get(1)[2], 1);          // week 3: 130 beats everyone
});

test('team-seasons: record, points, max points, seed, playoffs, champion, weekly rows with opponents', () => {
  const rosters = [
    { roster_id: 1, owner_id: 'u1', settings: { wins: 2, losses: 1, ties: 0, fpts: 300, fpts_decimal: 0, fpts_against: 285, fpts_against_decimal: 0, ppts: 340, ppts_decimal: 50 } },
    { roster_id: 2, owner_id: 'u2', settings: { wins: 1, losses: 1, ties: 1, fpts: 245, fpts_decimal: 0, fpts_against: 270, fpts_against_decimal: 0, ppts: 270, ppts_decimal: 0 } },
    { roster_id: 3, owner_id: 'u3', settings: { wins: 3, losses: 0, ties: 0, fpts: 330, fpts_decimal: 0, fpts_against: 210, fpts_against_decimal: 0, ppts: 360, ppts_decimal: 0 } },
    { roster_id: 4, owner_id: 'u4', settings: { wins: 0, losses: 2, ties: 1, fpts: 175, fpts_decimal: 0, fpts_against: 285, fpts_against_decimal: 0 } },
  ];
  const bracket = [{ m: 1, r: 1, w: 3, l: 1, t1: 3, t2: 1, p: 1 }];
  const { teams, weeks } = buildTeamSeasons(league(), rosters, MATCHUPS, bracket);
  const byId = Object.fromEntries(teams.map(t => [t.roster_id, t]));
  assert.equal(byId[1].points_for, 300);
  assert.equal(byId[1].max_points, 340.5);
  assert.equal(byId[4].max_points, null, 'missing max points stays null, not 0');
  assert.equal(byId[3].reg_seed, 1);
  assert.equal(byId[1].reg_seed, 2);
  assert.equal(byId[2].reg_seed, 3, 'ties count as half a win in the standings');
  assert.equal(byId[3].made_playoffs, 1);
  assert.equal(byId[2].made_playoffs, 0);
  assert.equal(byId[3].champion, 1);
  assert.equal(byId[1].champion, 0);
  assert.ok(!('owner_id' in byId[1]), 'no owner identifiers are stored');
  const w1 = weeks.filter(w => w.week === 1 && w.roster_id === 1)[0];
  assert.equal(w1.opponent_roster_id, 2);
  assert.equal(w1.points, 100);
  assert.deepEqual(JSON.parse(w1.starters_json), ['a', 'b']);
  assert.equal(weeks.filter(w => w.roster_id === 4 && w.week === 3)[0].points, 0);
});
