/**
 * The weekly scores that have been sitting unparsed in `leagues.payload` (2026-09-20).
 *
 * `routes/leagues.js:125` requests `view=mMatchup` and `:160` stores the whole ESPN
 * response, so `schedule[].home.totalPoints` has been in the database since the first sync
 * and nothing read it. Several consumers want it -- the Team Outlook panel, the luck read,
 * and four thresholds with no per-week scores to compute against -- so it is ONE parser with
 * one name, on no model, rather than a parser per consumer.
 *
 * THE ROW THAT MUST NOT EXIST is what most of this file is about. ESPN returns the whole
 * season's schedule, and an unplayed matchup comes back `totalPoints: 0`,
 * `winner: 'UNDECIDED'`. One admitted zero is not one bad row: every consumer that
 * standardises computes the league's mean and spread from the rows it is given, so a false
 * zero moves the scale and every OTHER week's z-score is wrong too -- and the team with the
 * most unplayed weeks reads as the worst team in the league.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { espnWeeklyRows } = await import('../server/services/espn-weekly-scores.js');

/**
 * An ESPN payload in the shape `routes/leagues.js` stores. Four teams, `weeksPlayed` weeks
 * played out of `regularPeriods`, the rest present and UNDECIDED as ESPN really returns them,
 * plus two playoff periods beyond the regular season.
 */
function league({ weeksPlayed = 2, regularPeriods = 13, playoffTeamCount = 2,
  scores = null, teams = [1, 2, 3, 4] } = {}) {
  const schedule = [];
  for (let w = 1; w <= regularPeriods; w++) {
    const played = w <= weeksPlayed;
    const pts = t => (played ? (scores?.[t]?.[w - 1] ?? 100 + t * 10 + w) : 0);
    schedule.push({ matchupPeriodId: w, winner: played ? 'HOME' : 'UNDECIDED',
      home: { teamId: 1, totalPoints: pts(1) }, away: { teamId: 2, totalPoints: pts(2) } });
    schedule.push({ matchupPeriodId: w, winner: played ? 'AWAY' : 'UNDECIDED',
      home: { teamId: 3, totalPoints: pts(3) }, away: { teamId: 4, totalPoints: pts(4) } });
  }
  for (const w of [regularPeriods + 1, regularPeriods + 2]) {
    schedule.push({ matchupPeriodId: w, winner: 'UNDECIDED',
      home: { teamId: 1, totalPoints: 0 }, away: { teamId: 3, totalPoints: 0 } });
  }
  const scheduleSettings = { matchupPeriodCount: regularPeriods };
  if (playoffTeamCount != null) scheduleSettings.playoffTeamCount = playoffTeamCount;
  return {
    id: 7, league_id: 'L7', season: 2026, payload_season: 2026,
    payload: JSON.stringify({ teams: teams.map(id => ({ id, name: `Team ${id}` })),
      schedule, settings: { scheduleSettings } })
  };
}

test('a played week becomes one row per team, with the opponent named', () => {
  const out = espnWeeklyRows(league({ weeksPlayed: 2 }));
  assert.ok(out.ok);
  assert.equal(out.rows.length, 8, 'two weeks x four teams');
  const w1 = out.rows.filter(r => r.week === 1);
  assert.equal(w1.length, 4);
  const one = w1.find(r => r.roster_id === '1');
  assert.equal(one.opponent_roster_id, '2');
  assert.equal(one.points, 111);
  assert.equal(one.season, 2026);
  assert.equal(one.num_teams, 4);
  assert.equal(one.playoff_teams, 2);
  assert.equal(one.league_id, 'L7');
});

test('an unplayed week is never a zero-point row', () => {
  // The whole reason this parser exists rather than a straight read of the schedule.
  const out = espnWeeklyRows(league({ weeksPlayed: 3, regularPeriods: 13 }));
  assert.equal(out.rows.length, 12, 'three played weeks only');
  assert.equal(out.rows.some(r => r.points === 0), false);
  assert.deepEqual([...new Set(out.rows.map(r => r.week))].sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(out.weeks_played, 3);
  assert.equal(out.last_week, 3);
  assert.equal(out.skipped_unplayed, 20, 'ten unplayed weeks x two matchups');
});

test('a completed week with a real zero on one side is kept', () => {
  // `anyPoints` is `||` and not `&&` for exactly this: a team really can be shut out.
  const out = espnWeeklyRows(league({ weeksPlayed: 1, scores: { 1: [0], 2: [88], 3: [90], 4: [70] } }));
  assert.ok(out.ok);
  const zero = out.rows.find(r => r.roster_id === '1');
  assert.equal(zero.points, 0, 'a genuine shutout is a result, not a missing week');
  assert.equal(out.rows.filter(r => r.week === 1).length, 4);
});

test('a future 0-0 is refused even when the payload carries no winner key at all', () => {
  const out = espnWeeklyRows({
    id: 7, league_id: 'L7', season: 2026, payload_season: 2026,
    payload: JSON.stringify({
      teams: [{ id: 1 }, { id: 2 }],
      schedule: [
        { matchupPeriodId: 1, home: { teamId: 1, totalPoints: 105 }, away: { teamId: 2, totalPoints: 99 } },
        { matchupPeriodId: 2, home: { teamId: 1, totalPoints: 0 }, away: { teamId: 2, totalPoints: 0 } }
      ],
      settings: { scheduleSettings: { matchupPeriodCount: 13, playoffTeamCount: 2 } }
    })
  });
  assert.ok(out.ok);
  assert.deepEqual([...new Set(out.rows.map(r => r.week))], [1],
    'with no winner field, the zero pair is the only thing marking an unplayed week');
});

test('playoff periods are not regular-season rows', () => {
  const out = espnWeeklyRows(league({ weeksPlayed: 13, regularPeriods: 13 }));
  assert.equal(out.skipped_postseason, 2);
  assert.equal(out.rows.some(r => r.week > 13), false);
  assert.equal(out.last_week, 13);
});

test('regular_periods is the season length, which is not the weeks played', () => {
  // A consumer deriving weeks-remaining needs this, and the difference is the whole point:
  // two weeks played out of fourteen is not a season with no weeks left.
  const out = espnWeeklyRows(league({ weeksPlayed: 2, regularPeriods: 14 }));
  assert.equal(out.regular_periods, 14);
  assert.equal(out.weeks_played, 2);
  assert.notEqual(out.regular_periods, out.weeks_played);
});

test('a payload with no season length reports null rather than a guess', () => {
  const lg = league({ weeksPlayed: 2, regularPeriods: 13 });
  const payload = JSON.parse(lg.payload);
  delete payload.settings.scheduleSettings.matchupPeriodCount;
  const out = espnWeeklyRows({ ...lg, payload: JSON.stringify(payload) });
  assert.ok(out.ok, 'the scores are still readable');
  assert.equal(out.regular_periods, null,
    'null is a consumer\'s cue to refuse; a number here would be an invented season length');
});

test('the season comes from the payload, not from the league row, when they differ', () => {
  // syncEspnLeague falls back to last season when the current one returns empty rosters, and
  // migration 062_league_payload_season exists to record which one the payload came from.
  const out = espnWeeklyRows({ ...league({ weeksPlayed: 1 }), season: 2026, payload_season: 2025 });
  assert.equal(out.season, 2025);
  for (const r of out.rows) assert.equal(r.season, 2025);
});

test('every row says its outcome is unknown, because the season has not finished', () => {
  const out = espnWeeklyRows(league({ weeksPlayed: 2 }));
  for (const r of out.rows) {
    assert.equal(r.outcome_known, false);
    assert.equal(r.made_playoffs, null, 'null, not 0: a 0 reads as "did not qualify"');
    assert.equal(r.champion, null);
  }
});

test('each unreadable state has its own printable reason', () => {
  const cases = [
    [{ id: 1, league_id: 'L1', payload: null }, /never been synced/i],
    [{ id: 1, league_id: 'L1', payload: '{not json' }, /not readable/i],
    [{ id: 1, league_id: 'L1', payload: JSON.stringify({ teams: [] }) }, /no schedule|mMatchup/i],
    [league({ weeksPlayed: 0 }), /not yet played|no played/i]
  ];
  for (const [lg, pattern] of cases) {
    const out = espnWeeklyRows(lg);
    assert.equal(out.ok, false, JSON.stringify(lg).slice(0, 60));
    assert.deepEqual(out.rows, []);
    assert.match(out.reason, pattern);
    assert.equal(/undefined|null|\[object/.test(out.reason), false,
      `a reason is printed as it stands, so it cannot contain a stray value: ${out.reason}`);
  }
});

test('a matchup with no team id on one side is dropped, not given a null roster', () => {
  const out = espnWeeklyRows({
    id: 7, league_id: 'L7', season: 2026, payload_season: 2026,
    payload: JSON.stringify({
      teams: [{ id: 1 }, { id: 2 }],
      schedule: [{ matchupPeriodId: 1, winner: 'HOME',
        home: { totalPoints: 105 }, away: { teamId: 2, totalPoints: 99 } }],
      settings: { scheduleSettings: { matchupPeriodCount: 13, playoffTeamCount: 2 } }
    })
  });
  assert.ok(out.ok);
  assert.equal(out.rows.length, 1, 'only the side that has an id');
  assert.equal(out.rows[0].roster_id, '2');
  assert.equal(out.rows[0].opponent_roster_id, null, 'and its opponent is named as absent');
});

test('this module imports no model, so any consumer can read scores without one', async () => {
  // The reason it is its own file. A reader that had to import the Team Outlook model to get
  // weekly scores would couple four unrelated consumers to a model none of them use, and the
  // alternative anyone takes in that position is writing a second parser.
  const src = await import('node:fs').then(fs =>
    fs.readFileSync('server/services/espn-weekly-scores.js', 'utf8'));
  const imports = [...src.matchAll(/^import\s.*$/gm)].map(m => m[0]);
  assert.deepEqual(imports, [], `this file must stay dependency-free; found: ${imports.join(' | ')}`);
});
