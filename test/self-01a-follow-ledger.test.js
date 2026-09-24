/**
 * SELF-01a, the follow ledger: every recommendation shown is logged with its
 * as-of inputs, pick, margin and alternative, and matched later against what
 * was actually done on ESPN (lineups from league_roster_snapshots, waiver and
 * trade moves from league_transactions_raw) into follow / ignore / no_action.
 *
 * Each test uses its own league id, so no test leans on another's rows.
 * Every name below is made up. No league, manager or player in it is real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-follow-ledger-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const follow = await import('../server/services/engine/follow-ledger.js');
const recLedger = await import('../server/services/rec-ledger.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026;
const ME = 1, PARTNER = 2;
const T0 = '2026-09-23T12:00:00.000Z'; // the call is shown
const T1 = '2026-09-24T12:00:00.000Z'; // something is done
const LATER = '2026-10-02T12:00:00.000Z'; // every window has closed

// Local id -> ESPN id. The ledger matches ESPN rows by ESPN id or local player_id.
const P = { start: 9201, sit: 9202, add: 9203, drop: 9204, give: 9205, get: 9206, other: 9207 };
const ESPN = id => id - 5000;
for (const [k, id] of Object.entries(P)) {
  run('INSERT INTO players (id, name, position, espn_id) VALUES (?,?,?,?)', id, `Made Up ${k}`, 'RB', ESPN(id));
}

function league(id, week = 3) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, current_week)
       VALUES (?, 'espn', ?, ?, ?, ?, 6, ?, ?)`, id, `espn-follow-${id}`, SEASON, `L${id}`,
  JSON.stringify({ teams: [] }), String(ME), week);
  return row('SELECT * FROM leagues WHERE id = ?', id);
}
const clock = (id, week) => run('UPDATE leagues SET current_week = ? WHERE id = ?', week, id);
const lg = id => row('SELECT * FROM leagues WHERE id = ?', id);

/** One player's lineup state in the snapshot table (upsert, like the collector). */
function snap(leagueId, playerId, isStarter, { week = 3, at = T0, locked = 0, team = ME, onRoster = 1 } = {}) {
  run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id,
         player_id, lineup_slot_id, lineup_slot, is_starter, lineup_locked, on_roster, source, first_seen_at, changed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'live', ?, ?)
       ON CONFLICT(league_id, season, scoring_period_id, team_id, espn_player_id) DO UPDATE SET
         is_starter = excluded.is_starter, lineup_slot_id = excluded.lineup_slot_id,
         lineup_slot = excluded.lineup_slot, lineup_locked = excluded.lineup_locked,
         on_roster = excluded.on_roster, changed_at = excluded.changed_at`,
  leagueId, SEASON, week, team, ESPN(playerId), playerId, isStarter ? 2 : 20, isStarter ? 'RB' : 'BE',
  isStarter ? 1 : 0, locked, onRoster, at, at);
}

/** A start/sit call in the exact shape recsFromRoute('lineup') emits. */
const lineupRec = (leagueId, startPts = 14, sitPts = 12.5, week = 3) => ({
  league_id: leagueId, kind: 'lineup', season: SEASON, week,
  inputs: { starters: [['RB', P.start]], objective: 'mean' },
  predicted: { source: 'lineup', objective: 'mean', starters: [{ slot: 'RB', id: P.start, week_points: startPts }] },
  baseline_call: { call: 'bench_alternative', alternatives: [{ slot: 'RB', id: P.sit, week_points: sitPts }] },
});
const waiverRec = leagueId => ({
  league_id: leagueId, kind: 'waiver', season: SEASON, week: 3,
  inputs: { add: P.add, drop: P.drop, type: 'immediate' },
  predicted: { source: 'waivers', claim_type: 'immediate', add: { id: P.add, projected_ppg: 9 },
    drop: { id: P.drop }, upgrade: 2.4 },
  baseline_call: { call: 'no_move', keep: [P.drop] },
});
const tradeRec = leagueId => ({
  league_id: leagueId, kind: 'trade', season: SEASON, week: 3,
  inputs: { partner_id: String(PARTNER), give: [P.give], get: [P.get] },
  predicted: { source: 'find', partner_id: String(PARTNER), give: [{ id: P.give }], get: [{ id: P.get }],
    ppg_delta: 1.1, horizon_gain: 6.5 },
  baseline_call: { call: 'no_trade', keep: [P.give] },
});

const ledger = leagueId => rows('SELECT * FROM follow_ledger WHERE league_id = ? ORDER BY id', leagueId);

// league_transactions_raw has no migration: the collector creates it inline
// (scripts/collect-league-transactions.mjs). Same DDL, created on demand here.
function txTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
    league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
    type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
    team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
    bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    PRIMARY KEY (league_id, season, tx_id))`);
}
let txSeq = 0;
function tx(leagueId, type, items, { at = T1, team = ME, status = 'EXECUTED', exec = 'EXECUTE' } = {}) {
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type,
         proposed_at, processed_at, team_id, scoring_period, is_pending, items_json, raw_json, first_seen_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,3,0,?,'{}',?,?)`,
  leagueId, SEASON, `tx-${++txSeq}`, type, status, exec, at, at, team, JSON.stringify(items), at, at);
}

/* ------------------------------------------------------------------ start/sit */

test('a shown start/sit call + a later lineup set that follows it -> exactly one follow row with the as-of gap', () => {
  const L = league(701);
  snap(701, P.start, false); snap(701, P.sit, true); // before the call: the alternative starts
  follow.logShown(L, [lineupRec(701)], { now: T0 });
  snap(701, P.start, true, { at: T1 }); snap(701, P.sit, false, { at: T1 }); // Nick swaps
  clock(701, 4);
  follow.resolveDue({ now: LATER });
  const r = ledger(701);
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'start_sit');
  assert.equal(r[0].outcome, 'follow');
  assert.equal(r[0].complied, 1);
  assert.equal(r[0].margin, 1.5);
  assert.equal(r[0].near_tie, 0);
  assert.equal(JSON.parse(r[0].pick_json).id, P.start);
  assert.equal(JSON.parse(r[0].alternative_json).id, P.sit);
  const asOf = JSON.parse(r[0].as_of_json);
  assert.equal(asOf.pick_points, 14);
  assert.equal(asOf.alternative_points, 12.5);
  assert.deepEqual(asOf.lineup_at_shown, { pick_started: 0, alternative_started: 1 });
});

test('a lineup set against the call -> one ignore row', () => {
  const L = league(702);
  snap(702, P.start, true); snap(702, P.sit, false); // the status quo already agrees
  follow.logShown(L, [lineupRec(702)], { now: T0 });
  snap(702, P.start, false, { at: T1 }); snap(702, P.sit, true, { at: T1 }); // Nick swaps the other way
  clock(702, 4);
  follow.resolveDue({ now: LATER });
  const r = ledger(702);
  assert.equal(r.length, 1);
  assert.equal(r[0].outcome, 'ignore');
  assert.equal(r[0].complied, 0);
});

test('a shown call with no subsequent action by lock -> no_action', () => {
  const L = league(703);
  snap(703, P.start, false); snap(703, P.sit, true);
  follow.logShown(L, [lineupRec(703)], { now: T0 });
  clock(703, 4); // lock passes, nothing changed
  follow.resolveDue({ now: LATER });
  const r = ledger(703);
  assert.equal(r.length, 1);
  assert.equal(r[0].outcome, 'no_action');
  assert.equal(r[0].complied, 0, 'no action, and the lineup does not carry the call');
});

test('nothing resolves before lock; both players locked is lock even while the league clock is on the week', () => {
  const L = league(704);
  snap(704, P.start, false); snap(704, P.sit, true);
  follow.logShown(L, [lineupRec(704)], { now: T0 });
  snap(704, P.start, true, { at: T1 }); snap(704, P.sit, false, { at: T1 });
  follow.resolveDue({ now: T1 });
  assert.equal(ledger(704)[0].outcome, null, 'before lock the call is open');
  snap(704, P.start, true, { at: T1, locked: 1 }); snap(704, P.sit, false, { at: T1, locked: 1 });
  follow.resolveDue({ now: T1 });
  assert.equal(ledger(704)[0].outcome, 'follow');
});

test('a missing lineup capture is unresolved with a reason, never a no_action', () => {
  const L = league(705);
  follow.logShown(L, [lineupRec(705)], { now: T0 });
  clock(705, 4);
  follow.resolveDue({ now: LATER });
  const r = ledger(705)[0];
  assert.equal(r.outcome, null);
  assert.equal(r.unresolved_reason, 'no_lineup_capture');
  assert.deepEqual(follow.followSummary(705).unresolved, { no_lineup_capture: 1 });
});

test('near-tie flag is set iff abs(gap) < the pre-registered epsilon', () => {
  const eps = follow.NEAR_TIE_EPSILON;
  assert.ok(eps > 0, 'epsilon is a fixed positive constant');
  const L = league(706);
  const flag = (a, b) => follow.decisionsFromRecs(L, [lineupRec(706, a, b)], { now: T0 })[0];
  assert.equal(flag(10 + eps - 0.01, 10).near_tie, 1);
  assert.equal(flag(10 + eps, 10).near_tie, 0, 'exactly epsilon is not a near tie');
  assert.equal(flag(10, 10 + eps - 0.01).near_tie, 1, 'a negative gap counts by its absolute value');
  assert.equal(flag(10, 10 + eps + 0.5).near_tie, 0);
  assert.equal(flag(10, 10).near_tie, 1);
  const unknown = flag(null, 10);
  assert.equal(unknown.margin, null);
  assert.equal(unknown.near_tie, null, 'no gap, no flag either way');
  assert.equal(flag(12, 10).epsilon, eps, 'the epsilon used is stored on the row');
  assert.equal(follow.decisionsFromRecs(L, [waiverRec(706)], { now: T0 })[0].near_tie, null,
    'the near-tie design is start/sit only');
});

test('idempotent on re-sync: re-showing, re-resolving and backfilling add and rewrite nothing', () => {
  const L = league(707);
  snap(707, P.start, false); snap(707, P.sit, true);
  const a = follow.logShown(L, [lineupRec(707)], { now: T0 });
  const b = follow.logShown(L, [lineupRec(707)], { now: T1 });
  assert.equal(a.inserted, 1);
  assert.equal(b.inserted, 0);
  assert.equal(ledger(707)[0].shown_at, T0, 'the first showing is the as-of');
  snap(707, P.start, true, { at: T1 }); snap(707, P.sit, false, { at: T1 });
  clock(707, 4);
  follow.resolveDue({ now: LATER });
  const first = ledger(707);
  snap(707, P.start, false, { at: LATER }); snap(707, P.sit, true, { at: LATER }); // later noise
  const again = follow.resolveDue({ now: '2026-10-09T12:00:00.000Z' });
  assert.equal(again.resolved, 0);
  recLedger.record(lineupRec(707));
  const back = follow.backfillFromRecLedger({ leagueId: 707 });
  assert.equal(back.inserted, 0, 'the same call from rec_ledger is the same decision');
  assert.deepEqual(ledger(707), first);
});

/* ------------------------------------------------------------------ waivers */

test('waiver: with no transaction capture at all the call stays unresolved with a reason', () => {
  const exists = row(`SELECT 1 AS ok FROM sqlite_master WHERE name = 'league_transactions_raw'`);
  assert.equal(exists, undefined, 'this test runs before any test creates the raw table');
  const L = league(710);
  follow.logShown(L, [waiverRec(710)], { now: T0 });
  follow.resolveDue({ now: LATER });
  const r = ledger(710)[0];
  assert.equal(r.outcome, null);
  assert.equal(r.unresolved_reason, 'no_transaction_capture');
});

test('waiver: add of the pick -> follow; a different add -> ignore; no move in the window -> no_action', () => {
  txTable();
  const [A, B, C] = [league(711), league(712), league(713)];
  for (const L of [A, B, C]) follow.logShown(L, [waiverRec(L.id)], { now: T0 });
  tx(711, 'WAIVER', [{ playerId: ESPN(P.add), type: 'ADD', toTeamId: ME, fromTeamId: -1 },
    { playerId: ESPN(P.drop), type: 'DROP', fromTeamId: ME, toTeamId: -1 }]);
  tx(712, 'FREEAGENT', [{ playerId: ESPN(P.other), type: 'ADD', toTeamId: ME, fromTeamId: -1 }]);
  tx(713, 'FREEAGENT', [{ playerId: ESPN(P.add), type: 'ADD', toTeamId: 4, fromTeamId: -1 }], { team: 4 });
  tx(713, 'FREEAGENT', [{ playerId: ESPN(P.other), type: 'ADD', toTeamId: ME, fromTeamId: -1 }],
    { at: '2026-09-22T12:00:00.000Z' }); // before the call: not a response to it
  follow.resolveDue({ now: T1 });
  assert.equal(ledger(711)[0].outcome, null, 'the window is still open');
  follow.resolveDue({ now: LATER });
  const [a, b, c] = [ledger(711)[0], ledger(712)[0], ledger(713)[0]];
  assert.equal(a.outcome, 'follow');
  assert.equal(a.margin, 2.4);
  assert.equal(b.outcome, 'ignore');
  assert.equal(c.outcome, 'no_action');
});

/* ------------------------------------------------------------------ trades */

test('trade idea: an offer that asks for the pick -> follow; another offer -> ignore; none -> no_action', () => {
  txTable();
  const [A, B, C] = [league(721), league(722), league(723)];
  for (const L of [A, B, C]) follow.logShown(L, [tradeRec(L.id)], { now: T0 });
  tx(721, 'TRADE_PROPOSAL', [{ playerId: ESPN(P.get), type: 'TRADE', fromTeamId: PARTNER, toTeamId: ME },
    { playerId: ESPN(P.other), type: 'TRADE', fromTeamId: ME, toTeamId: PARTNER }], { status: 'PENDING' });
  tx(722, 'TRADE_PROPOSAL', [{ playerId: ESPN(P.other), type: 'TRADE', fromTeamId: 5, toTeamId: ME },
    { playerId: ESPN(P.give), type: 'TRADE', fromTeamId: ME, toTeamId: 5 }], { status: 'PENDING' });
  follow.resolveDue({ now: LATER });
  const [a, b, c] = [ledger(721)[0], ledger(722)[0], ledger(723)[0]];
  assert.equal(a.kind, 'trade');
  assert.equal(a.outcome, 'follow');
  assert.equal(a.margin, 6.5);
  assert.deepEqual(JSON.parse(a.alternative_json), { call: 'no_trade', keep: [P.give] });
  assert.equal(b.outcome, 'ignore');
  assert.equal(c.outcome, 'no_action');
});

/* ------------------------------------------------------------------ War Room */

test('a War Room next move is logged as its own kind and matched through its action', () => {
  const L = league(731);
  snap(731, P.start, false); snap(731, P.sit, true);
  const out = follow.logNextMove(L, {
    season: SEASON, week: 3, action: 'start_sit', margin: 0.4,
    pick: { id: P.start, slot: 'RB' }, alternative: { id: P.sit }, inputs: { plan_step: 1 },
  }, { now: T0 });
  assert.equal(out.inserted, 1);
  snap(731, P.start, true, { at: T1 }); snap(731, P.sit, false, { at: T1 });
  clock(731, 4);
  follow.resolveDue({ now: LATER });
  const r = ledger(731)[0];
  assert.equal(r.kind, 'next_move');
  assert.equal(r.action, 'start_sit');
  assert.equal(r.near_tie, 1);
  assert.equal(r.outcome, 'follow');
  assert.equal(follow.logNextMove(L, { season: SEASON, week: 3, action: 'dance' }, { now: T0 }).state, 'invalid');
});

/* ------------------------------------------------------------------ wiring */

test('the recommending routes log shown calls live through recordRoute', () => {
  const L = league(741);
  snap(741, P.start, false); snap(741, P.sit, true);
  recLedger.recordRoute('lineup', L, {
    season: SEASON, week: 3, objective: 'mean',
    lineup: [{ slot: 'RB', player: { id: P.start, week_points: 11 }, over: { id: P.sit, week_points: 9 } }],
  });
  const r = ledger(741);
  assert.equal(r.length, 1);
  assert.equal(r[0].source, 'live');
  assert.equal(r[0].margin, 2);
  assert.ok(r[0].rec_ledger_hash, 'joins back to the rec_ledger row');
});

test('backfill turns shown rec_ledger rows into follow rows, resolved on the final lineup alone', () => {
  const L = league(751, 3);
  recLedger.record([lineupRec(751), waiverRec(751)]);
  recLedger.record({ ...tradeRec(751), disposition: 'considered_not_shown' });
  const out = follow.backfillFromRecLedger({ leagueId: 751 });
  assert.equal(out.inserted, 2, 'one start/sit pair and one waiver claim; considered-not-shown is never shown');
  snap(751, P.start, true); snap(751, P.sit, false);
  clock(751, 4);
  follow.resolveDue({ now: LATER });
  const ss = ledger(751).find(r => r.kind === 'start_sit');
  assert.equal(ss.source, 'backfill');
  assert.equal(ss.outcome, 'follow');
  assert.equal(ss.basis, 'final_lineup_only');
  assert.equal(L.id, 751);
});

test('rollback of 081 refuses while the ledger holds rows', async () => {
  const mig = await import('../server/migrations/081_follow_ledger.js');
  assert.throws(() => mig.down(db), /rollback refused/);
});
