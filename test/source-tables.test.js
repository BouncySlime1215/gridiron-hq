/**
 * SOURCE-TABLES: the producers of the graders' two missing source tables.
 *   weekly_autopsy         -> E7      (server/services/eval/sources/weekly-autopsy.js)
 *   planner_move_outcomes  -> E4-live (server/services/eval/sources/planner-move-outcomes.js)
 * plus the tick step and the CLI, both off by default. Made-up teams and players only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { bestLineup, lineupFromSlotCounts, LINEUP } from '../server/services/campaign/espn-lineup.js';
import * as A from '../server/services/eval/sources/weekly-autopsy.js';
import * as P from '../server/services/eval/sources/planner-move-outcomes.js';
import { sourceTablesEnabled } from '../server/services/eval/sources/flag.js';
import * as E7 from '../server/services/eval/e7.js';
import * as E4 from '../server/services/eval/e4-planner.js';
import { STATUS } from '../server/services/eval/common.js';
import { up as up058 } from '../server/migrations/058_league_roster_snapshots.js';
import { captureAll, settleAll, main as cliMain, parseArgs } from '../scripts/eval/produce-source-tables.mjs';
import { pickFinderBest } from '../scripts/campaign/league-adapter.mjs';
import { sourceTables } from '../scripts/refresh-live-data.mjs';

// ---------------------------------------------------------------- fixtures
// ESPN ids: 1 QB, 2 RB, 3 WR, 4 TE, 5 K, 16 D/ST. Slots: 0 QB, 2 RB, 4 WR, 6 TE, 23 FLEX, 17 K, 16 D/ST, 20 BE, 21 IR.
const LEAGUE4_COUNTS = { 0: 1, 2: 2, 4: 2, 6: 1, 23: 2, 17: 1, 16: 1, 20: 7, 21: 1 };
let pid = 1000;
const pl = (pos, slot, proj, act) => ({ espn_player_id: pid++, espn_position_id: pos, lineup_slot_id: slot,
  is_starter: slot === 20 || slot === 21 ? 0 : 1, projected_points: proj, actual_points: act });
/** A team that started a 5-point WR over a 12-point bench WR, with a 30-point IR RB. */
function teamA() {
  return [
    pl(1, 0, 20, 25), pl(2, 2, 15, 10), pl(2, 2, 12, 14), pl(3, 4, 14, 20), pl(3, 4, 5, 2),
    pl(4, 6, 9, 11), pl(2, 23, 10, 8), pl(3, 23, 9, 3), pl(5, 17, 8, 7), pl(16, 16, 7, 10),
    pl(3, 20, 12, 30), pl(2, 20, 4, 0), pl(2, 21, 30, 0),
  ];
}
/** A team whose lineup is already the best one. */
function teamB() {
  return [
    pl(1, 0, 18, 12), pl(2, 2, 16, 20), pl(2, 2, 13, 9), pl(3, 4, 15, 18), pl(3, 4, 11, 6),
    pl(4, 6, 8, 4), pl(2, 23, 9, 12), pl(3, 23, 9, 9), pl(5, 17, 9, 11), pl(16, 16, 6, 1),
    pl(3, 20, 3, 15), pl(1, 20, 17, 30),
  ];
}
const sum = (rows, k) => rows.filter(r => r.is_starter).reduce((s, r) => s + r[k], 0);

function snapshotDb({ weeks = [1, 2], league = 4 } = {}) {
  const db = new DatabaseSync(':memory:');
  up058(db);
  db.exec('CREATE TABLE leagues (id INTEGER PRIMARY KEY, season INTEGER, payload TEXT)');
  db.prepare('INSERT INTO leagues VALUES (?, ?, ?)').run(league, 2026,
    JSON.stringify({ settings: { rosterSettings: { lineupSlotCounts: LEAGUE4_COUNTS } } }));
  const ins = db.prepare(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id,
    espn_position_id, lineup_slot_id, is_starter, projected_points, actual_points, source, first_seen_at, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 't', 't')`);
  for (const w of weeks) {
    for (const [team, rows] of [[1, teamA()], [2, teamB()]]) {
      for (const r of rows) ins.run(league, 2026, w, team, r.espn_player_id, r.espn_position_id, r.lineup_slot_id,
        r.is_starter, r.projected_points, r.actual_points, 'final');
    }
  }
  return db;
}

// ---------------------------------------------------------------- lineup (one solver)
test('lineupFromSlotCounts: league 4 counts give the same lineup as LINEUP (order aside)', () => {
  const own = lineupFromSlotCounts(LEAGUE4_COUNTS);
  const key = l => l.map(([s, ok, n]) => `${s}:${ok.join('/')}:${n}`).sort();
  assert.deepEqual(key(own), key(LINEUP));
  assert.equal(lineupFromSlotCounts({ 20: 7, 21: 1 }), null);
  assert.equal(lineupFromSlotCounts(null), null);
  const sf = lineupFromSlotCounts({ 0: 1, 2: 2, 4: 3, 6: 1, 7: 1, 23: 1 });
  assert.deepEqual(sf.at(-1), ['OP', ['QB', 'RB', 'WR', 'TE'], 1]);
});

test('bestLineup: default lineup unchanged for existing callers', () => {
  const ps = [['QB', 20], ['QB', 18], ['RB', 15], ['RB', 12], ['RB', 10], ['WR', 14], ['WR', 9], ['WR', 5], ['TE', 9], ['TE', 8], ['K', 8], ['D/ST', 7]]
    .map(([position, points], i) => ({ id: i, position, points }));
  const a = bestLineup(ps), b = bestLineup(ps, LINEUP);
  assert.equal(a.total, b.total);
  assert.equal(a.total, 20 + 15 + 12 + 14 + 9 + 9 + 10 + 8 + 8 + 7);
});

// ---------------------------------------------------------------- weekly_autopsy
test('autopsyTeamWeek: actual and expected are the starters, optimal is the best legal lineup, IR excluded', () => {
  const rows = teamA();
  const a = A.autopsyTeamWeek(rows, lineupFromSlotCounts(LEAGUE4_COUNTS));
  assert.equal(a.actual_points, sum(rows, 'actual_points'));
  assert.equal(a.expected_points, sum(rows, 'projected_points'));
  // Best: the 12-pt bench WR replaces the 5-pt WR (+7); the 30-pt IR RB is not eligible.
  assert.equal(a.optimal_expected_points, a.expected_points + 7);
  assert.equal(a.starters, 10);
  assert.ok(a.expected_points - a.optimal_expected_points <= 0);
  const b = A.autopsyTeamWeek(teamB(), lineupFromSlotCounts(LEAGUE4_COUNTS));
  assert.equal(b.optimal_expected_points, b.expected_points, 'a best lineup costs nothing');
  assert.equal(A.autopsyTeamWeek([pl(3, 20, 5, 5)]), null, 'no starters, no row');
});

test('produceWeeklyAutopsy: one row per team-week, idempotent, and E7 reads it', () => {
  const db = snapshotDb({ weeks: [1, 2] });
  const before = E7.run(db);
  assert.match(before.needs_text, /weekly_autopsy is not built yet/);
  const r1 = A.produceWeeklyAutopsy(db, { now: () => '2026-09-25T00:00:00Z' });
  assert.deepEqual(r1, { weeks: 2, rows: 4, skipped_teams: 0, unscored_teams: 0 });
  const first = db.prepare('SELECT * FROM weekly_autopsy ORDER BY week, team_id').all();
  A.produceWeeklyAutopsy(db, { now: () => '2026-09-25T00:00:00Z' });
  assert.deepEqual(db.prepare('SELECT * FROM weekly_autopsy ORDER BY week, team_id').all(), first, 'same input, same rows');
  for (const r of first) assert.ok(r.expected_points <= r.optimal_expected_points, 'decision <= 0 on every row');
  assert.equal(first[0].lineup_basis, 'league lineupSlotCounts');
  const after = E7.run(db);
  assert.equal(after.status, STATUS.NOT_ENOUGH_DATA);
  assert.equal(after.n, 2);
  assert.equal(after.needs_n, 2);
  assert.match(after.needs_text, /needs 2 more weeks/);
  assert.doesNotMatch(after.needs_text, /not built/);
});

test('produceWeeklyAutopsy: live rows are never autopsied; a league filter holds', () => {
  const db = snapshotDb({ weeks: [1] });
  db.exec(`UPDATE league_roster_snapshots SET source = 'live'`);
  assert.deepEqual(A.produceWeeklyAutopsy(db), { weeks: 0, rows: 0, skipped_teams: 0, unscored_teams: 0 });
  const db2 = snapshotDb({ weeks: [1] });
  assert.equal(A.produceWeeklyAutopsy(db2, { leagueIds: [9] }).rows, 0);
});

test('leagueLineup: falls back to league 4 and says so', () => {
  assert.match(A.leagueLineup(null).basis, /league 4 lineup/);
  assert.match(A.leagueLineup('{').basis, /unreadable/);
  assert.equal(A.leagueLineup(JSON.stringify({ settings: { rosterSettings: { lineupSlotCounts: LEAGUE4_COUNTS } } })).basis, 'league lineupSlotCounts');
});

// ---------------------------------------------------------------- planner_move_outcomes: arms
test('plannerArm: served first step, "none" when the planner served nothing, error otherwise', () => {
  const move = P.plannerArm({ next_move: { status: 'ok', value: { steps: [{ partner: '7', give: ['367', '379'], get: ['290'] }] } } });
  assert.deepEqual(move, { state: 'move', move: { partner: '7', give: ['367', '379'], get: ['290'] } });
  const none = P.plannerArm({ next_move: { status: 'unknown', reason: 'None of the 116 paths clears.' } });
  assert.equal(none.state, 'none');
  assert.equal(P.plannerArm({ error: 'boom' }).state, 'error');
  assert.equal(P.plannerArm(null).state, 'error');
  assert.equal(P.plannerArm({}).state, 'error');
});

test('plannerArm: a planner that failed closed is ungraded (error), never "did nothing" (#395 review)', () => {
  const unknown = { status: 'unknown', reason: 'No move this run: the trade ledger could not be read.' };
  const ledger = P.plannerArm({ next_move: unknown, _run: { confirm: { status: 'ok' }, dropped_by_reason: { trade_ledger_missing: 3 } } });
  assert.equal(ledger.state, 'error');
  assert.match(ledger.why, /trade ledger missing/);
  const dice = P.plannerArm({ next_move: unknown, _run: { confirm: { status: 'failed', reason: 'confirm world failed' } } });
  assert.equal(dice.state, 'error');
  assert.match(dice.why, /confirm dice failed/);
  const chose = P.plannerArm({ next_move: { status: 'unknown', reason: 'None clears.' },
    _run: { confirm: { status: 'ok' }, dropped_by_reason: { trade_memory: 2 } } });
  assert.equal(chose.state, 'none', 'a real "nothing clears" week is still graded as doing nothing');
});

test('pickFinderBest: highest p x delta, with its move; finderArm wraps it', () => {
  const served = [
    { partner_id: '3', i_give: [{ id: 1 }], i_get: [{ id: 9 }], title_delta: 0.02, title_delta_se: 0.01 },
    { partner_id: '5', i_give: [{ id: 2 }], i_get: [{ id: 8 }], title_delta: 0.05, title_delta_se: 0.01 },
    { partner_id: '6', i_give: [{ id: 4 }], i_get: [{ id: 7 }], title_delta: 0.9 },
  ];
  const found = [
    { partner_id: '3', i_give: [{ id: 1 }], i_get: [{ id: 9 }], acceptance: { band: { mid: 0.9 } } },
    { partner_id: '5', i_give: [{ id: 2 }], i_get: [{ id: 8 }], acceptance: { band: { mid: 0.2 } } },
  ];
  const b = pickFinderBest(served, found);
  assert.equal(b.n, 2);
  assert.ok(Math.abs(b.expected - 0.018) < 1e-12);
  assert.deepEqual(b.move, { partner: '3', give: ['1'], get: ['9'] });
  assert.deepEqual(P.finderArm(b), { state: 'move', move: b.move });
  assert.ok(pickFinderBest(served, []).error);
  assert.equal(P.finderArm(pickFinderBest([], [])).state, 'error');
  assert.equal(P.finderArm(null).state, 'error');
});

const player = (id, position, value, ppg, name = `Player ${id}`) => ({ id, name, position, value, ros_ppg: ppg });
const lineupPts = ps => {
  const by = pos => ps.filter(p => p.position === pos).map(p => p.ros_ppg).sort((a, b) => b - a);
  const top = (pos, n) => by(pos).slice(0, n).reduce((s, x) => s + x, 0);
  return top('QB', 1) + top('RB', 2) + top('WR', 2);
};

test('greedyMove: best fair 1-for-1 that raises the lineup; never gives 160/80/277, never gets Olave', () => {
  const teams = [
    { roster_id: '5', players: [player(160, 'WR', 100, 20), player(80, 'RB', 100, 18), player(277, 'WR', 100, 19),
      player(11, 'QB', 50, 15), player(12, 'RB', 100, 5), player(13, 'WR', 100, 4)] },
    { roster_id: '2', players: [player(290, 'WR', 95, 40, 'Chris Olave'), player(22, 'RB', 100, 12), player(23, 'WR', 300, 30)] },
  ];
  const g = P.greedyMove({ teams, me: '5', lineupPoints: lineupPts });
  // 12 (RB 5 ppg) for 22 (RB 12 ppg) at par: +7. Olave for 13 (+21) is refused; 23 is outside the screen.
  assert.deepEqual(g, { state: 'move', move: { partner: '2', give: ['12'], get: ['22'] } });
  for (const id of ['160', '80', '277']) assert.ok(!g.move.give.includes(id));
  // The filters are what stop the bigger gains: unblocked, greedy takes Olave (+21) or gives an untouchable.
  const open = P.greedyMove({ teams, me: '5', lineupPoints: lineupPts, neverGet: [], neverGive: [] });
  assert.deepEqual(open.move.get, ['290']);
  // Only untouchables to give: nothing.
  const bare = [{ roster_id: '5', players: teams[0].players.slice(0, 3) }, teams[1]];
  assert.equal(P.greedyMove({ teams: bare, me: '5', lineupPoints: lineupPts }).state, 'none');
  assert.equal(P.greedyMove({ teams, me: '9', lineupPoints: lineupPts }).state, 'error');
});

// ---------------------------------------------------------------- planner_move_outcomes: capture and settle
const KEY = { league_id: 4, season: 2026, week: 1 };
const ARMS_FIX = {
  planner: P.armMove({ partner: '2', give: ['12'], get: ['22'] }),
  finder: P.armNone('finder found no deal'),
  greedy: P.armMove({ partner: '2', give: ['13'], get: ['23'] }),
};
const ROSTERS = [
  { roster_id: '5', players: [{ id: 12 }, { id: 13 }] },
  { roster_id: '2', players: [{ id: 22 }, { id: 23 }] },
];

test('captureWeek: first capture of a week wins; a later one never rewrites it', () => {
  const db = snapshotDb({ weeks: [] });
  assert.equal(P.captureWeek(db, { ...KEY, me: '5', arms: ARMS_FIX, seed: 42, now: () => 'a' }), true);
  assert.equal(P.captureWeek(db, { ...KEY, me: '5', arms: { ...ARMS_FIX, planner: P.armNone('changed') }, seed: 1, now: () => 'b' }), false);
  const r = db.prepare('SELECT * FROM planner_move_outcomes').get();
  assert.equal(JSON.parse(r.planner_arm).state, 'move');
  assert.equal(r.seed, 42);
  assert.equal(r.captured_at, 'a');
  assert.throws(() => P.captureWeek(db, { ...KEY, week: 2, me: '5', arms: { planner: ARMS_FIX.planner } }), /arm finder missing/);
});

test('settle: nothing before the week is final; then gains on paired seeds, none = 0, E4-live counts the week', () => {
  const db = snapshotDb({ weeks: [] });
  P.captureWeek(db, { ...KEY, me: '5', arms: ARMS_FIX, seed: 42 });
  assert.equal(P.dueRows(db).length, 0, 'week 1 not final: no gain may be written');
  const liveBefore = E4.live(db);
  assert.equal(liveBefore.n, 0);
  assert.doesNotMatch(liveBefore.needs_text, /not built/);
  // Week 1 goes final.
  db.prepare(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id, lineup_slot_id,
    is_starter, source, first_seen_at, changed_at) VALUES (4, 2026, 1, 1, 1, 0, 1, 'final', 't', 't')`).run();
  const due = P.dueRows(db);
  assert.equal(due.length, 1);
  const seeds = [];
  const r = P.settleRow(db, due[0], { teams: () => ROSTERS, now: () => 'z',
    reprice: (row, m) => { seeds.push(row.seed); return { title_delta: m.get[0] === '22' ? 0.012 : 0.004, title_delta_se: 0.002 }; } });
  assert.equal(r.graded, true);
  assert.deepEqual(seeds, [42, 42], 'every arm re-priced on the captured seed');
  const row = db.prepare('SELECT * FROM planner_move_outcomes').get();
  assert.equal(row.planner_gain, 0.012);
  assert.equal(row.finder_gain, 0);
  assert.equal(row.greedy_gain, 0.004);
  assert.equal(row.settled_at, 'z');
  assert.equal(P.dueRows(db).length, 0, 'settled once');
  const live = E4.live(db);
  assert.equal(live.n, 1);
  assert.equal(live.needs_n, 7);
  assert.equal(live.status, 'not_enough_data', 'one week is reported, never graded');
  assert.match(live.needs_text, /early number, not a grade: over 1 graded week .* graded after 7 more weeks/);
});

test('settle: a move whose players left the rosters, or a failed capture, is NULL with the reason, and not graded', () => {
  const db = snapshotDb({ weeks: [1] });
  P.captureWeek(db, { ...KEY, me: '5', arms: { ...ARMS_FIX, finder: P.armError('finder: boom') }, seed: 1 });
  const moved = [{ roster_id: '5', players: [{ id: 13 }] }, ROSTERS[1]];
  const r = P.settleRow(db, P.dueRows(db)[0], { teams: () => moved, reprice: () => ({ title_delta: 0.01 }) });
  assert.equal(r.graded, false);
  const row = db.prepare('SELECT * FROM planner_move_outcomes').get();
  assert.equal(row.planner_gain, null);
  assert.equal(row.finder_gain, null);
  assert.equal(row.greedy_gain, 0.01);
  assert.match(row.settle_note, /planner: give 12 no longer on team 5/);
  assert.match(row.settle_note, /finder: finder: boom/);
  assert.equal(E4.live(db).n, 0, 'an ungraded week is not counted');
  const db2 = snapshotDb({ weeks: [1] });
  P.captureWeek(db2, { ...KEY, me: '5', arms: ARMS_FIX, seed: 1 });
  const r2 = P.settleRow(db2, P.dueRows(db2)[0], { teams: () => ROSTERS, reprice: () => ({ error: 'both teams required' }), maxAttempts: 1 });
  assert.equal(r2.graded, false);
  assert.match(db2.prepare('SELECT settle_note FROM planner_move_outcomes').get().settle_note, /reprice failed \(both teams required\)/);
});

// Review finding 2: one failed re-price must not drop the week for good.
test('settle: a failed re-price is retried on later ticks, then settles; the week is graded once it works', () => {
  const db = snapshotDb({ weeks: [1] });
  P.captureWeek(db, { ...KEY, me: '5', arms: ARMS_FIX, seed: 1 });
  let calls = 0;
  const flaky = () => { calls++; if (calls <= 2) throw new Error('sim blew up'); return { title_delta: 0.01, title_delta_se: 0.001 }; };
  const first = P.settleRow(db, P.dueRows(db)[0], { teams: () => ROSTERS, reprice: flaky });
  assert.equal(first.retry, true);
  let row = db.prepare('SELECT * FROM planner_move_outcomes').get();
  assert.equal(row.settled_at, null, 'not settled: the next tick retries it');
  assert.equal(row.settle_attempts, 1);
  assert.equal(row.planner_gain, null);
  assert.match(row.settle_note, /attempt 1 of 4: planner: reprice failed \(sim blew up\)/);
  assert.equal(P.dueRows(db).length, 1, 'still due');
  const second = P.settleRow(db, P.dueRows(db)[0], { teams: () => ROSTERS, reprice: flaky, now: () => 'z' });
  assert.equal(second.retry, false);
  assert.equal(second.graded, true);
  row = db.prepare('SELECT * FROM planner_move_outcomes').get();
  assert.equal(row.settle_attempts, 2);
  assert.equal(row.settled_at, 'z');
  assert.equal(row.planner_gain, 0.01);
  assert.equal(row.settle_note, null);
  assert.equal(E4.live(db).n, 1);
  // A re-price that never works settles NULL after MAX_SETTLE_ATTEMPTS ticks, and is not counted.
  const db2 = snapshotDb({ weeks: [1] });
  P.captureWeek(db2, { ...KEY, me: '5', arms: ARMS_FIX, seed: 1 });
  const dead = () => ({ error: 'no world' });
  for (let i = 1; i < P.MAX_SETTLE_ATTEMPTS; i++) {
    assert.equal(P.settleRow(db2, P.dueRows(db2)[0], { teams: () => ROSTERS, reprice: dead }).retry, true);
  }
  const last = P.settleRow(db2, P.dueRows(db2)[0], { teams: () => ROSTERS, reprice: dead });
  assert.equal(last.retry, false);
  assert.equal(P.dueRows(db2).length, 0);
  assert.equal(db2.prepare('SELECT settle_attempts FROM planner_move_outcomes').get().settle_attempts, P.MAX_SETTLE_ATTEMPTS);
  assert.equal(E4.live(db2).n, 0);
});

test('settleAll: a retrying row is counted as retrying, not settled', () => {
  const db = snapshotDb({ weeks: [1] });
  P.captureWeek(db, { ...KEY, me: '5', arms: ARMS_FIX, seed: 1 });
  const deps = { ...fakeDeps(), reprice: () => ({ error: 'no world' }) };
  assert.deepEqual(settleAll(db, P, { deps, now: () => 'n' }), { settled: 0, graded: 0, retrying: 1, failed: [] });
});

// ---------------------------------------------------------------- the CLI's loops (fake deps)
function fakeDeps({ throwOn = null } = {}) {
  return {
    leagueRow: id => (id === 4 ? { id: 4, season: 2026 } : null),
    finder: () => { if (throwOn === 'finder') throw new Error('finder exploded'); return { error: 'no served deal carried a finder acceptance price (0 served)' }; },
    greedy: () => P.armNone('no fair 1-for-1 raises the lineup'),
    seed: () => 7,
    teams: () => ROSTERS,
    reprice: () => ({ title_delta: 0.01, title_delta_se: 0.001 }),
  };
}
const ENTRY = { league: 4, me: '5', _run: { week: 1 }, next_move: { status: 'ok', value: { steps: [{ partner: '2', give: ['12'], get: ['22'] }] } } };

test('captureAll: captures a planned week once, skips a final week and unknown leagues, reports a throw', () => {
  const db = snapshotDb({ weeks: [] });
  const now = () => 'n';
  assert.equal(captureAll(db, P, { entries: [ENTRY, { league: 9, me: '1', _run: { week: 1 } }], generated_at: 'g', deps: fakeDeps(), now }).captured, 1);
  assert.equal(captureAll(db, P, { entries: [ENTRY], deps: fakeDeps(), now }).captured, 0, 'already captured');
  const row = db.prepare('SELECT * FROM planner_move_outcomes').get();
  assert.equal(row.plans_generated_at, 'g');
  assert.equal(JSON.parse(row.finder_arm).state, 'error');
  const db2 = snapshotDb({ weeks: [1] });
  assert.equal(captureAll(db2, P, { entries: [ENTRY], deps: fakeDeps(), now }).captured, 0, 'a final week is not captured after the fact');
  const db3 = snapshotDb({ weeks: [] });
  const bad = captureAll(db3, P, { entries: [ENTRY], deps: fakeDeps({ throwOn: 'finder' }), now });
  assert.equal(bad.captured, 0);
  assert.match(bad.failed[0], /capture league 4: finder exploded/);
  assert.equal(captureAll(db3, P, { entries: [ENTRY], leagues: [9], deps: fakeDeps(), now }).captured, 0, 'league filter');
});

test('settleAll: settles due rows through the deps', () => {
  const db = snapshotDb({ weeks: [] });
  captureAll(db, P, { entries: [ENTRY], deps: fakeDeps(), now: () => 'n' });
  assert.deepEqual(settleAll(db, P, { deps: fakeDeps(), now: () => 'n' }), { settled: 0, graded: 0, retrying: 0, failed: [] });
  db.prepare(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id, lineup_slot_id,
    is_starter, source, first_seen_at, changed_at) VALUES (4, 2026, 1, 1, 1, 0, 1, 'final', 't', 't')`).run();
  const s = settleAll(db, P, { deps: fakeDeps(), now: () => 'n' });
  assert.equal(s.settled, 1);
  assert.equal(s.graded, 0, 'the finder arm failed at capture, so the week is not graded');
});

// ---------------------------------------------------------------- off by default
test('flag: off unless GRIDIRON_SOURCE_TABLES=1', () => {
  assert.equal(sourceTablesEnabled({}), false);
  assert.equal(sourceTablesEnabled({ GRIDIRON_SOURCE_TABLES: '0' }), false);
  assert.equal(sourceTablesEnabled({ GRIDIRON_PREVIEW: '1' }), false);
  assert.equal(sourceTablesEnabled({ GRIDIRON_SOURCE_TABLES: '1' }), true);
});

test('CLI off: one line, exit 0, no table touched', async () => {
  const lines = [];
  const code = await cliMain({ argv: [], env: {}, log: l => lines.push(l) });
  assert.equal(code, 0);
  assert.deepEqual(lines, ['source_tables: off (GRIDIRON_SOURCE_TABLES is not 1)']);
  assert.deepEqual(parseArgs(['--leagues', '4,x,2']), { leagues: [4, 2] });
  assert.deepEqual(parseArgs([]), { leagues: null });
});

test('tick step: off starts no process; on runs the producer and records its line', () => {
  const calls = [], records = [], logs = [];
  const spawn = (cmd, args) => { calls.push(args); return { status: 0, stdout: 'source_tables: autopsy 1 weeks 10 rows; moves captured 1, settled 0 (graded 0)\n', stderr: '' }; };
  sourceTables({ spawn, log: l => logs.push(l), record: (...a) => records.push(a), env: {} });
  assert.equal(calls.length, 0);
  assert.equal(records.length, 0);
  sourceTables({ spawn, log: l => logs.push(l), record: (...a) => records.push(a), env: { GRIDIRON_SOURCE_TABLES: '1' } });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('scripts/eval/produce-source-tables.mjs'));
  assert.equal(records[0][0], 'source_tables');
  assert.equal(records[0][1], 'ok');
  assert.match(logs[0], /source_tables\s+ok source_tables: autopsy 1 weeks/);
});

// ---------------------------------------------------------------- review findings 1, 3, 4
test('greedyMove: no market values on his players is an error, never a "do nothing" that grades as 0', () => {
  const teams = [
    { roster_id: '5', players: [player(12, 'RB', 0, 5), player(13, 'WR', 0, 4)] },
    { roster_id: '2', players: [player(22, 'RB', 100, 12)] },
  ];
  const g = P.greedyMove({ teams, me: '5', lineupPoints: lineupPts });
  assert.equal(g.state, 'error');
  assert.match(g.why, /no market values/);
});

test('greedyMove: the never-give / never-get ids are the one pinned list (never-give.js), Olave by id too', async () => {
  const NG = await import('../server/services/campaign/never-give.js');
  // No second copy: greedy exports no list of its own (GREEDY_NEVER_GIVE and the Olave name list are gone).
  for (const k of ['GREEDY_NEVER_GIVE', 'GREEDY_NEVER_GET', 'GREEDY_NEVER_GET_NAMES']) assert.equal(P[k], undefined, k);
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../server/services/eval/sources/planner-move-outcomes.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /Object\.freeze\(\[\s*'160'/, 'no literal never-give ids outside never-give.js');
  assert.doesNotMatch(src, /olave/i, 'Olave is blocked by id through PINNED_NEVER_GET, not by name');
  const teams = [
    { roster_id: '5', players: [player(11, 'QB', 50, 15), player(12, 'RB', 100, 5), player(13, 'WR', 100, 4)] },
    // 290 under another name (ids resolve, names may not): still never a get.
    { roster_id: '2', players: [player(290, 'WR', 95, 40, 'C. Olave'), player(22, 'RB', 100, 12)] },
  ];
  const g = P.greedyMove({ teams, me: '5', lineupPoints: lineupPts });
  assert.deepEqual(g.move.get, ['22']);
  const open = P.greedyMove({ teams, me: '5', lineupPoints: lineupPts, neverGet: [] });
  assert.deepEqual(open.move.get, ['290'], 'unblocked, 290 was the best gain');
});

test('autopsy: a starter with no stat line counts 0 (as ESPN scores him) and is counted, not hidden', () => {
  const rows = teamA();
  rows[4].actual_points = null;
  const a = A.autopsyTeamWeek(rows, lineupFromSlotCounts(LEAGUE4_COUNTS));
  assert.equal(a.unscored_starters, 1);
  assert.equal(a.actual_points, sum(rows.map(r => ({ ...r, actual_points: r.actual_points ?? 0 })), 'actual_points'));
  const db = snapshotDb({ weeks: [1] });
  db.exec(`UPDATE league_roster_snapshots SET actual_points = NULL WHERE team_id = 1 AND is_starter = 1 AND espn_position_id = 5`);
  const r = A.produceWeeklyAutopsy(db);
  assert.equal(r.unscored_teams, 1);
  assert.deepEqual(db.prepare('SELECT team_id, unscored_starters FROM weekly_autopsy ORDER BY team_id').all().map(x => ({ ...x })),
    [{ team_id: 1, unscored_starters: 1 }, { team_id: 2, unscored_starters: 0 }]);
});
