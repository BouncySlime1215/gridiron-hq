/**
 * One of Nick's own leagues, turned into the panel rows the model was fitted on
 * (2026-09-20).
 *
 * The O4 Team Outlook model fits on `data/derived/sleeper_history.sqlite`, and one of
 * Nick's ESPN leagues is not in that corpus. No table in this database holds per-week
 * fantasy team scores either -- checked against `core-and-fantasy.js` and every migration.
 * What does hold them is `leagues.payload`, because `routes/leagues.js:125` requests
 * `view=mMatchup` and `:160` stores the whole ESPN response.
 *
 * So `espnWeeklyRows` reads that payload into `regularSeasonWeeks`'s own row shape and
 * `weeklyPanel` derives the features from it unchanged. These tests are mostly about the
 * rows that must NOT be produced, because every one of them is a silent wrong answer rather
 * than an error.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-league-outlook-rows-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { espnWeeklyRows, fitOutlook, OUTLOOK_FEATURES } = await import('../server/services/team-outlook.js');
const { weeklyPanel } = await import('../server/services/history-corpus.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

/**
 * Four teams, `weeksPlayed` regular-season weeks scored, the rest of a 13-period season
 * present in the schedule but UNDECIDED with zero points -- which is what ESPN returns for
 * a week that has not happened.
 */
function league({ weeksPlayed = 3, regularPeriods = 13, scores = null } = {}) {
  const schedule = [];
  for (let w = 1; w <= regularPeriods; w++) {
    const played = w <= weeksPlayed;
    const pts = t => (played ? (scores?.[t]?.[w - 1] ?? 100 + t * 10 + w) : 0);
    schedule.push({
      matchupPeriodId: w, winner: played ? 'HOME' : 'UNDECIDED',
      home: { teamId: 1, totalPoints: pts(1) }, away: { teamId: 2, totalPoints: pts(2) }
    });
    schedule.push({
      matchupPeriodId: w, winner: played ? 'AWAY' : 'UNDECIDED',
      home: { teamId: 3, totalPoints: pts(3) }, away: { teamId: 4, totalPoints: pts(4) }
    });
  }
  // Two playoff periods, which are not part of a regular-season panel.
  for (const w of [regularPeriods + 1, regularPeriods + 2]) {
    schedule.push({ matchupPeriodId: w, winner: 'UNDECIDED',
      home: { teamId: 1, totalPoints: 0 }, away: { teamId: 3, totalPoints: 0 } });
  }
  return {
    id: 7, league_id: 'L7', season: 2026, payload_season: 2026,
    payload: JSON.stringify({
      teams: [1, 2, 3, 4].map(id => ({ id, name: `Team ${id}` })),
      schedule,
      settings: { scheduleSettings: { matchupPeriodCount: regularPeriods, playoffTeamCount: 2 } }
    })
  };
}

test('a played week becomes one row per team, with the opponent named', () => {
  const out = espnWeeklyRows(league({ weeksPlayed: 2 }));
  assert.ok(out.ok);
  assert.equal(out.rows.length, 8, 'two weeks x four teams');
  const w1 = out.rows.filter(r => r.week === 1);
  assert.deepEqual(w1.map(r => r.roster_id).sort(), ['1', '2', '3', '4']);
  const one = w1.find(r => r.roster_id === '1');
  assert.equal(one.opponent_roster_id, '2');
  assert.equal(one.num_teams, 4);
  assert.equal(one.playoff_teams, 2);
  assert.equal(one.season, 2026);
});

test('an unplayed week is not a zero-point week, at any horizon', () => {
  // THE ROW THAT MUST NOT EXIST. ESPN returns the whole season's schedule, and an unplayed
  // matchup carries totalPoints 0. Admitting it drags the league mean and standard
  // deviation down, so points_z is wrong for every OTHER week too, and the team with the
  // most unplayed weeks reads as the worst team in the league.
  const out = espnWeeklyRows(league({ weeksPlayed: 3, regularPeriods: 13 }));
  assert.deepEqual([...new Set(out.rows.map(r => r.week))].sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(out.rows.length, 12);
  assert.ok(out.rows.every(r => r.points > 0));
  assert.equal(out.skipped_unplayed, 20, 'ten unplayed weeks x two matchups');
  assert.equal(out.weeks_played, 3);
  assert.equal(out.last_week, 3);
});

test('an unplayed week with no winner field at all is still not a played week', () => {
  // The three admission conditions are individually redundant and jointly necessary. This
  // is the case where `anyPoints` is the only protection: some payloads carry no `winner`
  // key, so "decided" reads as true and a 0-0 future week would be admitted on that alone.
  const schedule = [];
  for (let w = 1; w <= 5; w++) {
    const played = w <= 2;
    schedule.push({ matchupPeriodId: w,
      home: { teamId: 1, totalPoints: played ? 110 + w : 0 },
      away: { teamId: 2, totalPoints: played ? 100 + w : 0 } });
  }
  const out = espnWeeklyRows({
    id: 7, league_id: 'L7', season: 2026, payload_season: 2026,
    payload: JSON.stringify({
      teams: [1, 2].map(id => ({ id, name: `Team ${id}` })), schedule,
      settings: { scheduleSettings: { matchupPeriodCount: 13, playoffTeamCount: 2 } }
    })
  });
  assert.deepEqual([...new Set(out.rows.map(r => r.week))], [1, 2]);
  assert.equal(out.skipped_unplayed, 3);
});

test('a playoff period is not a regular-season week', () => {
  const out = espnWeeklyRows(league({ weeksPlayed: 13, regularPeriods: 13 }));
  assert.equal(out.skipped_postseason, 2);
  assert.ok(out.rows.every(r => r.week <= 13));
});

test('a completed week with a real zero on one side is still a played week', () => {
  // The third admission condition exists for this: a team can genuinely score nothing, and
  // dropping the week would be the mirror of admitting an unplayed one.
  const lg = league({ weeksPlayed: 1 });
  const payload = JSON.parse(lg.payload);
  payload.schedule[0].away.totalPoints = 0;
  lg.payload = JSON.stringify(payload);
  const out = espnWeeklyRows(lg);
  const zero = out.rows.find(r => r.roster_id === '2' && r.week === 1);
  assert.ok(zero, 'the week is kept');
  assert.equal(zero.points, 0);
});

test('a payload with no schedule says so rather than returning an empty league', () => {
  // A league synced without view=mMatchup is a different problem from a league that has
  // played no games, and a caller has to be able to tell them apart.
  for (const [payload, needle] of [
    [null, /never been synced/],
    ['not json', /not readable/],
    [JSON.stringify({ teams: [], settings: {} }), /no schedule/]
  ]) {
    const out = espnWeeklyRows({ id: 7, league_id: 'L7', season: 2026, payload });
    assert.equal(out.ok, false);
    assert.match(out.reason, needle);
    assert.deepEqual(out.rows, []);
  }
});

test('a league whose season has not started reports that, not zero rows with no reason', () => {
  const out = espnWeeklyRows(league({ weeksPlayed: 0 }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /no played regular-season weeks/);
  assert.equal(out.skipped_unplayed, 26);
});

test('weeklyPanel derives the same features from supplied rows as from the corpus', () => {
  // The point of the `rows` argument: one implementation of all-play, the shrunk z-score
  // and games_back. A second one for app leagues would drift from the fitted features with
  // nothing saying so.
  const { rows } = espnWeeklyRows(league({ weeksPlayed: 3 }));
  const panel = weeklyPanel({ rows });
  assert.equal(panel.length, 12);
  const row = panel.find(r => r.roster_id === '1' && r.week === 3);
  for (const f of OUTLOOK_FEATURES) {
    if (f === 'points_shrunk') continue;   // derived from mean_points_z by featureRow
    assert.ok(f in row || f === 'weeks_left' || f === 'playoff_share', `${f} missing`);
  }
  assert.equal(row.games, 3, 'three weeks played');
  assert.ok(row.all_play_pct != null && row.win_pct != null);
  assert.equal(row.weeks_left, 0, 'the panel only knows the weeks it was given');
});

test('all-play is computed across the whole league-week, not just the head-to-head', () => {
  // The case all-play exists to see and win_pct cannot: team 4 is the second-highest scorer
  // in the league every week and is drawn against the highest every week, so it loses every
  // matchup while beating two thirds of the field on points. The pairing is 1v4 and 2v3
  // rather than the helper's 1v2 and 3v4, because scoring the most and losing is not a
  // thing that can happen -- a scenario has to be possible before it can be a test.
  const schedule = [];
  const pts = { 1: 210, 2: 80, 3: 70, 4: 200 };
  for (let w = 1; w <= 3; w++) {
    schedule.push({ matchupPeriodId: w, winner: 'HOME',
      home: { teamId: 1, totalPoints: pts[1] }, away: { teamId: 4, totalPoints: pts[4] } });
    schedule.push({ matchupPeriodId: w, winner: 'HOME',
      home: { teamId: 2, totalPoints: pts[2] }, away: { teamId: 3, totalPoints: pts[3] } });
  }
  const { rows } = espnWeeklyRows({
    id: 7, league_id: 'L7', season: 2026, payload_season: 2026,
    payload: JSON.stringify({
      teams: [1, 2, 3, 4].map(id => ({ id, name: `Team ${id}` })), schedule,
      settings: { scheduleSettings: { matchupPeriodCount: 13, playoffTeamCount: 2 } }
    })
  });
  const panel = weeklyPanel({ rows });
  const second = panel.find(r => r.roster_id === '4' && r.week === 3);
  assert.equal(second.win_pct, 0, 'it lost its own matchup every week');
  assert.equal(second.all_play_pct, +(2 / 3).toFixed(4), 'while beating two of the other three');
  // And the head-to-head loser of a low-scoring pair is not flattered by it.
  const low = panel.find(r => r.roster_id === '2' && r.week === 3);
  assert.equal(low.win_pct, 1, 'team 2 won every matchup it played');
  assert.equal(low.all_play_pct, +(1 / 3).toFixed(4), 'and beat only one of the other three');
});

test('a fit refuses a panel of live rows instead of learning "nobody qualifies"', () => {
  // made_playoffs is null for a season in progress, and the logistic fit reads it as y. A
  // null becomes 0, so a panel of live rows would fit a model of nobody making the
  // playoffs, with the wrong signs and no error anywhere. The row shape cannot show this,
  // so the refusal is explicit.
  const { rows } = espnWeeklyRows(league({ weeksPlayed: 8 }));
  const panel = weeklyPanel({ rows });
  assert.ok(panel.some(r => r.week === 3));
  assert.throws(() => fitOutlook({ panel, k: 7.6 }), /Live rows are scored, not fitted/);
});

test('the corpus rows a fit is built from are not marked live, so nothing regresses', () => {
  // The guard keys on `outcome_known === false`, strictly. A corpus row does not carry the
  // field at all, so `undefined` must not trip it.
  const corpusish = [1, 2, 3, 4].flatMap(t => [1, 2, 3].map(w => ({
    season: 2024, league_id: 'C1', num_teams: 4, playoff_teams: 2,
    roster_id: String(t), week: w, points: 100 + t * 10 + w,
    opponent_roster_id: String(t % 2 ? t + 1 : t - 1),
    made_playoffs: t <= 2 ? 1 : 0, champion: 0
  })));
  const panel = weeklyPanel({ rows: corpusish });
  assert.doesNotThrow(() => fitOutlook({ panel, k: 7.6 }));
});
