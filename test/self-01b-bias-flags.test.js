/**
 * SELF-01b: bias flags from Nick's own record, and the War Room card that shows them.
 *
 * Two record sources: follow_ledger (082, SELF-01a) for "which calls he skips", and
 * trade_outcomes (067) for "what he overpays for". A flag is SHOWN only when it passes
 * its pre-registered check: on his own forward weeks (walk-forward, fitted on earlier
 * weeks only) its precision beats the base rate, over at least MIN_EVAL_N predictions.
 * Everything else is held back, and the card only says how many.
 *
 * Each test uses its own league id. Every name below is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-self-bias-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const bias = await import('../server/services/engine/self-bias.js');
const selfView = await import('../server/services/war-room-self.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026;
const ME = 1, PARTNER = 2;
const RB = 9301, WR = 9302;
const ESPN = id => id - 6000;
run('INSERT INTO players (id, name, position, espn_id) VALUES (?,?,?,?)', RB, 'Made Up Back', 'RB', ESPN(RB));
run('INSERT INTO players (id, name, position, espn_id) VALUES (?,?,?,?)', WR, 'Made Up Wideout', 'WR', ESPN(WR));
// Realised points: the back scores 5 a week, the wideout 10.
for (let w = 1; w <= 17; w++) {
  run('INSERT INTO player_gamelog (player_id, season, week, fantasy_points) VALUES (?,?,?,?)', RB, SEASON, w, 5);
  run('INSERT INTO player_gamelog (player_id, season, week, fantasy_points) VALUES (?,?,?,?)', WR, SEASON, w, 10);
}

function league(id, week = 12) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, current_week)
       VALUES (?, 'espn', ?, ?, ?, ?, 6, ?, ?)`, id, `espn-self-${id}`, SEASON, `L${id}`,
  JSON.stringify({ teams: [] }), String(ME), week);
}

let seq = 0;
/** One resolved (or open) follow_ledger row, the shape 082 stores. */
function fl(leagueId, week, kind, outcome, pick, { nearTie = null } = {}) {
  const action = kind === 'next_move' ? 'start_sit' : kind;
  run(`INSERT INTO follow_ledger (league_id, team_id, season, week, kind, action, decision_key, source, shown_at,
         as_of_json, pick_json, alternative_json, margin, near_tie, outcome, complied, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'live', '2026-09-01T00:00:00.000Z', '{}', ?, 'null', 1, ?, ?, ?, ?)`,
  leagueId, String(ME), SEASON, week, kind, action, `k-${++seq}`, JSON.stringify(pick), nearTie,
  outcome, outcome == null ? null : outcome === 'follow' ? 1 : 0,
  outcome == null ? null : '2026-09-02T00:00:00.000Z');
}

function txTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
    league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
    type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
    team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
    bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    PRIMARY KEY (league_id, season, tx_id))`);
}

/**
 * One observed trade Nick was party to. `get` / `give` are from NICK's side; when he
 * is the counterparty the stored row is written from the partner's side, as
 * settleObservedOutcomes writes it.
 */
function trade(leagueId, week, { get, give, status = 'accepted', nickProposed = true, espnIds = null }) {
  const txId = `t-${++seq}`;
  const idOf = p => (espnIds?.[p] ?? ESPN(p));
  const nickGets = [{ playerId: idOf(get), fromTeamId: PARTNER, toTeamId: ME }];
  const nickGives = [{ playerId: idOf(give), fromTeamId: ME, toTeamId: PARTNER }];
  const proposer = nickProposed ? ME : PARTNER;
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, proposed_at,
         team_id, scoring_period, items_json, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, 'TRADE_PROPOSAL', 'EXECUTED', 'EXECUTE', '2026-09-10T00:00:00.000Z', ?, ?, ?, 'x', 'x')`,
  leagueId, SEASON, txId, proposer, week, JSON.stringify([...nickGets, ...nickGives]));
  run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id,
         give_json, get_json, proposed_at, status, espn_tx_id, created_at)
       VALUES (?, ?, 'observed', ?, ?, ?, ?, '2026-09-10T00:00:00.000Z', ?, ?, 'x')`,
  leagueId, SEASON, String(proposer), String(nickProposed ? PARTNER : ME),
  JSON.stringify(nickProposed ? nickGives : nickGets), JSON.stringify(nickProposed ? nickGets : nickGives),
  status, txId);
}

/* ------------------------------------------------------------ walk-forward, pure */

test('walkForward: a pattern that keeps holding on later weeks is shown, with its forward precision and base', () => {
  const ev = [];
  for (const p of [1, 2]) for (let i = 0; i < 2; i++) {
    ev.push({ period: p, hit: 1, cats: ['waiver'] });
    ev.push({ period: p, hit: 0, cats: ['start_sit'] });
  }
  for (const p of [3, 4]) for (let i = 0; i < 2; i++) {
    ev.push({ period: p, hit: 1, cats: ['waiver'] });
    ev.push({ period: p, hit: 0, cats: ['start_sit'] });
  }
  const out = bias.walkForward(ev, { minFit: 4, minEval: 4 });
  const w = out.candidates.find(c => c.category === 'waiver');
  assert.ok(w, 'waiver is a candidate');
  assert.equal(w.shown, true);
  assert.equal(w.forward.n, 4);
  assert.equal(w.forward.hits, 4);
  assert.equal(w.forward.precision, 1);
  assert.equal(w.forward.base_rate, 0.5);
  assert.equal(out.candidates.some(c => c.category === 'start_sit'), false, 'a below-base rate is never a candidate');
});

test('walkForward: a pattern that reverts on later weeks is held back as not_above_base', () => {
  const ev = [];
  for (const p of [1, 2]) for (let i = 0; i < 2; i++) {
    ev.push({ period: p, hit: 1, cats: ['waiver'] });
    ev.push({ period: p, hit: 0, cats: ['start_sit'] });
  }
  // Forward: he now follows waiver calls and skips start/sit.
  for (const p of [3, 4]) for (let i = 0; i < 2; i++) {
    ev.push({ period: p, hit: 0, cats: ['waiver'] });
    ev.push({ period: p, hit: 1, cats: ['start_sit'] });
  }
  // Keep waiver above base on the full fit, so it is still a candidate today.
  for (let i = 0; i < 5; i++) ev.push({ period: 1, hit: 1, cats: ['waiver'] });
  const out = bias.walkForward(ev, { minFit: 4, minEval: 4 });
  const w = out.candidates.find(c => c.category === 'waiver');
  assert.ok(w);
  assert.equal(w.shown, false);
  assert.equal(w.held_reason, 'not_above_base');
});

test('walkForward: too few forward predictions is held back as too_few_forward, however strong the fit', () => {
  const ev = [];
  for (let i = 0; i < 4; i++) ev.push({ period: 1, hit: 1, cats: ['trade'] }, { period: 1, hit: 0, cats: ['waiver'] });
  ev.push({ period: 2, hit: 1, cats: ['trade'] }, { period: 2, hit: 0, cats: ['waiver'] });
  const out = bias.walkForward(ev, { minFit: 4, minEval: 4 });
  const t = out.candidates.find(c => c.category === 'trade');
  assert.ok(t);
  assert.equal(t.forward.n, 1);
  assert.equal(t.shown, false);
  assert.equal(t.held_reason, 'too_few_forward');
});

test('walkForward: forward precision equal to the base rate is not above it, so the flag is held', () => {
  const ev = [];
  for (let i = 0; i < 4; i++) ev.push({ period: 1, hit: 1, cats: ['a'] }, { period: 1, hit: 0, cats: ['b'] });
  for (const p of [2, 3]) ev.push(
    { period: p, hit: 1, cats: ['a'] }, { period: p, hit: 0, cats: ['a'] },
    { period: p, hit: 1, cats: ['b'] }, { period: p, hit: 0, cats: ['b'] });
  const a = bias.walkForward(ev, { minFit: 4, minEval: 4 }).candidates.find(c => c.category === 'a');
  assert.equal(a.forward.precision, 0.5);
  assert.equal(a.forward.base_rate, 0.5);
  assert.equal(a.shown, false);
  assert.equal(a.held_reason, 'not_above_base');
});

test('walkForward: a week where the category only ties the overall rate makes no forward predictions', () => {
  const ev = [];
  for (let i = 0; i < 2; i++) ev.push({ period: 1, hit: 1, cats: ['a'] }, { period: 1, hit: 0, cats: ['a'] },
    { period: 1, hit: 1, cats: ['b'] }, { period: 1, hit: 0, cats: ['b'] });
  for (const p of [2, 3]) for (let i = 0; i < 4; i++) ev.push({ period: p, hit: 1, cats: ['a'] }, { period: p, hit: 0, cats: ['b'] });
  const a = bias.walkForward(ev, { minFit: 4, minEval: 4 }).candidates.find(c => c.category === 'a');
  assert.equal(a.forward.n, 4, 'active from week 3 only: at week 2 its 0.5 only ties the overall 0.5');
  assert.equal(a.forward.base_n, 8);
});

/* ---------------------------------------------------------------- which calls he skips */

function skipper(L) {
  league(L);
  // Weeks 1-2 fit, weeks 3-4 forward: he skips every waiver call and follows every start/sit.
  for (const w of [1, 2, 3, 4]) for (let i = 0; i < 2; i++) {
    fl(L, w, 'waiver', 'ignore', { add: RB, drop: null });
    fl(L, w, 'start_sit', 'follow', { id: WR, slot: 'WR' }, { nearTie: 0 });
  }
}

test('follow ledger: a waiver-skipping habit that holds forward becomes one shown flag with its numbers', () => {
  skipper(801);
  // Noise that must not count: no_action and open rows are not skips and not follows.
  fl(801, 3, 'waiver', 'no_action', { add: RB, drop: null });
  fl(801, 4, 'waiver', null, { add: RB, drop: null });
  const out = bias.selfBiasFlags(801);
  assert.equal(out.state, 'ok');
  const f = out.flags.find(x => x.category === 'waiver');
  assert.ok(f, JSON.stringify(out.flags));
  assert.equal(f.bias, 'ignores');
  assert.equal(f.label, 'You skip waiver calls');
  assert.equal(f.forward.n, 4);
  assert.equal(f.forward.precision, 1);
  assert.equal(f.forward.base_rate, 0.5);
  // The per-position child says nothing its parent does not: shown once, not twice.
  assert.equal(out.flags.some(x => x.category === 'waiver:RB'), false);
  assert.equal(out.follow.by_kind.waiver.ignore, 8);
  assert.equal(out.follow.by_kind.waiver.no_action, 1);
  assert.equal(out.follow.by_kind.waiver.open, 1);
  assert.equal(out.follow.by_kind.start_sit.follow, 8);
});

test('follow ledger: only follow and ignore rows are events; no_action and open rows are counted aside', () => {
  league(803);
  fl(803, 1, 'waiver', 'ignore', { add: RB });
  fl(803, 1, 'waiver', 'no_action', { add: RB });
  fl(803, 1, 'trade', null, { give: [WR], get: [RB] });
  const out = bias.followEvents(803);
  assert.equal(out.events.length, 1);
  assert.deepEqual(out.excluded, { no_action: 1, open: 1 });
  assert.deepEqual(out.events[0].cats.sort(), ['waiver', 'waiver:RB']);
});

/* --------------------------------------------------------------- what he overpays for */

function overpayer(L) {
  league(L);
  txTable();
  // Weeks 1-4 fit: every back he trades for costs him a wideout (40 given, 20 back over 4 weeks);
  // every wideout he trades for costs a back (a fair trade the other way).
  for (const w of [1, 2, 3, 4]) {
    trade(L, w, { get: RB, give: WR, nickProposed: w !== 2 });
    trade(L, w, { get: WR, give: RB });
  }
  // Weeks 5-6 forward: the same again, twice a week.
  for (const w of [5, 6]) for (let i = 0; i < 2; i++) {
    trade(L, w, { get: RB, give: WR });
    trade(L, w, { get: WR, give: RB });
  }
}

test('trade outcomes: overpaying for backs, repeated forward, is a shown flag on realised points', () => {
  overpayer(802);
  const ev = bias.overpayEvents(802);
  assert.equal(ev.state, 'ok');
  assert.equal(ev.events.length, 16);
  const first = ev.events.find(e => e.period === SEASON * 100 + 1 && e.cats.includes('acquire:RB'));
  assert.equal(first.hit, 1);
  assert.equal(first.gave_points, 40);
  assert.equal(first.got_points, 20);
  // Week 2's back came in a trade the partner proposed: still Nick's side, still an overpay.
  assert.equal(ev.events.find(e => e.period === SEASON * 100 + 2 && e.cats.includes('acquire:RB')).hit, 1);
  const out = bias.selfBiasFlags(802);
  const f = out.flags.find(x => x.category === 'acquire:RB');
  assert.ok(f, JSON.stringify(out));
  assert.equal(f.bias, 'overpays');
  assert.equal(f.label, 'You pay too much when you trade for RBs');
  assert.equal(f.forward.n, 4);
  assert.equal(f.forward.precision, 1);
  assert.equal(f.forward.base_rate, 0.5);
});

test('trade outcomes: an open horizon, an unmapped player and a declined offer are never scored', () => {
  league(804, 12);
  txTable();
  trade(804, 9, { get: RB, give: WR }); // weeks 10-13: week 12 is not over yet
  trade(804, 2, { get: RB, give: WR, espnIds: { [RB]: 424242 } }); // no local player
  trade(804, 2, { get: RB, give: WR, status: 'declined' });
  const out = bias.overpayEvents(804);
  assert.equal(out.events.length, 0);
  assert.deepEqual(out.unscorable, { horizon_open: 1, unmapped_player: 1 });
});

test('killed biases are never built: endowment and post-loss panic are listed as killed and never flagged', () => {
  assert.deepEqual([...bias.KILLED_BIASES].sort(), ['endowment', 'post_loss_panic']);
  const out = bias.selfBiasFlags(801);
  for (const f of out.flags) assert.ok(['ignores', 'overpays'].includes(f.bias));
});

test('a league with no ledger rows and no trades says so, never a flag list of zeros', () => {
  league(805);
  const out = bias.selfBiasFlags(805);
  assert.equal(out.flags.length, 0);
  assert.equal(out.held, 0);
  assert.equal(out.sources.follow_ledger, 'empty');
  assert.equal(out.sources.trade_outcomes, 'empty');
});

/* --------------------------------------------------------------------- the view */

test('War Room self view: off unless its own flag is set, and held flags are counted, never named', () => {
  delete process.env[selfView.SELF_CLONE_ENV];
  assert.deepEqual(selfView.warRoomSelf(801), { enabled: false });
  process.env[selfView.SELF_CLONE_ENV] = '1';
  try {
    const v = selfView.warRoomSelf(801);
    assert.equal(v.enabled, true);
    assert.equal(v.flags.status, 'ok');
    assert.deepEqual(v.flags.value.map(f => f.category), ['waiver']);
    assert.equal(v.follow.status, 'ok');
    const w = v.follow.value.kinds.find(k => k.kind === 'waiver');
    assert.equal(w.ignore, 8);
    assert.equal(typeof v.held, 'number');
    assert.doesNotMatch(JSON.stringify(v), /start_sit:WR|held_reason|held_by_reason|too_few_forward|not_above_base/, 'held categories are not served');
    const empty = selfView.warRoomSelf(805);
    assert.equal(empty.follow.status, 'unknown');
    assert.match(empty.follow.reason, /no shown call has been resolved/);
  } finally { delete process.env[selfView.SELF_CLONE_ENV]; }
});

/* ------------------------------------------- FIX-284-3: regret ledger, concession guard */

const TE = 9303, QB = 9304, WR2 = 9305;
run('INSERT INTO players (id, name, position, espn_id) VALUES (?,?,?,?)', TE, 'Made Up End', 'TE', ESPN(TE));
run('INSERT INTO players (id, name, position, espn_id) VALUES (?,?,?,?)', QB, 'Made Up Passer', 'QB', ESPN(QB));
run('INSERT INTO players (id, name, position, espn_id) VALUES (?,?,?,?)', WR2, 'Made Up Slot', 'WR', ESPN(WR2));
// As-of values: what the engine projected for the week, before it. Deliberately equal to the
// realised points above for RB and WR, so as-of and realised can be told apart only by week.
const PRED = { [RB]: 5, [WR]: 10, [TE]: 1, [QB]: 3, [WR2]: 10 };
for (let w = 1; w <= 17; w++) for (const [id, p] of Object.entries(PRED)) {
  run(`INSERT INTO weekly_prediction_snapshots (season, week, player_id, position, as_of, cutoff, engine_version,
         structural, prediction) VALUES (?, ?, ?, 'X', 'x', 'x', 'test', ?, ?)`, SEASON, w, Number(id), p, p);
}

/** One observed offer with lists from NICK's side, to `partner`. */
function offer(leagueId, week, { get, give, status = 'declined', nickProposed = true, partner = PARTNER }) {
  const txId = `o-${++seq}`;
  const nickGets = get.map(p => ({ playerId: ESPN(p), fromTeamId: partner, toTeamId: ME }));
  const nickGives = give.map(p => ({ playerId: ESPN(p), fromTeamId: ME, toTeamId: partner }));
  const proposer = nickProposed ? ME : partner;
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, proposed_at, team_id,
         scoring_period, items_json, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, 'TRADE_PROPOSAL', 'X', '2026-09-10T00:00:00.000Z', ?, ?, ?, 'x', 'x')`,
  leagueId, SEASON, txId, proposer, week, JSON.stringify([...nickGets, ...nickGives]));
  run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id,
         give_json, get_json, proposed_at, status, espn_tx_id, created_at)
       VALUES (?, ?, 'observed', ?, ?, ?, ?, '2026-09-10T00:00:00.000Z', ?, ?, 'x')`,
  leagueId, SEASON, String(proposer), String(nickProposed ? partner : ME),
  JSON.stringify(nickProposed ? nickGives : nickGets), JSON.stringify(nickProposed ? nickGets : nickGives),
  status, txId);
}

test('regret ledger: the road not taken, valued as of that week, and realised once the horizon is over', () => {
  league(806, 12);
  txTable();
  offer(806, 2, { get: [RB], give: [WR], status: 'accepted' }); // passed on keeping WR
  offer(806, 3, { get: [WR], give: [RB], status: 'declined', nickProposed: false }); // passed on taking WR
  offer(806, 3, { get: [WR], give: [RB], status: 'declined' }); // his own offer turned down: not his call
  offer(806, 9, { get: [RB], give: [WR], status: 'accepted' }); // weeks 10-13: not over at week 12
  offer(806, 4, { get: [WR], give: [RB], status: 'proposed', nickProposed: false }); // still live
  const r = bias.regretLedger(806);
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.aside, { not_his_call: 1, not_settled: 1 });
  assert.equal(r.entries.length, 3);
  const [kept, declined, open] = r.entries;
  assert.equal(kept.passed_on, 'keep');
  assert.equal(kept.as_of_edge, 20, '(10 - 5) a week, as of week 2, over 4 weeks');
  assert.equal(kept.realised_regret, 20, 'WR scored 40 over weeks 3-6, RB 20');
  assert.equal(declined.passed_on, 'accept');
  assert.equal(declined.role, 'counterparty');
  assert.equal(declined.realised_regret, 20);
  assert.equal(open.realised_state, 'horizon_open');
  assert.equal(open.realised_regret, null, 'an open horizon is null, never 0');
});

test('regret ledger: a week with no as-of snapshot is unknown, never valued at 0', () => {
  league(807, 12);
  txTable();
  offer(807, 18, { get: [RB], give: [WR], status: 'declined', nickProposed: false });
  const [e] = bias.regretLedger(807).entries;
  assert.equal(e.as_of_edge, null);
  assert.equal(e.as_of_state, 'no_snapshot');
});

/**
 * Two managers a week for each position he chases, each turning down a first offer and
 * getting a re-offer. For backs he adds a 10-a-week wideout; for wideouts, a 3-a-week passer.
 */
function conceder(L, weeks, { liveBackReoffer = false } = {}) {
  league(L, 12);
  txTable();
  let partner = 100;
  for (const w of weeks) for (let i = 0; i < 2; i++) {
    const pb = ++partner, pw = ++partner;
    offer(L, w, { get: [RB], give: [TE], partner: pb });
    offer(L, w, { get: [RB], give: [TE, WR2], partner: pb });
    offer(L, w, { get: [WR], give: [TE], partner: pw });
    offer(L, w, { get: [WR], give: [TE, QB], partner: pw });
  }
  if (liveBackReoffer) {
    const p = ++partner, w = weeks.at(-1) + 1;
    offer(L, w, { get: [RB], give: [TE], partner: p });
    offer(L, w, { get: [RB], give: [TE, WR2], partner: p, status: 'proposed' });
  }
}

test('concession guard: concession is re-measured as of the re-offer week, and the norm uses earlier weeks only', () => {
  conceder(808, [1, 2]);
  const g = bias.concessionGuard(808);
  assert.equal(g.reoffers.length, 8);
  assert.deepEqual(g.reoffers.map(r => r.concession), [10, 3, 10, 3, 10, 3, 10, 3]);
  assert.equal(g.reoffers[0].norm, null, 'week 1 has no earlier concessions');
  assert.equal(g.reoffers[4].norm, 6.5, 'week 2 norm = median of week 1 only');
  assert.deepEqual(g.reoffers.slice(4).map(r => r.over_norm), [true, false, true, false]);
  assert.equal(g.aside.no_norm_yet, 4);
});

test('concession guard: shown only once its category passes the forward check; before that it is held', () => {
  conceder(809, [1, 2, 3]);
  const early = bias.selfBiasFlags(809);
  assert.equal(early.flags.some(f => f.bias === 'concedes'), false);
  assert.deepEqual(early.concession.guarded, []);
  assert.ok(early.concession.guarded_held > 0, 'above-norm re-offers exist but are held');

  conceder(810, [1, 2, 3, 4, 5], { liveBackReoffer: true });
  const out = bias.selfBiasFlags(810);
  const f = out.flags.find(x => x.bias === 'concedes');
  assert.ok(f, JSON.stringify(out.concession));
  assert.equal(f.category, 'concede:RB');
  assert.equal(f.label, 'You give up more than your norm when you re-offer for RBs');
  assert.ok(f.forward.precision > f.forward.base_rate);
  const live = out.concession.guarded.find(r => r.status === 'proposed');
  assert.ok(live, 'the live re-offer for a back is guarded');
  assert.equal(live.concession, 10);
  assert.ok(live.concession > live.norm);
  assert.equal(out.concession.guarded.some(r => r.concession === 3), false, 'wideout re-offers are under the norm');
});

/* ------------------------------------------------ FIX-284-2: the flag, off / on / preview */

test('self card flag: off, on by its own switch, and on under preview mode with the reason on the view', async () => {
  const { PREVIEW_ENV, PREVIEW_PREFIX } = await import('../server/services/preview-mode.js');
  const saved = { own: process.env[selfView.SELF_CLONE_ENV], pv: process.env[PREVIEW_ENV] };
  try {
    delete process.env[selfView.SELF_CLONE_ENV]; delete process.env[PREVIEW_ENV];
    assert.deepEqual(selfView.selfCloneFlag(), { enabled: false });
    assert.deepEqual(selfView.warRoomSelf(801), { enabled: false });

    process.env[selfView.SELF_CLONE_ENV] = '1';
    assert.deepEqual(selfView.selfCloneFlag(), { enabled: true });
    const on = selfView.warRoomSelf(801);
    assert.equal(on.enabled, true);
    assert.equal('preview' in on, false, 'its own switch is not a preview');
    assert.equal(on.note, selfView.NOTE);

    delete process.env[selfView.SELF_CLONE_ENV];
    process.env[PREVIEW_ENV] = '1';
    assert.deepEqual(selfView.selfCloneFlag(),
      { enabled: true, preview: true, preview_reason: selfView.SELF_CLONE_OFF_REASON });
    const pv = selfView.warRoomSelf(801);
    assert.equal(pv.enabled, true);
    assert.equal(pv.preview, true);
    assert.equal(pv.preview_reason, selfView.SELF_CLONE_OFF_REASON);
    assert.ok(pv.note.startsWith(PREVIEW_PREFIX));
  } finally {
    for (const [k, v] of [[selfView.SELF_CLONE_ENV, saved.own], [PREVIEW_ENV, saved.pv]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('self view: regret, guard and clone sections are typed; the clone is unknown until fitted', () => {
  process.env[selfView.SELF_CLONE_ENV] = '1';
  try {
    const v = selfView.warRoomSelf(806);
    assert.equal(v.regret.status, 'ok');
    assert.deepEqual({ choices: v.regret.value.choices, scored: v.regret.value.scored, open: v.regret.value.open },
      { choices: 3, scored: 2, open: 1 });
    assert.equal(v.regret.value.realised_regret, 40);
    assert.equal(v.guard.status, 'unknown');
    assert.equal(v.clone.status, 'unknown');
    assert.equal(v.clone.reason, selfView.CLONE_UNFITTED);
    const g = selfView.warRoomSelf(810);
    assert.equal(g.guard.status, 'ok');
    assert.ok(g.guard.value.reoffers.length >= 1);
    assert.equal(selfView.warRoomSelf(805).regret.status, 'unknown');
  } finally { delete process.env[selfView.SELF_CLONE_ENV]; }
});

test('concession guard: the same offer re-sent after its player rose in value is no concession', () => {
  const RISER = 9306;
  run('INSERT INTO players (id, name, position, espn_id) VALUES (?,?,?,?)', RISER, 'Made Up Riser', 'WR', ESPN(RISER));
  for (let w = 1; w <= 17; w++) {
    run(`INSERT INTO weekly_prediction_snapshots (season, week, player_id, position, as_of, cutoff, engine_version,
           structural, prediction) VALUES (?, ?, ?, 'X', 'x', 'x', 'test', ?, ?)`, SEASON, w, RISER, w === 1 ? 2 : 10, w === 1 ? 2 : 10);
  }
  league(811, 12);
  txTable();
  offer(811, 1, { get: [RB], give: [RISER] });
  offer(811, 2, { get: [RB], give: [RISER] });
  const [r] = bias.concessionGuard(811).reoffers;
  assert.equal(r.concession, 0, 'both sides valued as of week 2; week 1 values would call it an 8-point concession');
});
