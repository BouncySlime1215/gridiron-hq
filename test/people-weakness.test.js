/**
 * WEAK-01: the weakness scanner (people/weakness.js) and its hub producer
 * (engine/producers/weakness.js -> people.weakness). WEAK-02: the seller ranking inverted per
 * r44 (recent activity raises it; roster holes and desperation weigh 0, kept as framing facts).
 *
 * Fixtures only: league 51, four invented rosters, invented player ids, no chat corpus
 * (GRIDIRON_CHAT_DB_PATH points at a file that does not exist), so the counterpart rows
 * are typed unknown and in_market must come out absent with a reason, never zero.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-weakness-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'no-chat.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'test';
delete process.env.GRIDIRON_WEAKNESS;
delete process.env.GRIDIRON_HUB_PEOPLE;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const W = await import('../server/services/people/weakness.js');

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
};

/* ------------------------------------------------------------------ pure pieces */
test('flag: default off; =1 on; preview turns it on labelled; =0 vetoes preview', () => {
  withEnv({ GRIDIRON_WEAKNESS: null, GRIDIRON_PREVIEW_UNCONFIRMED: null }, () => assert.equal(W.weaknessFlag().on, false));
  withEnv({ GRIDIRON_WEAKNESS: '1' }, () => assert.deepEqual(W.weaknessFlag(), { on: true, preview: false }));
  withEnv({ GRIDIRON_WEAKNESS: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => {
    const f = W.weaknessFlag();
    assert.equal(f.on, true); assert.equal(f.preview, true); assert.match(f.preview_reason, /default-off/);
  });
  withEnv({ GRIDIRON_WEAKNESS: '0', GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => assert.equal(W.weaknessFlag().on, false));
});

test('slot demand leaves K/DEF out (streamed); unfilled slots fill dedicated first, then flex', () => {
  const d = W.slotDemand(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BENCH']);
  assert.deepEqual(d.dedicated, { QB: 1, RB: 2, WR: 2, TE: 1 });
  assert.equal(d.flex.length, 1);
  assert.deepEqual(W.unfilledSlots(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'WR'], d), []);
  assert.deepEqual(W.unfilledSlots(['RB', 'RB', 'WR', 'WR', 'TE'], d), ['QB', 'FLEX(RB/WR/TE)']);
});

test('PP intensity reproduces the IDEA-084 linear predictor by hand; thin before two completed weeks', () => {
  const hist = [{ adds: 2, pts: 100, opp: 90, dead: 0, empty: 0 }, { adds: 0, pts: 80, opp: 120, dead: 1, empty: 0 }];
  const r = W.ppIntensity(hist, { leagueMeanAdds: 1, leagueMeanPts: 100 });
  const c = W.PP_ADDS;
  const l0 = (2 + c.alpha * 1) / (2 + c.alpha);
  const E = 0 + c.gamma * 2, S = 1 + c.gamma;
  const exc = Math.log1p(E) - Math.log1p(l0 * S);
  const eta = Math.log(l0) * (1 + c.logl0) + c.const + c.lost1 * 1 + c.margin1 * -0.4 + c.dead1 * 1 + c.wp * 0.5 + c.exc * exc;
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(r.lambda - Math.exp(eta)) < 1e-9, `${r.lambda} vs ${Math.exp(eta)}`);
  assert.equal(W.ppIntensity(hist.slice(0, 1), { leagueMeanAdds: 1, leagueMeanPts: 100 }).status, 'thin');
});

test('in_market: wants_player is proven; an unknown counterpart is absent with a reason; shop talk alone is not scored', () => {
  const nick = new Set(['900']);
  const cp = { status: 'ok', wants: [{ player: '900', n: 4, lift: 1 }], shopping: [], credibility: { shop: null, untouchable: null } };
  const r = W.inMarketSurface({ cp, cpAsOf: '2026-09-24T00:00:00.000Z', nickRoster: nick, asOfMs: null });
  assert.equal(r.surface.confidence, 'proven');
  assert.equal(r.surface.signal, 'wants_player');
  assert.equal(r.surface.strength, 0.5);
  assert.equal(r.surface.as_of, '2026-09-24T00:00:00.000Z');
  assert.equal(r.surface.evidence.wants[0].nick_has_him, true);
  assert.match(r.surface.evidence.credibility.table.reason, /people_credibility/);
  assert.match(W.inMarketSurface({ cp: { status: 'unknown', reason: 'no read' }, nickRoster: nick }).absent, /unknown: no read/);
  assert.match(W.inMarketSurface({ cp: null, nickRoster: nick }).absent, /no people\.counterpart row/);
  const shop = W.inMarketSurface({ cp: { status: 'ok', wants: [], shopping: ['901'] }, nickRoster: nick, cred: [] });
  assert.equal(shop.surface, null);
  assert.match(shop.clear_reason, /no proven credibility/);
  const proven = W.inMarketSurface({ cp: { status: 'ok', wants: [], shopping: ['901'] }, nickRoster: nick,
    cred: [{ roster_id: '2', stmt_type: 'shop', window_days: 7, status: 'proven', lift_shrunk: 1.5, n_statements: 6, as_of: '2026-09-23T00:00:00.000Z' }] });
  assert.equal(proven.surface.signal, 'credibility');
  assert.equal(proven.surface.confidence, 'proven');
});

test('value_gap is unproven; only directions Nick can use count (sell what he prices high, buy what he prices low)', () => {
  const r = W.valueGapSurface({ asOfMs: Date.parse('2026-09-24T00:00:00Z'), reads: [
    { player: '1', owner: 'nick', multiplier: 1.1, sources: ['positional_need'] },
    { player: '2', owner: 'his', multiplier: 1.15, sources: ['talk_vs_model'] },   // he prices his own high: not a buy
    { player: '3', owner: 'his', multiplier: 0.95, sources: ['outscoring_usage'] },
  ] });
  assert.equal(r.surface.confidence, 'unproven');
  assert.deepEqual(r.surface.evidence.gaps.map(g => [g.player, g.side]), [['1', 'sell_to_him'], ['3', 'buy_from_him']]);
  assert.equal(r.surface.strength, 0.5);
  assert.match(W.valueGapSurface({ reads: null }).absent, /no valuation-map read/);
});

test('ledger replay: a captured base plus later moves; moves at or after the cut are not seen', () => {
  const tx = [
    { tx_id: 'a', type: 'FREEAGENT', status: 'EXECUTED', team_id: 2, scoring_period: 2, proposed_at: '2026-09-19T00:00:00Z',
      items_json: JSON.stringify([{ type: 'ADD', playerId: 7, toTeamId: 2, fromTeamId: 0 }, { type: 'DROP', playerId: 5, fromTeamId: 2, toTeamId: 0 }]) },
    { tx_id: 'b', type: 'TRADE_ACCEPT', status: 'EXECUTED', execution_type: 'PROCESS', team_id: 2, scoring_period: 2, processed_at: '2026-09-20T00:00:00Z',
      items_json: JSON.stringify([{ type: 'TRADE', playerId: 6, fromTeamId: 2, toTeamId: 3 }]) },
  ];
  const base = new Map([['2', new Set(['5', '6'])], ['3', new Set(['8'])]]);
  const before = W.replayLedger(tx, Date.parse('2026-09-19T12:00:00Z'), { base, baseMs: Date.parse('2026-09-18T00:00:00Z') });
  assert.deepEqual([...before.rosters.get('2')].sort(), ['6', '7']);
  assert.deepEqual([...before.rosters.get('3')], ['8']);
  assert.equal(before.adds.get('2').get(2), 1);
  const after = W.replayLedger(tx, Date.parse('2026-09-21T00:00:00Z'), { base, baseMs: Date.parse('2026-09-18T00:00:00Z') });
  assert.deepEqual([...after.rosters.get('3')].sort(), ['6', '8']);
  assert.equal(after.lastAction.get('2').type, 'TRADE_ACCEPT');
  assert.deepEqual(W.executedTrades(tx).map(t => [t.tx_id, [...t.sides.keys()]]), [['b', ['2']]]);
});

test('WEAK-02 recent_activity: recent and busy score high, idle and never-moved low; labels cite r44', () => {
  const cutMs = Date.parse('2026-10-01T00:00:00Z');
  const at = d => ({ at: cutMs - d * 864e5 - 1000, type: 'WAIVER' });
  const s = (lastMove, intensity = null, leagueLambdas = []) => W.recentActivitySurface({ intensity, leagueLambdas, lastMove, cutMs, asOfMs: cutMs }).surface;
  assert.equal(s(at(1)).strength, 1);
  assert.equal(s(at(3)).strength, 1);
  assert.equal(s(at(5)).strength, 0.629);
  assert.equal(s(at(10)).strength, 0.428);
  assert.equal(s(at(20)).strength, 0.334);
  assert.equal(s(at(45)).strength, 0.127);
  assert.equal(s(null).strength, 0.147);
  assert.ok(s(at(1)).strength > s(at(20)).strength, 'inverted from WEAK-01: recency raises, idleness lowers');
  // Intensity well below the league median discounts (Sleeper 2021-22: 3.4% vs 7.3%).
  const low = s(at(1), { status: 'ok', lambda: 0.2, week: 3, features: {} }, [0.2, 1, 1]);
  assert.equal(low.evidence.intensity_weight, 0.47);
  assert.equal(low.strength, 0.47);
  const r = s(at(1));
  assert.match(r.evidence.measured_lift, /r44: sold within 14 days at 10\.5% .* vs 1\.5% at 30-60 days/);
  assert.match(r.evidence.measured_lift, /\+0\.00063 \[\+0\.00034, \+0\.00088\]/);
  assert.match(r.evidence.source, /r44-WEAK-SLEEPER/);
  assert.match(r.evidence.ranking_holdout, /top-3 hit 0\.355 vs WEAK-01 0\.205/);
  assert.ok(W.PROVEN_SIGNALS.includes(r.signal));
  assert.deepEqual(W.SELLER_WEIGHT, { roster_hole: 0, value_gap: 1, desperation: 0, recent_activity: 1, in_market: 1 });
});

test('ledger replay: lastMove counts claims (any status) and executed trades for both sides, never lineups or proposals', () => {
  const tx = [
    { tx_id: 'l', type: 'ROSTER', status: 'EXECUTED', team_id: 2, proposed_at: '2026-09-20T00:00:00Z', items_json: '[]' },
    { tx_id: 'p', type: 'TRADE_PROPOSAL', status: 'PENDING', team_id: 2, proposed_at: '2026-09-21T00:00:00Z', items_json: '[]' },
    { tx_id: 'w', type: 'WAIVER', status: 'FAILED_PLAYERALREADYDROPPED', team_id: 2, proposed_at: '2026-09-18T00:00:00Z', items_json: '[]' },
    { tx_id: 't', type: 'TRADE_ACCEPT', status: 'EXECUTED', execution_type: 'PROCESS', team_id: 3, processed_at: '2026-09-19T00:00:00Z',
      items_json: JSON.stringify([{ type: 'TRADE', playerId: 6, fromTeamId: 4, toTeamId: 3 }]) },
  ];
  const r = W.replayLedger(tx, Date.parse('2026-09-25T00:00:00Z'));
  assert.deepEqual(r.lastMove.get('2'), { at: Date.parse('2026-09-18T00:00:00Z'), type: 'WAIVER' });
  assert.equal(r.lastAction.get('2').type, 'TRADE_PROPOSAL');
  assert.equal(r.lastMove.get('3').type, 'TRADE_ACCEPT');
  assert.equal(r.lastMove.get('4').type, 'TRADE_ACCEPT', 'the other side of an executed trade moved too');
});

/* ------------------------------------------------------------------ fixture league */
const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await import('../server/services/manager-identity.js');
await runMigrations();
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
const payload = JSON.stringify({ settings: { tradeSettings: { deadlineDate: Date.parse('2026-11-20T17:00:00Z') },
  scheduleSettings: { playoffTeamCount: 2, matchupPeriodCount: 14 } } });
run(`INSERT INTO leagues(id, platform, league_id, season, name, my_team_id, roster_positions, payload)
  VALUES (51, 'espn', 'fx-51', 2026, 'L51', '1', ?, ?)`,
  JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF']), payload);
// Two NFL teams with byes: ATL (ESPN pro id 1) week 5, BUF (ESPN pro id 2) week 6.
run(`INSERT OR IGNORE INTO nfl_teams (id, abbr, name, conference, division) VALUES (9001, 'ATL', 'A', 'N', 'S'), (9002, 'BUF', 'B', 'A', 'E')`);
for (const [tid, bye] of [[9001, 5], [9002, 6]]) {
  for (let w = 1; w <= 18; w++) if (w !== bye) run(`INSERT INTO schedule_games (season, team_id, week, date) VALUES (2026, ?, ?, ?)`,
    tid, w, new Date(Date.parse('2026-09-10T00:00:00Z') + (w - 1) * 7 * 864e5).toISOString().slice(0, 10));
}
// Rosters (team 1 = Nick). Team 2 carries one QB (ATL, bye 5): a QB hole in week 5.
const P = { QB: 1, RB: 2, WR: 3, TE: 4 };
const rosters = {
  1: [[101, 'QB', 1], [102, 'RB', 2], [103, 'RB', 2], [104, 'WR', 2], [105, 'WR', 2], [106, 'TE', 2], [107, 'WR', 2]],
  2: [[201, 'QB', 1], [202, 'RB', 2], [203, 'RB', 2], [204, 'WR', 2], [205, 'WR', 2], [206, 'TE', 2], [207, 'RB', 2]],
  3: [[301, 'QB', 1], [311, 'QB', 2], [302, 'RB', 2], [303, 'RB', 1], [304, 'WR', 2], [305, 'WR', 1], [306, 'TE', 2], [307, 'WR', 2]],
  4: [[401, 'QB', 1], [411, 'QB', 2], [402, 'RB', 2], [403, 'RB', 1], [404, 'WR', 2], [405, 'WR', 1], [406, 'TE', 2], [407, 'TE', 1]],
};
for (const w of [1, 2, 3]) {
  for (const [team, list] of Object.entries(rosters)) {
    list.forEach(([pid, pos, pro], i) => run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id,
        espn_player_id, player_name, position, pro_team_id, lineup_slot_id, lineup_slot, is_starter, actual_points, on_roster, source,
        first_seen_at, changed_at) VALUES (51, 2026, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'final', ?, ?)`,
      w, Number(team), pid, `Fixture Player ${pid}`, pos, pro, i < 7 ? 2 : 20, i < 7 ? 'RB' : 'BENCH', i < 7 ? 1 : 0,
      w < 3 ? 10 : null, '2026-09-22T20:00:00.000Z', '2026-09-22T20:00:00.000Z'));
  }
}
// Scores: weeks 1-2 complete. Team 2 lost both (0-2); team 3 won both.
const sc = [[1, 1, 100, 2], [1, 2, 80, 1], [1, 3, 120, 4], [1, 4, 90, 3], [2, 1, 110, 3], [2, 3, 130, 1], [2, 2, 70, 4], [2, 4, 95, 2]];
for (const [w, r, pts, opp] of sc) run(`INSERT INTO league_week_scores VALUES (51, 2026, ?, ?, ?, ?, 0, '2026-09-23T00:00:00Z')`, w, String(r), pts, String(opp));
for (let w = 3; w <= 14; w++) for (const r of [1, 2, 3, 4]) run(`INSERT INTO league_week_scores VALUES (51, 2026, ?, ?, 0, ?, 0, '2026-09-23T00:00:00Z')`, w, String(r), String(((r + w) % 4) + 1));
// Ledger: team 3 adds every week (active); team 2's last action was a lineup set on 9/5 (idle);
// one executed trade in week 2 between Nick (1) and team 3.
const tx = (id, type, status, exec, team, period, at, items, processed = null) => run(`INSERT INTO league_transactions_raw
  (league_id, season, tx_id, type, status, execution_type, proposed_at, processed_at, team_id, scoring_period, items_json, first_seen_at, last_seen_at)
  VALUES (51, 2026, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, type, status, exec, at, processed, team, period, JSON.stringify(items), at, at);
tx('r2', 'ROSTER', 'EXECUTED', 'EXECUTE', 2, 1, '2026-09-05T00:00:00.000Z', [{ type: 'LINEUP', playerId: 201, fromTeamId: 0, toTeamId: 0 }]);
tx('a31', 'FREEAGENT', 'EXECUTED', 'EXECUTE', 3, 1, '2026-09-12T00:00:00.000Z', [{ type: 'ADD', playerId: 391, toTeamId: 3, fromTeamId: 0 }, { type: 'DROP', playerId: 391, fromTeamId: 3, toTeamId: 0 }]);
tx('a32', 'FREEAGENT', 'EXECUTED', 'EXECUTE', 3, 2, '2026-09-19T00:00:00.000Z', [{ type: 'ADD', playerId: 392, toTeamId: 3, fromTeamId: 0 }, { type: 'DROP', playerId: 392, fromTeamId: 3, toTeamId: 0 }]);
tx('a41', 'FREEAGENT', 'EXECUTED', 'EXECUTE', 4, 2, '2026-09-19T01:00:00.000Z', [{ type: 'ADD', playerId: 491, toTeamId: 4, fromTeamId: 0 }, { type: 'DROP', playerId: 491, fromTeamId: 4, toTeamId: 0 }]);
tx('t1', 'TRADE_ACCEPT', 'EXECUTED', 'PROCESS', 1, 2, '2026-09-16T00:00:00.000Z',
  [{ type: 'TRADE', playerId: 107, fromTeamId: 1, toTeamId: 3 }, { type: 'TRADE', playerId: 307, fromTeamId: 3, toTeamId: 1 }], '2026-09-16T00:00:00.000Z');

const NOW = '2026-09-24T12:00:00.000Z';

test('scan: every counterparty scanned; every surface carries evidence + as_of; proven only on tested signals', async () => {
  const inp = await W.weaknessInputs(51, { cutMs: Date.parse(NOW) });
  assert.equal(inp.currentWeek, 3);
  assert.deepEqual(inp.teams, ['1', '2', '3', '4']);
  assert.match(inp.rosterBasis, /week 3 lineup captured/);
  const scan = W.scanLeague(inp, { valueReason: 'fixture: no valuation map' });
  const m = W.scanMetrics(scan);
  assert.equal(m.managers_scanned, 3, 'Nick excluded');
  assert.equal(m.share_with_evidence_and_as_of, 1);
  assert.equal(m.proven_on_tested_signal, m.proven);
  const t2 = scan.teams.get('2');
  const hole = t2.surfaces.find(s => s.kind === 'roster_hole');
  assert.equal(hole.confidence, 'measured');
  // Week 5: his one QB (ATL) is on bye. Week 6: six BUF starters out, a crunch and the worst week.
  assert.deepEqual(hole.evidence.weeks.find(x => x.week === 5), { week: 5, unfillable: 1, crunch: false });
  assert.equal(hole.evidence.worst_week, 6);
  assert.equal(hole.evidence.crunch, true);
  const desp = t2.surfaces.find(s => s.kind === 'desperation');
  assert.equal(desp.evidence.wins, 0);
  assert.equal(desp.evidence.losing_streak, 2);
  assert.equal(desp.evidence.playoff_odds_trend.status, 'unknown');
  // WEAK-02: a lineup set is not a move (r44's Sleeper "move" is a claim or a trade): team 2 never moved.
  const att = t2.surfaces.find(s => s.kind === 'recent_activity');
  assert.equal(att.evidence.never_moved, true);
  assert.equal(att.evidence.days_since_last_action, 19);
  assert.equal(att.evidence.last_action_type, 'ROSTER');
  assert.equal(att.confidence, 'proven');
  assert.equal(att.signal, 'activity_recency');
  // Holes and desperation stay listed as framing facts but weigh 0 in the seller ranking, citing r44.
  for (const x of [hole, desp]) {
    assert.equal(x.score, 0);
    assert.equal(x.evidence.seller_weight, 0);
    assert.match(x.evidence.measured_lift, /^r44: not a seller signal/);
    assert.match(x.use, /^framing only/);
  }
  assert.equal(t2.surfaces[0].kind, 'recent_activity', 'the only weighted surface ranks first');
  // Team 3 moved 9/19 (5 whole days before the cut): ranks above idle team 2 (the inversion).
  const t3 = scan.teams.get('3').surfaces.find(s => s.kind === 'recent_activity');
  assert.equal(t3.evidence.days_since_last_move, 5);
  assert.equal(t3.evidence.recency_weight, 0.629);
  assert.ok(scan.teams.get('3').top_score > t2.top_score);
  assert.ok(scan.order.indexOf('3') < scan.order.indexOf('2'));
  // Unread kinds are typed absent with a reason, never scored zero.
  assert.deepEqual(t2.absent.map(a => a.kind).sort(), ['in_market', 'value_gap']);
  assert.ok(t2.absent.every(a => a.status === 'unknown' && a.reason));
  // Team 3 has two QBs on different byes: no QB hole.
  assert.ok(!(scan.teams.get('3').surfaces.find(s => s.kind === 'roster_hole')?.evidence.unfillable_slots ?? []).includes('QB'));
  // Ranked, and every surface says what it may be used for (targets, timing, framing), not a message.
  for (const s of scan.teams.values()) {
    s.surfaces.forEach((x, i) => { assert.equal(x.rank, i + 1); assert.ok(x.use); assert.ok(x.as_of); });
  }
  assert.deepEqual([...scan.order].sort(), ['2', '3', '4']);
});

test('as of a past cut the scan sees only what was known then', async () => {
  const inp = await W.weaknessInputs(51, { cutMs: Date.parse('2026-09-11T12:00:00Z') });
  assert.equal(inp.currentWeek, 1, 'week 1 (games on 9/10) is not over until the next day ends');
  assert.equal(inp.rosterBasis, 'draft + transaction ledger');
  assert.equal(inp.lastAction.get('3'), undefined, 'the 9/12 add is after the cut');
  assert.equal(inp.lastAction.get('2')?.at, Date.parse('2026-09-05T00:00:00.000Z'));
  assert.equal(inp.completedWeeks.length, 0);
  const retro = await W.retroCheck({ trades: W.executedTrades(db.prepare(`SELECT * FROM league_transactions_raw WHERE league_id = 51`).all()),
    me: '1', weeks: [2], scanAt: async ms => W.scanLeague(await W.weaknessInputs(51, { cutMs: ms }), { valueReason: 'replay' }) });
  assert.equal(retro.n, 1);
  assert.equal(retro.observations[0].seller, '3');
  assert.equal(retro.baseline, 1);
});

/* ------------------------------------------------------------------ the hub */
const registry = await import('../server/services/engine/registry.js');
const weakP = await import('../server/services/engine/producers/weakness.js');
const { daemonProducers } = await import('../server/services/engine/producers/index.js');
const { buildDag } = await import('../server/services/engine/daemon/dag.js');
const { runTick } = await import('../server/services/engine/daemon/tick.js');
const weakRows = () => db.prepare(`SELECT entity_id, value, health, reason_chain FROM engine_state WHERE field = 'people.weakness' ORDER BY id`).all();
const dagOn = () => withEnv({ GRIDIRON_HUB_PEOPLE: '1', GRIDIRON_WEAKNESS: '1' },
  () => buildDag(daemonProducers()).order);

test('producer flag: off by default, on with GRIDIRON_WEAKNESS=1 or preview; DAG runs it after people.counterpart', () => {
  withEnv({ GRIDIRON_WEAKNESS: null, GRIDIRON_PREVIEW_UNCONFIRMED: null }, () => assert.deepEqual(weakP.weaknessProducers(), []));
  withEnv({ GRIDIRON_WEAKNESS: '0', GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => assert.deepEqual(weakP.weaknessProducers(), []));
  withEnv({ GRIDIRON_WEAKNESS: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => assert.equal(weakP.weaknessProducers().length, 1));
  const names = dagOn().map(p => p.name);
  assert.ok(names.indexOf('people-weakness') > names.indexOf('people-counterpart'));
});

test('daemon wiring: daemonProducers() carries people-weakness only with the flag and the people producers', () => {
  const names = env => withEnv(env, () => buildDag(daemonProducers()).order.map(p => p.name));
  const off = { GRIDIRON_WEAKNESS: null, GRIDIRON_HUB_PEOPLE: null, GRIDIRON_PREVIEW_UNCONFIRMED: null };
  assert.ok(!names(off).includes('people-weakness'), 'default off');
  assert.ok(names({ ...off, GRIDIRON_WEAKNESS: '1', GRIDIRON_HUB_PEOPLE: '1' }).includes('people-weakness'), '=1 runs it in the daemon');
  assert.ok(names({ ...off, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }).includes('people-weakness'), 'preview runs it');
  assert.ok(!names({ ...off, GRIDIRON_WEAKNESS: '0', GRIDIRON_PREVIEW_UNCONFIRMED: '1' }).includes('people-weakness'), '=0 vetoes preview');
  // WEAKNESS=1 without the people producers: left out, and the DAG still builds (no missing-input refusal).
  const noPeople = names({ ...off, GRIDIRON_WEAKNESS: '1', GRIDIRON_HUB_PEOPLE: '0' });
  assert.ok(!noPeople.includes('people-weakness') && !noPeople.includes('people-counterpart'));
});

test('one daemon tick publishes people.weakness per manager (Nick typed absent), ids and labels only', async () => {
  const t = await runTick({ database: db, dag: dagOn(), now: new Date(NOW), heartbeat: () => {} });
  assert.deepEqual(t.failed, []);
  const rows = weakRows().filter(r => r.entity_id.startsWith('51:'));
  assert.deepEqual(rows.map(r => r.entity_id).sort(), ['51:1', '51:2', '51:3', '51:4']);
  const self = rows.find(r => r.entity_id === '51:1');
  assert.equal(self.value, null);
  assert.match(JSON.parse(self.health).absence.reason, /not a counterparty/);
  const v = JSON.parse(rows.find(r => r.entity_id === '51:2').value);
  assert.equal(v.source, 'server/services/people/weakness.js');
  assert.equal(v.scan_cut, '2026-09-24T00:00:00.000Z', 'day stamp');
  assert.ok(v.surfaces.length >= 3);
  assert.ok(v.surfaces.every(s => s.evidence && s.as_of && ['proven', 'measured', 'unproven'].includes(s.confidence)));
  // No chat read in this fixture: in_market is typed absent (the counterpart row says unknown), never zero.
  assert.match(v.absent.find(a => a.kind === 'in_market').reason, /people\.counterpart is unknown/);
  // The row cites the counterpart row it read.
  const cp = db.prepare(`SELECT id FROM engine_state WHERE field = 'people.counterpart' AND entity_id = '51:2'`).get();
  assert.deepEqual(JSON.parse(rows.find(r => r.entity_id === '51:2').reason_chain).contributions[0].state_ids, [Number(cp.id)]);
  // Ids and labels only: no player or manager names on the hub.
  assert.ok(!JSON.stringify(rows.map(r => r.value)).includes('Fixture Player'));
  // Parity: the hub row equals the producer's direct build.
  const counterparts = new Map(db.prepare(`SELECT entity_id, value FROM engine_state WHERE field = 'people.counterpart' AND league_id = 51`).all()
    .filter(r => r.value).map(r => [r.entity_id.split(':')[1], JSON.parse(r.value)]));
  const direct = await weakP.directWeakness(51, { asOf: NOW, counterparts, counterpartAsOf: NOW });
  assert.deepEqual(v, JSON.parse(JSON.stringify(direct.scan.teams.get('2'))));
});

test('an unchanged league later the same day writes nothing (write-on-change)', async () => {
  const before = weakRows().length;
  const t = await runTick({ database: db, dag: dagOn(), now: new Date('2026-09-24T12:30:00.000Z'), heartbeat: () => {} });
  assert.deepEqual(t.failed, []);
  assert.equal(weakRows().length, before);
});

test('ratchet: people.weakness has exactly one producer, declared in producers/weakness.js', () => {
  assert.equal(registry.fieldSpec('people.weakness').producer, 'people-weakness');
  assert.throws(() => registry.registerField('people.weakness', { producer: 'someone-else', version: '1' }), /one producer/);
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === 'node_modules' ? [] : walk(path.join(dir, d.name))) : /\.(m?js)$/.test(d.name) ? [path.join(dir, d.name)] : []);
  const declares = [...walk('server'), ...walk('scripts')].filter(f => {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    return /registerProducer\(\s*\{[\s\S]*?PEOPLE_WEAKNESS_FIELD|registerField\(\s*(['"]people\.weakness['"]|PEOPLE_WEAKNESS_FIELD)|field:\s*['"]people\.weakness['"]/.test(src);
  });
  assert.deepEqual(declares, ['server/services/engine/producers/weakness.js']);
  const stored = db.prepare(`SELECT producer FROM engine_fields WHERE field = 'people.weakness'`).all();
  assert.deepEqual(stored.map(r => r.producer), ['people-weakness']);
});
