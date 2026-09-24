/**
 * CE-05 — one producer for each league's exact rules (server/services/league-rules.js).
 *
 * Fixtures are built from the SHAPES of the five local ESPN payloads (field
 * names and counts only; no league, team or manager names): scheduleSettings,
 * rosterSettings.lineupSlotCounts, tradeSettings, scoringSettings.scoringItems,
 * teams[].divisionId / record.overall, schedule[].winner.
 *
 * Before this unit the season simulator read `playoffTeamCount ?? 6` and
 * `matchupPeriodCount ?? 14`, played every bracket on NFL weeks 15-17 one week
 * per round, re-seeded every round, and seeded on wins then points with no
 * division winners (season-sim.js:78,217,220,299 on 89f69b3b).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ce05-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '6';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
const { deriveFormat } = await import('../server/services/format.js');
const seasonSim = await import('../server/services/season-sim.js');
const { leagueSchedule } = await import('../server/services/trade-horizon.js');
const { withRandomSeed } = await import('../server/services/stats-util.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { default: modelRouter } = await import('../server/routes/model.js');
const express = (await import('express')).default;
// Imported by name so a missing module is a failing assertion, not a crash.
const rulesMod = await import('../server/services/league-rules.js')
  .catch(e => ({ importError: `${e.code ?? 'ERR'}: ${e.message}` }));

await runMigrations();
seedIfEmpty();

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function mod() {
  assert.ok(!rulesMod.importError, `server/services/league-rules.js must exist (${rulesMod.importError})`);
  return rulesMod;
}

/* ---------------------------------------------------------------- fixtures */

// lineupSlotCounts exactly as the local payloads carry them (league 4 has 2 FLEX).
const LINEUP = { 0: 1, 1: 0, 2: 2, 3: 0, 4: 2, 5: 0, 6: 1, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0, 13: 0,
  14: 0, 15: 0, 16: 1, 17: 1, 18: 0, 19: 0, 20: 7, 21: 1, 22: 0, 23: 1, 24: 0 };

/** An ESPN mSettings-shaped payload. `records` = [{ wins, losses, ties, pointsFor }] per team. */
function espnPayload({
  teams = 10, regular = 14, playoffTeams = 6, roundLength = 1, reseed = false,
  rule = 'TOTAL_POINTS_SCORED', divisions = 1, divisionOf = () => 0, lineup = LINEUP,
  records = null, decidedWeeks = 2, drop = []
} = {}) {
  const ss = {
    consolationLadderDisabled: false, matchupPeriodCount: regular, matchupPeriodLength: 1,
    periodTypeId: 1, playoffMatchupPeriodLength: roundLength, playoffReseed: reseed,
    playoffSeedingRule: rule, playoffSeedingRuleBy: 0, playoffTeamCount: playoffTeams,
    variablePlayoffMatchupPeriodLength: false,
    divisions: Array.from({ length: divisions }, (_, id) => ({ id, name: `D${id}`, size: teams / divisions })),
  };
  const payload = {
    seasonId: 2026,
    settings: {
      scheduleSettings: ss,
      rosterSettings: { isBenchUnlimited: true, lineupSlotCounts: lineup },
      // Shape of all five synced leagues' acquisitionSettings (local copy 2026-09-23), RL-13-2.
      acquisitionSettings: { acquisitionType: 'WAIVERS_TRADITIONAL', isUsingAcquisitionBudget: false,
        waiverOrderReset: true, waiverHours: 24, waiverProcessHour: 11 },
      tradeSettings: { allowOutOfUniverse: false, deadlineDate: 1796230800000, max: -1, revisionHours: 24,
        vetoVotesRequired: 4 },
      scoringSettings: { matchupTieRule: 'NONE', playoffMatchupTieRule: 'NONE', scoringType: 'H2H_POINTS',
        scoringItems: [{ statId: 53, points: 1 }, { statId: 3, points: 0.04 }, { statId: 4, points: 6 },
          { statId: 42, points: 0.1 }, { statId: 43, points: 6 }, { statId: 24, points: 0.1 }] },
    },
    teams: Array.from({ length: teams }, (_, i) => ({
      id: i + 1, divisionId: divisionOf(i + 1),
      record: { overall: records?.[i] ?? { wins: 1, losses: decidedWeeks - 1, ties: 0, pointsFor: 100 } },
    })),
    schedule: [],
  };
  for (let w = 1; w <= regular; w++) {
    for (let i = 0; i < teams / 2; i++) {
      payload.schedule.push({ matchupPeriodId: w, winner: w <= decidedWeeks ? 'HOME' : 'UNDECIDED',
        home: { teamId: i + 1 }, away: { teamId: teams - i } });
    }
  }
  for (const p of drop) {
    const parts = p.split('.');
    const last = parts.pop();
    delete parts.reduce((o, k) => o[k], payload)[last];
  }
  return payload;
}
const lgOf = (payload, extra = {}) => ({ id: 1, platform: 'espn', ppr: 1, payload: JSON.stringify(payload), ...extra });

/* ------------------------------------------------ rules: the acceptance pair */

test('CE-05: a 6-team-bracket league with a points-for tiebreaker gets every seed right', () => {
  const { leagueRules, seedStandings } = mod();
  const rules = leagueRules(lgOf(espnPayload({ teams: 10, playoffTeams: 6 })));
  assert.equal(rules.source, 'espn_settings');
  assert.equal(rules.schedule.playoff_teams, 6);
  assert.equal(rules.seeding.tiebreaker, 'TOTAL_POINTS_SCORED');
  // w already counts a tie as half a win. Ids 3 and 7 tie on 9 wins: 7 has more points.
  // Ids 5 and 2 tie on 7.5 (a tie each): 2 has more points.
  const standings = [
    { id: '1', w: 6, pf: 1700 }, { id: '2', w: 7.5, pf: 1650 }, { id: '3', w: 9, pf: 1500 },
    { id: '4', w: 11, pf: 1600 }, { id: '5', w: 7.5, pf: 1640 }, { id: '6', w: 4, pf: 1400 },
    { id: '7', w: 9, pf: 1800 }, { id: '8', w: 5, pf: 1900 }, { id: '9', w: 6, pf: 1690 },
    { id: '10', w: 5, pf: 1300 },
  ];
  assert.deepEqual(seedStandings(standings, rules), ['4', '7', '3', '2', '5', '1', '9', '8', '10', '6']);
});

test('CE-05: missing fields are reported loudly, never defaulted silently', () => {
  const { leagueRules } = mod();
  const rules = leagueRules(lgOf(espnPayload({
    drop: ['settings.scheduleSettings.playoffTeamCount', 'settings.scheduleSettings.playoffReseed',
      'settings.scheduleSettings.playoffSeedingRule'] })));
  for (const p of ['settings.scheduleSettings.playoffTeamCount', 'settings.scheduleSettings.playoffReseed',
    'settings.scheduleSettings.playoffSeedingRule']) {
    assert.ok(rules.missing.includes(p), `${p} missing but not reported: ${JSON.stringify(rules.missing)}`);
  }
  assert.equal(rules.schedule.playoff_teams, null, 'a missing playoff count must stay null, not become 6');
  assert.equal(rules.schedule.playoff_weeks, null, 'no playoff weeks without a playoff count');
  assert.equal(rules.schedule.reseed, null, 'a missing reseed flag must stay null, not become true');
  assert.equal(rules.seeding.tiebreaker, null);
  // Control: the complete fixture reports nothing missing.
  assert.deepEqual(leagueRules(lgOf(espnPayload())).missing, []);
});

/* --------------------------------------------------------- rules: the rest */

test('CE-05: division winners take the top seeds (league 2 shape: 2 divisions)', () => {
  const { leagueRules, seedStandings } = mod();
  // Ids 1-5 in division 0, 6-10 in division 1. Division 1's best is 8-6; division 0 has 11-3 and 9-5.
  const rules = leagueRules(lgOf(espnPayload({ divisions: 2, divisionOf: id => (id <= 5 ? 0 : 1) })));
  assert.equal(rules.seeding.division_winners_first, true);
  const standings = [
    { id: '1', w: 11, pf: 1650 }, { id: '2', w: 9, pf: 1700 }, { id: '3', w: 8, pf: 1730 },
    { id: '4', w: 7, pf: 1650 }, { id: '5', w: 7, pf: 1610 }, { id: '6', w: 8, pf: 1900 },
    { id: '7', w: 6, pf: 1780 }, { id: '8', w: 5, pf: 1520 }, { id: '9', w: 5, pf: 1510 },
    { id: '10', w: 4, pf: 1500 },
  ];
  assert.deepEqual(seedStandings(standings, rules), ['1', '6', '2', '3', '4', '5', '7', '8', '9', '10']);
  // Control: one division, same standings -> plain wins then points.
  const one = leagueRules(lgOf(espnPayload({ divisions: 1 })));
  assert.equal(one.seeding.division_winners_first, false);
  assert.deepEqual(seedStandings(standings, one).slice(0, 3), ['1', '2', '6']);
});

test('CE-05: an unimplemented tiebreaker throws by name instead of seeding on points', () => {
  const { leagueRules, seedStandings } = mod();
  const rules = leagueRules(lgOf(espnPayload({ rule: 'H2H_RECORD' })));
  assert.ok(rules.unsupported.some(u => u.includes('H2H_RECORD')), JSON.stringify(rules.unsupported));
  assert.throws(() => seedStandings([{ id: '1', w: 1, pf: 1 }, { id: '2', w: 1, pf: 2 }], rules), /H2H_RECORD/);
});

test('CE-05: playoff weeks per round come from the league (the three local shapes)', () => {
  const { leagueRules } = mod();
  const weeks = o => leagueRules(lgOf(espnPayload(o))).schedule.playoff_weeks;
  assert.deepEqual(weeks({ teams: 8, regular: 13, playoffTeams: 4, roundLength: 2 }), [[14, 15], [16, 17]]);
  assert.deepEqual(weeks({ teams: 8, regular: 14, playoffTeams: 4, roundLength: 2 }), [[15, 16], [17, 18]]);
  assert.deepEqual(weeks({ teams: 10, regular: 14, playoffTeams: 6, roundLength: 1 }), [[15], [16], [17]]);
  const r = leagueRules(lgOf(espnPayload({ reseed: true })));
  assert.equal(r.schedule.reseed, true);
  assert.equal(r.schedule.regular_season_weeks, 14);
});

test('CE-05: leagueRules ships only fields a route reads (no roster, trade, scoring or tie-rule fields)', () => {
  const { leagueRules } = mod();
  const r = leagueRules(lgOf(espnPayload()));
  assert.deepEqual(Object.keys(r).sort(),
    // `waivers` (RL-13-2): read by waiver-wire.js#claimPriority -> GET /api/trades/:leagueId/waivers.
    // `trade_deadline` (DEADLINE-01): read by title-chess.js#titleChess <- trade-engine.js#findTradeSequences.
    ['median_game', 'missing', 'platform', 'schedule', 'seeding', 'source', 'trade_deadline', 'unknown', 'unsupported',
      'waivers']);
  for (const k of ['roster', 'trade', 'scoring', 'scoring_items', 'matchup_tie_rule', 'playoff_tie_rule']) {
    assert.equal(k in r, false, `${k} has no reader outside league-rules.js`);
  }
  assert.equal('consolation' in r.schedule, false);
});

test('CE-05: median game is inferred from records, unknown before any decided week', () => {
  const { leagueRules } = mod();
  assert.equal(leagueRules(lgOf(espnPayload({ decidedWeeks: 2 }))).median_game, false);
  const withMedian = espnPayload({ decidedWeeks: 2,
    records: Array.from({ length: 10 }, () => ({ wins: 2, losses: 2, ties: 0, pointsFor: 200 })) });
  assert.equal(leagueRules(lgOf(withMedian)).median_game, true);
  const pre = leagueRules(lgOf(espnPayload({ decidedWeeks: 0,
    records: Array.from({ length: 10 }, () => ({ wins: 0, losses: 0, ties: 0, pointsFor: 0 })) })));
  assert.equal(pre.median_game, null);
  assert.ok(pre.unknown.some(u => /median/.test(u)), JSON.stringify(pre.unknown));
});

test('CE-05: a platform with no rules reader says so', () => {
  const { leagueRules } = mod();
  const r = leagueRules({ id: 9, platform: 'sleeper', payload: JSON.stringify({ league: {} }) });
  assert.equal(r.source, 'unsupported_platform');
  assert.ok(r.missing.length > 0);
});

test('CE-05: trade-horizon leagueSchedule is the same producer (agrees on all three shapes)', () => {
  const { leagueRules } = mod();
  for (const o of [{ teams: 8, regular: 13, playoffTeams: 4, roundLength: 2 },
    { teams: 8, regular: 14, playoffTeams: 4, roundLength: 2 }, { teams: 10, regular: 14, playoffTeams: 6 }]) {
    const lg = lgOf(espnPayload(o));
    const r = leagueRules(lg).schedule;
    assert.deepEqual(leagueSchedule(lg), { regularSeasonEnd: r.regular_season_weeks,
      playoffWeeks: r.playoff_weeks.flat(), source: 'league_settings' });
  }
});

/* ------------------------------------------------------- the bracket, in the sim */

test('CE-05: fixed bracket (playoffReseed false) vs re-seeded, when the 6 seed wins', () => {
  const { playBracket } = seasonSim.__test;
  assert.equal(typeof playBracket, 'function', 'season-sim must export playBracket via __test');
  const field = ['s1', 's2', 's3', 's4', 's5', 's6'];
  // The 6 seed beats everyone except the 1 seed; higher seed wins otherwise.
  const strength = { s1: 100, s6: 90, s2: 80, s3: 70, s4: 60, s5: 50 };
  const met = [];
  const score = (id, weeks) => { met.push([id, weeks.join('+')]); return strength[id]; };
  const weeks = [[15], [16], [17]];
  const fixed = playBracket(field, { playoff_weeks: weeks, reseed: false }, score);
  // Fixed ESPN bracket: 1 v W(4/5), 2 v W(3/6) -> the 6 seed meets the 2 seed in round 2.
  assert.deepEqual(fixed.rounds[1].pairs, [['s1', 's4'], ['s2', 's6']]);
  assert.deepEqual(fixed.byes, ['s1', 's2']);
  const re = playBracket(field, { playoff_weeks: weeks, reseed: true }, score);
  // Re-seeded: the 1 seed takes the lowest survivor.
  assert.deepEqual(re.rounds[1].pairs, [['s1', 's6'], ['s2', 's4']]);
  assert.equal(fixed.champion, 's1');
  assert.deepEqual(fixed.finalists.sort(), ['s1', 's6']);
});

test('CE-05: a two-week playoff round is scored over both of its weeks', () => {
  const { playBracket } = seasonSim.__test;
  assert.equal(typeof playBracket, 'function', 'season-sim must export playBracket via __test');
  const seen = [];
  const out = playBracket(['a', 'b', 'c', 'd'], { playoff_weeks: [[14, 15], [16, 17]], reseed: false },
    (id, weeks) => { seen.push(weeks.join('+')); return id === 'd' ? 50 : 10; });
  assert.deepEqual([...new Set(seen)], ['14+15', '16+17']);
  assert.equal(out.champion, 'd', 'the 4 seed that outscores everyone wins');
});

test('CE-05: a league that plays the median gets a second result each week (sim and carried-in record)', () => {
  const { addMedianResults, initialRecords } = seasonSim.__test;
  assert.equal(typeof addMedianResults, 'function');
  const rec = new Map(['a', 'b', 'c', 'd'].map(id => [id, { w: 0, pf: 0 }]));
  addMedianResults(new Map([['a', 120], ['b', 100], ['c', 90], ['d', 80]]), rec);
  // Median of 120/100/90/80 is 95: a and b win it, c and d lose it.
  assert.deepEqual([...rec.values()].map(r => r.w), [1, 1, 0, 0]);
  // Odd count: the team exactly at the median gets half a win.
  const odd = new Map(['a', 'b', 'c'].map(id => [id, { w: 0, pf: 0 }]));
  addMedianResults(new Map([['a', 100], ['b', 90], ['c', 80]]), odd);
  assert.deepEqual([...odd.values()].map(r => r.w), [1, 0.5, 0]);
  const lg = { platform: 'espn', payload: JSON.stringify({ schedule: [
    { matchupPeriodId: 1, home: { teamId: 1, totalPoints: 120 }, away: { teamId: 2, totalPoints: 100 } },
    { matchupPeriodId: 1, home: { teamId: 3, totalPoints: 90 }, away: { teamId: 4, totalPoints: 80 } }] }) };
  const teams = [1, 2, 3, 4].map(i => ({ roster_id: String(i) }));
  const withMedian = initialRecords(lg, teams, 2, true);
  const without = initialRecords(lg, teams, 2);
  assert.deepEqual([...withMedian.values()].map(r => r.w), [2, 1, 1, 0]);
  assert.deepEqual([...without.values()].map(r => r.w), [1, 0, 1, 0], 'control: no median, head-to-head only');
});

/* ------------------------------------------------ simulateSeason + the route */

run(`INSERT INTO users (subject, display_name) VALUES ('ce05', 'ce05')`);
const userId = rows('SELECT last_insert_rowid() AS id')[0].id;
run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now','+1 day'))`,
  userId, hashSessionToken('ce05-token'));
const app = express();
app.use(express.json());
app.use('/api/model', modelRouter);
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/model`;

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
let fakeId = 960000;

/**
 * Four teams, two divisions ({1,2} and {3,4}), two playoff spots, week 6.
 * Weeks 1-5 are scored with fixed totals 150/140/120/100, so the carried-in
 * records are 5-0, 3-2, 2-3, 0-5. No projection history exists, so every
 * simulated week is a 0-0 tie and the final standings are the carried-in ones.
 * Plain wins-then-points seeds {1,2}; the league's division rule seeds {1,3}.
 */
function divisionLeague({ drop = [] } = {}) {
  const pick = (pos, n) => rows(`SELECT id, name, position FROM players WHERE position = ? AND fantasy_relevant = 1
                                 ORDER BY id LIMIT ?`, pos, n);
  const qb = pick('QB', 4), rb = pick('RB', 8), wr = pick('WR', 8), te = pick('TE', 4);
  const { formatKey } = deriveFormat({ team_count: 4, ppr: null, league_type: null, best_ball: 0, payload: null,
    roster_positions: JSON.stringify(SLOTS) });
  const now = new Date().toISOString();
  [...qb, ...rb, ...wr, ...te].forEach((p, i) => {
    run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games, raw, fetched_at)
         VALUES (?, 2026, 'projected', ?, 17, '{}', ?)
         ON CONFLICT(player_id, season, kind) DO UPDATE SET fantasy_points = excluded.fantasy_points`, p.id, 300 - i, now);
    run(`INSERT INTO dynasty_values (format_key, player_id, value, redraft_value, trend30, age, pos_rank, fetched_at)
         VALUES (?, ?, 900, 900, 0, 26, ?, ?)
         ON CONFLICT(format_key, player_id) DO UPDATE SET value = excluded.value`, formatKey, p.id, i + 1, now);
  });
  const payload = espnPayload({ teams: 4, regular: 14, playoffTeams: 2, roundLength: 1, divisions: 2,
    divisionOf: id => (id <= 2 ? 0 : 1), decidedWeeks: 5, drop,
    records: [{ wins: 5, losses: 0, ties: 0, pointsFor: 750 }, { wins: 3, losses: 2, ties: 0, pointsFor: 700 },
      { wins: 2, losses: 3, ties: 0, pointsFor: 600 }, { wins: 0, losses: 5, ties: 0, pointsFor: 500 }] });
  payload.teams.forEach((t, i) => {
    const roster = [qb[i], rb[2 * i], rb[2 * i + 1], wr[2 * i], wr[2 * i + 1], te[i]];
    t.roster = { entries: roster.map(p => ({ lineupSlotId: 20,
      playerPoolEntry: { player: { id: fakeId++, fullName: p.name, defaultPositionId: POS_ID[p.position] } } })) };
  });
  const PTS = { 1: 150, 2: 140, 3: 120, 4: 100 };
  const rounds = [[[1, 2], [3, 4]], [[1, 3], [2, 4]], [[1, 4], [2, 3]]];
  payload.schedule = [];
  for (let w = 1; w <= 14; w++) {
    for (const [h, a] of rounds[(w - 1) % 3]) {
      const done = w <= 5;
      payload.schedule.push({ matchupPeriodId: w, winner: done ? (PTS[h] > PTS[a] ? 'HOME' : 'AWAY') : 'UNDECIDED',
        home: { teamId: h, totalPoints: done ? PTS[h] : undefined },
        away: { teamId: a, totalPoints: done ? PTS[a] : undefined } });
    }
  }
  return payload;
}

function insertLeague(id, payload) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status, current_week, payload_season)
       VALUES (?, 'espn', ?, 2026, 'CE05 League', ?, 4, '1', ?, 'x', 'y', 'connected', 6, 2026)`,
  id, `espn-ce05-${id}`, JSON.stringify(payload), JSON.stringify(SLOTS));
  run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?, ?, 'commissioner')`, id, userId);
  return rows('SELECT * FROM leagues WHERE id = ?', id)[0];
}

const lgDiv = insertLeague(701, divisionLeague());
const oddsOf = (sim, id) => sim.teams.find(t => String(t.roster_id) === id).playoff_odds;

test('CE-05: simulateSeason seeds the division winner, not the better record', () => {
  const sim = withRandomSeed(701, () => seasonSim.simulateSeason(lgDiv, { runs: 60 }));
  assert.ok(!sim.error, sim.error);
  assert.equal(sim.from_week, 6);
  assert.equal(oddsOf(sim, '1'), 1, 'control: the 5-0 team always makes it');
  assert.equal(oddsOf(sim, '3'), 1, 'the 2-3 division-1 winner takes the second spot');
  assert.equal(oddsOf(sim, '2'), 0, 'the 3-2 second place in division 0 does not');
});

test('CE-05: simulateSeason refuses a league whose playoff count is missing (no 6-team default)', () => {
  const lg = insertLeague(702, divisionLeague({ drop: ['settings.scheduleSettings.playoffTeamCount'] }));
  const sim = seasonSim.simulateSeason(lg, { runs: 10 });
  assert.ok(sim.error, `expected a named error, got playoff_teams=${sim.playoff_teams}`);
  assert.ok(sim.rules_missing?.includes('settings.scheduleSettings.playoffTeamCount'), JSON.stringify(sim));
});

test('CE-05: GET /api/model/:leagueId/simulate returns rules_source and the rules it used', async () => {
  const res = await fetch(`${base}/701/simulate?runs=40&seed=3`, { headers: { Authorization: 'Bearer ce05-token' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rules_source, 'espn_settings');
  assert.equal(body.playoff_teams, 2);
  assert.deepEqual(body.playoff_weeks, [[15]]);
  assert.equal(body.seeding_rule, 'TOTAL_POINTS_SCORED');
  assert.equal(body.reseed, false);
  assert.equal(body.division_winners_first, true);
});
