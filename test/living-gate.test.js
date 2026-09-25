/**
 * LIVING-01b re-gate (docs/tdd/2026-09-25-living-01b-regate.tdd.md): the weekly
 * graded test that replaces "40 finished team-seasons".
 *
 * Fixture leagues only; made-up teams (roster ids), no real data. The ACTIVITY-01
 * model is injected as a fake with ACTIVITY-01's own call shape, so these tests
 * grade the grader: an oracle multiplier must pass, an inverted one must fail,
 * and nothing dated week >= w may move week w's prediction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rng } from '../server/services/eval/stats.js';
import * as G from '../server/services/eval/living-gate.js';
import * as REC from '../server/services/eval/living-gate-record.js';
import { up as migrate103 } from '../server/migrations/103_living_gate.js';
import { BRAIN_CHECK_IDS } from '../server/services/campaign/plans-schema.js';

// ------------------------------------------------------------------ fixtures
const LEAGUES = [11, 12, 13];
const TEAMS = Array.from({ length: 10 }, (_, i) => i + 1);
const LAST_COMPLETED = 8;
const MEAN_M = (0.25 + 4) / 2;

/** True weekly multiplier per (league, team, week): engaged (4) or quiet (0.25). */
function truth(seed = 7) {
  const rand = rng(seed);
  const m = new Map();
  for (const lg of LEAGUES) for (const t of TEAMS) for (let w = 1; w <= 12; w++) m.set(`${lg}:${t}:${w}`, rand() < 0.5 ? 0.25 : 4);
  return m;
}

function poisson(rand, lambda) {
  const L = Math.exp(-lambda); let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}

/** ESPN-shaped league_transactions_raw rows from the true rates. */
function txRows(mult, { seed = 21 } = {}) {
  const rand = rng(seed);
  const out = [];
  let id = 0;
  const row = (lg, w, type, exec, status, items) => ({
    league_id: lg, season: 2026, tx_id: String(++id), type, status, execution_type: exec,
    proposed_at: null, processed_at: null, team_id: null, member_id: null, related_tx_id: null,
    scoring_period: w, bid_amount: null, is_pending: 0, items_json: JSON.stringify(items), raw_json: '{}',
    // the collector's first run saw week 1 only; every later week was seen later
    first_seen_at: w === 1 ? '2026-09-10T00:00:00Z' : `2026-09-${String(10 + w).padStart(2, '0')}T00:00:00Z`,
    last_seen_at: '2026-09-30T00:00:00Z',
  });
  for (const lg of LEAGUES) {
    for (let w = 1; w <= 10; w++) {
      for (const t of TEAMS) {
        const n = poisson(rand, 0.8 * mult.get(`${lg}:${t}:${w}`));
        for (let k = 0; k < n; k++) {
          out.push(row(lg, w, 'FREEAGENT', 'EXECUTE', 'EXECUTED',
            [{ type: 'ADD', toTeamId: t, playerId: 1000 + id }, { type: 'DROP', fromTeamId: t, playerId: 2000 + id }]));
        }
      }
      // one completed trade a week between two teams, whose rate follows the multiplier too
      const a = TEAMS[w % 10], b = TEAMS[(w + 3) % 10];
      out.push(row(lg, w, 'TRADE_ACCEPT', 'PROCESS', 'EXECUTED',
        [{ type: 'TRADE', fromTeamId: a, toTeamId: b, playerId: 1 }, { type: 'TRADE', fromTeamId: b, toTeamId: a, playerId: 2 }]));
      // noise ESPN writes that is NOT a move: a failed claim, a responder's accept, a cancelled trade
      out.push(row(lg, w, 'WAIVER', 'EXECUTE', 'FAILED_INVALIDPLAYERSOURCE', [{ type: 'ADD', toTeamId: 1, playerId: 9 }]));
      out.push(row(lg, w, 'TRADE_ACCEPT', 'EXECUTE', 'EXECUTED', [{ type: 'TRADE', fromTeamId: 1, toTeamId: 2, playerId: 3 }]));
      out.push(row(lg, w, 'TRADE_ACCEPT', 'PROCESS', 'CANCELED', [{ type: 'TRADE', fromTeamId: 1, toTeamId: 2, playerId: 4 }]));
    }
  }
  return out;
}

/**
 * A fake with ACTIVITY-01's call shape: leagueActivityIntensity(teams, week) ->
 * Map roster_id -> { lambda, log_ratio }. `week` is the covered-history length + 1;
 * the fixture's first covered week is 2, so the absolute week is week + 1.
 * The oracle knows the true multiplier (it tests the grader, not a model).
 */
const fakeIntensity = (mult, lg, { invert = false, seen = null } = {}) => (teams, week) => {
  if (seen) seen.push({ teams: JSON.parse(JSON.stringify(teams)), week });
  const abs = week + 1;
  return new Map(teams.map(t => {
    const m = mult.get(`${lg}:${t.roster_id}:${abs}`) / MEAN_M;
    const r = invert ? 1 / m : m;
    return [String(t.roster_id), { week, lambda: r, lambda0: 1, log_ratio: Math.log(r) }];
  }));
};
const byLeague = (mult, opts) => ({ leagueId }) => fakeIntensity(mult, leagueId, opts);

function makeDb({ tx = null, scores = true, sim = null, leagues = LEAGUES } = {}) {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE leagues (id INTEGER PRIMARY KEY, platform TEXT, league_id TEXT, season INTEGER, payload TEXT)`);
  for (const lg of leagues) {
    d.prepare('INSERT INTO leagues VALUES (?,?,?,?,?)').run(lg, 'espn', `x${lg}`, 2026,
      JSON.stringify({ scoringPeriodId: LAST_COMPLETED + 1, teams: TEAMS.map(id => ({ id })) }));
  }
  d.exec(`CREATE TABLE league_week_scores (league_id INTEGER, season INTEGER, week INTEGER, roster_id TEXT,
    points REAL, opponent_roster_id TEXT, is_playoff INTEGER, captured_at TEXT, PRIMARY KEY (league_id, season, week, roster_id))`);
  if (scores) {
    const ins = d.prepare('INSERT INTO league_week_scores VALUES (?,?,?,?,?,?,0,?)');
    for (const lg of leagues) for (let w = 1; w <= 14; w++) for (const t of TEAMS) {
      // unplayed weeks are pre-created as 0 (ONE-PLAN data row 7); the grader must not read them
      ins.run(lg, 2026, w, String(t), w <= LAST_COMPLETED ? 100 + t + w : 0, String(t % 10 + 1), 'x');
    }
  }
  if (tx) {
    d.exec(`CREATE TABLE league_transactions_raw (
      league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
      type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
      team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
      bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (league_id, season, tx_id))`);
    const ins = d.prepare(`INSERT INTO league_transactions_raw VALUES (@league_id,@season,@tx_id,@type,@status,@execution_type,
      @proposed_at,@processed_at,@team_id,@member_id,@related_tx_id,@scoring_period,@bid_amount,@is_pending,@items_json,@raw_json,
      @first_seen_at,@last_seen_at)`);
    for (const r of tx) ins.run(r);
  }
  if (sim) {
    migrate103(d);
    const ins = d.prepare(`INSERT INTO living_gate_sim_predictions
      (league_id, season, week, team_id, runs, seed, pred_static, pred_living, model, recorded_period, recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of sim) ins.run(r.league_id, 2026, r.week, String(r.team_id), 400, 99, r.pred_static, r.pred_living, 'living01b-1', r.week - 1, 'x');
  }
  return d;
}

/** Forward SIM rows: `good` puts living closer to the realised score than static. */
function simRows({ good = true, weeks = [5, 6, 7, 8] } = {}) {
  const rand = rng(5);
  const out = [];
  for (const lg of LEAGUES) for (const w of weeks) for (const t of TEAMS) {
    const real = 100 + t + w;
    const near = real + (rand() - 0.5) * 4, far = real + (rand() < 0.5 ? -1 : 1) * (15 + rand() * 5);
    out.push({ league_id: lg, week: w, team_id: t, pred_static: good ? far : near, pred_living: good ? near : far });
  }
  return out;
}

const rowOf = (rows, check) => rows.find(r => r.check === check);

// ------------------------------------------------------------------ realised moves
test('moves: adds, drops and trades per team-week, counted the way manager-signals counts them', () => {
  const rows = [
    { tx_id: '1', type: 'WAIVER', status: 'EXECUTED', execution_type: 'EXECUTE', scoring_period: 3,
      items_json: JSON.stringify([{ type: 'ADD', toTeamId: 4, playerId: 1 }, { type: 'DROP', fromTeamId: 4, playerId: 2 }]) },
    { tx_id: '2', type: 'FREEAGENT', status: 'EXECUTED', execution_type: 'EXECUTE', scoring_period: 3,
      items_json: JSON.stringify([{ type: 'DROP', fromTeamId: 5, playerId: 3 }]) },
    { tx_id: '3', type: 'WAIVER', status: 'FAILED_INVALIDPLAYERSOURCE', execution_type: 'EXECUTE', scoring_period: 3,
      items_json: JSON.stringify([{ type: 'ADD', toTeamId: 4, playerId: 9 }]) },
    { tx_id: '4', type: 'TRADE_ACCEPT', status: 'EXECUTED', execution_type: 'PROCESS', scoring_period: 3,
      items_json: JSON.stringify([{ type: 'TRADE', fromTeamId: 4, toTeamId: 6 }, { type: 'TRADE', fromTeamId: 6, toTeamId: 4 }]) },
    { tx_id: '5', type: 'TRADE_ACCEPT', status: 'EXECUTED', execution_type: 'EXECUTE', scoring_period: 3,
      items_json: JSON.stringify([{ type: 'TRADE', fromTeamId: 4, toTeamId: 6 }]) },
  ];
  const m = G.weeklyMoves(rows);
  assert.deepEqual(m.get('4').get(3), { adds: 1, drops: 1, trades: 1 });
  assert.deepEqual(m.get('5').get(3), { adds: 0, drops: 1, trades: 0 });
  assert.deepEqual(m.get('6').get(3), { adds: 0, drops: 0, trades: 1 }, 'a trade counts once per party; the EXECUTE accept is not a second trade');
});

test('coverage: the first covered week is the week after the lowest one seen on the collector\'s first run', () => {
  const tx = txRows(truth());
  assert.equal(G.firstCoveredWeek(tx), 2);
  assert.equal(G.firstCoveredWeek([]), null);
});

// ------------------------------------------------------------------ ACTIVITY
test('activity: an oracle multiplier passes every graded week; an inverted one fails every week', () => {
  const mult = truth();
  const d = makeDb({ tx: txRows(mult) });
  const good = G.gradeActivity(d, { intensityFor: byLeague(mult) });
  const bad = G.gradeActivity(d, { intensityFor: byLeague(mult, { invert: true }) });
  assert.deepEqual(good.weeks.map(w => w.week), [4, 5, 6, 7, 8], 'weeks 4..8: two covered history weeks, <= last completed');
  for (const w of good.weeks) {
    assert.equal(w.n, 30);
    assert.ok(w.ll_delta < 0 && w.brier_delta < 0, `week ${w.week} ll ${w.ll_delta} brier ${w.brier_delta}`);
    assert.equal(w.pass, true);
    assert.equal(w.ll_ci.length, 2);
  }
  for (const w of bad.weeks) assert.equal(w.pass, false, `inverted week ${w.week} must fail`);
});

test('activity: no week is graded below 20 team-weeks', () => {
  const mult = truth();
  const d = makeDb({ tx: txRows(mult).filter(r => r.league_id === 11), leagues: [11] });
  const g = G.gradeActivity(d, { intensityFor: byLeague(mult) });
  assert.equal(g.weeks.length, 0);
  assert.equal(g.team_weeks_short, 5 * 10, 'the short weeks are counted, not hidden');
});

test('activity: nothing dated week >= w moves week w\'s predictions (as-of)', () => {
  const mult = truth();
  const all = txRows(mult);
  const seenAll = [], seenCut = [];
  const pAll = G.activityPredictions(G.weeklyMoves(all), { leagueId: 11, teams: TEAMS.map(String), week: 6, fromWeek: 2,
    points: new Map(), intensity: fakeIntensity(mult, 11, { seen: seenAll }) });
  // a changed future: every row from week 6 on replaced with a burst of adds
  const changed = all.filter(r => r.scoring_period < 6).concat(txRows(truth(99), { seed: 5 }).filter(r => r.scoring_period >= 6));
  const pCut = G.activityPredictions(G.weeklyMoves(changed), { leagueId: 11, teams: TEAMS.map(String), week: 6, fromWeek: 2,
    points: new Map(), intensity: fakeIntensity(mult, 11, { seen: seenCut }) });
  assert.deepEqual(pCut, pAll);
  assert.deepEqual(seenCut, seenAll, 'the model is handed the same history');
  assert.equal(seenAll[0].teams[0].adds.length, 4, 'history is covered weeks 2..5 only');
});

test('activity: the baseline is the team\'s own trailing rate shrunk to the league rate (alpha 2)', () => {
  const moves = new Map([['1', new Map([[2, { adds: 4, drops: 0, trades: 0 }], [3, { adds: 2, drops: 0, trades: 0 }]])],
    ['2', new Map()]]);
  const p = G.activityPredictions(moves, { leagueId: 1, teams: ['1', '2'], week: 4, fromWeek: 2, points: new Map(), intensity: null });
  // league rate 6 adds / (2 teams * 2 weeks) = 1.5; team 1: (6 + 2*1.5)/(2+2) = 2.25; team 2: (0 + 3)/4 = 0.75
  assert.equal(p.get('1').base.adds, 2.25);
  assert.equal(p.get('2').base.adds, 0.75);
  assert.equal(p.get('2').base.trades, G.FLOOR, 'a zero rate is floored, never 0');
  assert.equal(p.get('1').model, null, 'no model -> no model arm');
});

// ------------------------------------------------------------------ SIM
test('sim: forward rows grade living vs static on realised lineup points; unplayed weeks are not read', () => {
  const good = G.gradeSim(makeDb({ sim: simRows({ good: true, weeks: [5, 6, 7, 8, 9] }) }));
  assert.deepEqual(good.weeks.map(w => w.week), [5, 6, 7, 8], 'week 9 is not complete: its stored 0 is not a result');
  for (const w of good.weeks) { assert.equal(w.pass, true); assert.ok(w.abs_delta < 0 && w.abs_ci[1] < 0); assert.ok('mse_delta' in w); }
  const bad = G.gradeSim(makeDb({ sim: simRows({ good: false }) }));
  for (const w of bad.weeks) assert.equal(w.pass, false);
});

// ------------------------------------------------------------------ gate
test('gate: two consecutive passing weeks pass; a fail, a gap or one week does not', () => {
  const wk = (week, pass) => ({ week, pass });
  assert.equal(G.partVerdict([wk(4, true), wk(5, true)]).state, 'pass');
  assert.equal(G.partVerdict([wk(4, true), wk(5, false)]).state, 'fail');
  assert.equal(G.partVerdict([wk(4, false), wk(5, true)]).state, 'fail', 'the latest two must both pass');
  assert.equal(G.partVerdict([wk(4, true), wk(6, true)]).state, 'fail', 'week 5 missing: not consecutive');
  assert.equal(G.partVerdict([wk(4, true)]).state, 'waiting');
  assert.equal(G.partVerdict([]).state, 'waiting');
  assert.equal(G.partVerdict([wk(3, false), wk(4, true), wk(5, true)]).state, 'pass', 'an earlier fail does not block');
});

test('run: both parts passing -> L01B-GATE passing; a failing SIM -> failing; rows are brain_report rows', () => {
  const mult = truth();
  const opts = { intensityFor: byLeague(mult) };
  const pass = G.run(makeDb({ tx: txRows(mult), sim: simRows({ good: true }) }), opts);
  assert.deepEqual(pass.map(r => r.check), ['L01B-ACT', 'L01B-SIM', 'L01B-GATE']);
  assert.equal(rowOf(pass, 'L01B-ACT').status, 'passing');
  assert.equal(rowOf(pass, 'L01B-SIM').status, 'passing');
  assert.equal(rowOf(pass, 'L01B-GATE').status, 'passing');
  assert.ok(rowOf(pass, 'L01B-ACT').detail.weeks.length === 5);
  const fail = G.run(makeDb({ tx: txRows(mult), sim: simRows({ good: false }) }), opts);
  assert.equal(rowOf(fail, 'L01B-SIM').status, 'failing');
  assert.equal(rowOf(fail, 'L01B-GATE').status, 'failing');
});

test('run: missing sources say what they wait on (not_enough_data), never an empty pass', () => {
  const none = G.run(makeDb({}), {});
  for (const r of none) assert.equal(r.status, 'not_enough_data', r.check);
  assert.match(rowOf(none, 'L01B-ACT').needs_text, /league_transactions_raw/);
  assert.match(rowOf(none, 'L01B-SIM').needs_text, /living_gate_sim_predictions/);
  const mult = truth();
  const noModel = G.run(makeDb({ tx: txRows(mult) }), {});
  assert.equal(rowOf(noModel, 'L01B-ACT').status, 'not_enough_data');
  assert.match(rowOf(noModel, 'L01B-ACT').needs_text, /ACTIVITY-01/);
  assert.equal(rowOf(noModel, 'L01B-GATE').status, 'not_enough_data');
  const oneWeek = G.run(makeDb({ tx: txRows(mult), sim: simRows({ weeks: [8] }) }), { intensityFor: byLeague(mult) });
  assert.equal(rowOf(oneWeek, 'L01B-SIM').status, 'not_enough_data', 'one graded week is not two');
  assert.equal(rowOf(oneWeek, 'L01B-GATE').status, 'not_enough_data');
});

test('every id the gate emits is allowed by the plans contract', () => {
  for (const id of [G.CHECK, G.ACT_CHECK, G.SIM_CHECK]) assert.ok(BRAIN_CHECK_IDS.includes(id), id);
});

// ------------------------------------------------------------------ recorder
test('recorder: records the week after the one in progress, paired, write-once', async () => {
  const d = makeDb({});
  migrate103(d);
  const calls = [];
  const predict = async (lg, { week }) => {
    calls.push([lg.id, week]);
    return { runs: 400, seed: 7, model: 'living01b-1', teams: TEAMS.map(t => ({ team_id: String(t), static: 100 + t, living: 99 + t })) };
  };
  const r1 = await REC.recordSimPredictions(d, { predict, now: new Date('2026-10-01T00:00:00Z') });
  assert.equal(r1.written, 30);
  assert.deepEqual(calls.map(c => c[1]), [LAST_COMPLETED + 2, LAST_COMPLETED + 2, LAST_COMPLETED + 2],
    'week in progress is 9; the recorded week is 10, not started');
  const again = async () => ({ runs: 400, seed: 7, model: 'living01b-1', teams: TEAMS.map(t => ({ team_id: String(t), static: 0, living: 0 })) });
  const r2 = await REC.recordSimPredictions(d, { predict: again });
  assert.equal(r2.written, 0);
  const row = d.prepare('SELECT * FROM living_gate_sim_predictions WHERE league_id = 11 AND team_id = ?').get('3');
  assert.equal(row.pred_static, 103, 'a later tick cannot overwrite a recorded week');
  assert.equal(row.recorded_period, LAST_COMPLETED + 1);
});

test('recorder: without a predictor it records nothing and says what it waits on; a predictor error is reported, not swallowed', async () => {
  const d = makeDb({});
  migrate103(d);
  const w = await REC.recordSimPredictions(d, { predict: null });
  assert.equal(w.state, 'waiting');
  assert.match(w.reason, /LIVING-01b/);
  const e = await REC.recordSimPredictions(d, { predict: async () => { throw new Error('boom'); } });
  assert.equal(e.errors.length, 3);
  assert.match(e.errors[0].message, /boom/);
});

test('optional modules: a missing module resolves to null; any other import fault throws', async () => {
  assert.equal(await REC.optionalExport('./no-such-module-living-gate.js', 'x'), null);
  assert.equal(await REC.optionalExport('./living-gate.js', 'noSuchExport'), null);
  assert.equal(typeof await REC.optionalExport('./living-gate.js', 'run'), 'function');
  await assert.rejects(() => REC.optionalExport('data:text/javascript,export const = ;', 'x'), SyntaxError);
});
