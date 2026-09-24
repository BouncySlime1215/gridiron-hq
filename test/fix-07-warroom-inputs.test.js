/**
 * FIX-07: War Room inputs reach the producer; one "I sent it" store.
 *
 * Gates (docs/tdd/2026-09-24-fix-07-warroom-inputs.tdd.md):
 *  G1 a mode.set request changes the next run's destination.risk_mode and is
 *     stamped consumed_at in the same transaction as the plans write; the mode
 *     still holds on the run after (objective state = fold of all requests).
 *  G2 a failed plans write stamps nothing.
 *  G3 a retracted request is ignored; an unconfirmed Coach plan change is ignored.
 *  G4 a deck skip stores its card and down-weights that manager / those players.
 *  G5 a War Room "I sent it" writes exactly one trade_outcomes row with sent_at,
 *     the card's p_yes_band as the band, move_id and price_band; a second tap
 *     returns already_sent and writes nothing. Opening -> 'below'.
 *  G6 no band on the card -> no trade_outcomes row, and the response says why.
 *  G7 retracting "I sent it" takes the sent mark back off.
 *  G8 the fatigue cap counts trade_outcomes sent rows (War Room and TradeCard
 *     alike), once each, next to ESPN's own proposals.
 *  G9 consuming an "I sent it" writes E5's campaign_steps predicted row.
 *  G10 the shown next move is logged to follow_ledger once (kind next_move), and
 *     the war_room serve-log surface reads p_yes / title_odds_delta /
 *     title_after / title_now.
 *
 * Every league, team, player and id below is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-fix07-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { recordRequest } = await import('../server/services/warroom-actions/store.js');
const { leagueInputs, consumeWith } = await import('../server/services/campaign/requests.js');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { sentThisWeek } = await import('../scripts/campaign/league-adapter.mjs');
const { recordSentOffer } = await import('../server/services/trade-outcomes.js');
const { logWarRoomShown } = await import('../server/services/war-room-log.js');
const { servedNumbers } = await import('../server/services/serve-log.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026;
const USER = 1;
const PLANS_DOC = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'producer-plans.json'), 'utf8'));
const FIXTURE_LEAGUE = PLANS_DOC.leagues[0].league; // 1

function league(id) {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id, current_week)
       VALUES (?, 'espn', ?, ?, ?, ?, 4, '3', 4)`, id, `espn-fix07-${id}`, SEASON, `L${id}`, JSON.stringify({ teams: [] }));
  return row('SELECT * FROM leagues WHERE id = ?', id);
}
for (const id of [FIXTURE_LEAGUE, 11, 12, 13, 14, 15, 16]) league(id);
for (const id of [601, 604, 502, 503, 605]) {
  run('INSERT INTO players (id, name, position, espn_id) VALUES (?, ?, ?, ?)', id, `Made Up ${id}`, 'WR', id + 40000);
}

/** The contract fixture, with a p_yes_band on each first step unless `band` is false. */
function plans({ band = true } = {}) {
  const doc = structuredClone(PLANS_DOC);
  if (band) {
    for (const e of doc.leagues) {
      for (const m of [e.next_move?.value, ...(e.alternatives?.value ?? [])]) {
        const st = m?.steps?.[0];
        if (st) st.p_yes_band = { low: Math.min(0.25, st.p_yes.value), high: Math.max(0.5, st.p_yes.value), basis: 'heuristic_unanchored' };
      }
    }
  }
  return { status: 'ok', entries: doc.leagues, as_of: doc.generated_at, id: 'plans@fixture' };
}

const ask = (leagueId, kind, payload, extra = {}) => recordRequest({ userId: USER, leagueId, kind, payload, ...extra });
/** destination.risk_mode as the producer writes it today (view.*) or as the contract does. */
const riskModeOf = entry => {
  const d = entry.destination?.value ?? entry.view?.destination?.value;
  return typeof d?.risk_mode === 'string' ? d.risk_mode : d?.risk_mode?.value?.mode;
};
const planWith = inputs => toEntry(planLeague(makeAdapter(), { objective: inputs.objective, skips: inputs.weights }),
  { as_of: '2026-10-01T00:00:00.000Z' });

/* ------------------------------------------------------------ G1 / G2 */

test('G1: a mode.set request changes the next run\'s destination.risk_mode and is stamped consumed', () => {
  const before = leagueInputs(11);
  assert.equal(before.objective.risk_mode, 'balanced');
  assert.equal(riskModeOf(planWith(before)), 'balanced');

  const req = ask(11, 'mode.set', { mode: 'all_in' });
  const inputs = leagueInputs(11);
  assert.equal(inputs.objective.risk_mode, 'all_in');
  assert.equal(inputs.objective.source, 'warroom_requests');
  assert.deepEqual(inputs.consume.pending, [req.id]);
  assert.equal(riskModeOf(planWith(inputs)), 'all_in');

  let wrote = false;
  const n = consumeWith([inputs.consume], () => { wrote = true; }, { at: '2026-10-01T00:00:00.000Z' });
  assert.equal(wrote, true);
  assert.equal(n.consumed, 1);
  assert.equal(row('SELECT consumed_at FROM warroom_requests WHERE id = ?', req.id).consumed_at, '2026-10-01T00:00:00.000Z');

  const after = leagueInputs(11);
  assert.deepEqual(after.consume.pending, [], 'nothing left pending');
  assert.equal(after.objective.risk_mode, 'all_in', 'the mode holds: objective state is the fold of every request');
});

test('G2: a plans write that throws stamps nothing', () => {
  const req = ask(12, 'mode.set', { mode: 'safe' });
  const inputs = leagueInputs(12);
  assert.throws(() => consumeWith([inputs.consume], () => { throw new Error('disk full'); }), /disk full/);
  assert.equal(row('SELECT consumed_at FROM warroom_requests WHERE id = ?', req.id).consumed_at, null);
  assert.equal(db.isTransaction, false);
});

/* ------------------------------------------------------------ G3 */

test('G3: a retracted request is ignored; the one before it stands', () => {
  ask(13, 'mode.set', { mode: 'safe' });
  const later = ask(13, 'mode.set', { mode: 'all_in' });
  ask(13, 'retract', { request_id: later.id });
  const inputs = leagueInputs(13);
  assert.equal(inputs.objective.risk_mode, 'safe');
  assert.ok(inputs.summary.ignored.some(i => i.id === later.id && i.why === 'retracted'));
  assert.equal(riskModeOf(planWith(inputs)), 'safe');
});

test('G3b: a Coach plan change without confirmed = 1 is not followed, even if written around the route', () => {
  run(`INSERT INTO warroom_requests (user_id, league_id, kind, payload, source, confirmed)
       VALUES (?, 14, 'mode.set', '{"mode":"all_in"}', 'coach', 0)`, USER);
  const inputs = leagueInputs(14);
  assert.equal(inputs.objective.risk_mode, 'balanced');
  assert.match(inputs.summary.ignored[0].why, /not confirmed/);
});

test('G3c: objective.set, tolerance.set and stop add/remove fold in order', () => {
  ask(14, 'objective.set', { goal: 'playoffs' });
  ask(14, 'tolerance.set', { key: 'max_offers_per_manager_week', value: 1 });
  const add = ask(14, 'stop.add', { stop: { kind: 'cover_bye', label: 'Cover the TE bye', week: 9 } });
  ask(14, 'stop.add', { stop: { kind: 'sell', label: 'Sell the old back', player_id: '605' } });
  ask(14, 'stop.remove', { stop_id: `req-${add.id}` });
  const o = leagueInputs(14).objective;
  assert.equal(o.goal, 'playoffs');
  assert.equal(o.tolerances.max_offers_per_manager_week, 1);
  assert.deepEqual(o.stops.map(s => s.label), ['Sell the old back']);
});

/* ------------------------------------------------------------ G4 */

test('G4: a deck skip stores its card and down-weights that manager', () => {
  const p = plans();
  const skip = ask(FIXTURE_LEAGUE, 'deck.skip', { move_id: 'L1-m1', reason: 'dont_trust_manager' }, { plans: p });
  assert.equal(skip.payload.card.partner, '7');
  const inputs = leagueInputs(FIXTURE_LEAGUE);
  assert.ok(inputs.weights.manager.get('7') < 1, 'the skipped manager is down-weighted');
  const cost = ask(FIXTURE_LEAGUE, 'deck.skip', { move_id: 'L1-m1', reason: 'costs_too_much' }, { plans: p });
  assert.deepEqual(cost.payload.card.get, ['502']);
  assert.ok(leagueInputs(FIXTURE_LEAGUE).weights.player.get('502') < 1, '"costs too much" down-weights what the card gets');
});

/* ------------------------------------------------------------ G5-G7 */

const sentRows = leagueId => rows(`SELECT * FROM trade_outcomes WHERE league_id = ? AND sent_at IS NOT NULL`, leagueId);

test('G5: "I sent it" writes exactly one trade_outcomes row with sent_at and band; a second tap is already_sent', () => {
  const p = plans();
  const first = ask(FIXTURE_LEAGUE, 'offer.sent', { move_id: 'L1-m1' }, { plans: p });
  assert.equal(first.trade_outcome.state, 'recorded');
  const got = sentRows(FIXTURE_LEAGUE);
  assert.equal(got.length, 1);
  const o = got[0];
  assert.ok(o.sent_at);
  assert.equal(o.source, 'app_proposed');
  assert.equal(o.counterparty_team_id, '7');
  assert.equal(o.move_id, 'L1-m1');
  assert.equal(o.price_band, 'at_point');
  assert.equal(o.model_p_accept_low, 0.25);
  assert.equal(o.model_p_accept_high, 0.5);
  assert.equal(o.model_p_accept, 0.38, "the card's p_yes is the midpoint");
  assert.deepEqual(JSON.parse(o.give_json).map(x => x.espn_id).sort(), [40601, 40604], 'ESPN ids ride along for the settle job');

  const second = ask(FIXTURE_LEAGUE, 'offer.sent', { move_id: 'L1-m1' }, { plans: p });
  assert.equal(second.already_sent, true);
  assert.equal(second.trade_outcome.state, 'already_sent');
  assert.equal(sentRows(FIXTURE_LEAGUE).length, 1, 'still one row');
  assert.equal(row(`SELECT COUNT(*) n FROM warroom_requests WHERE league_id = ? AND kind = 'offer.sent'`, FIXTURE_LEAGUE).n, 1,
    'the second tap records no second request');
});

test('G5b: the opening sent is priced below the yes-point', () => {
  const p = plans();
  const r = ask(FIXTURE_LEAGUE, 'offer.sent', { move_id: 'L1-m1', sent_as: 'opening' }, { plans: p });
  assert.equal(r.trade_outcome.state, 'recorded');
  assert.equal(row('SELECT price_band FROM trade_outcomes WHERE id = ?', r.trade_outcome.id).price_band, 'below');
});

test('G6: a card with no p_yes_band records no trade_outcomes row and says why', () => {
  const before = rows('SELECT id FROM trade_outcomes').length;
  const doc = plans({ band: false });
  doc.entries[0].league = 15;
  const r = ask(15, 'offer.sent', { move_id: 'L1-m1' }, { plans: doc });
  assert.equal(r.trade_outcome.state, 'not_recorded');
  assert.match(r.trade_outcome.reason, /p_yes_band/);
  assert.equal(rows('SELECT id FROM trade_outcomes').length, before);
  assert.ok(r.id, 'the request itself is still recorded');
  const bad = plans();
  bad.entries[0].league = 15;
  bad.entries[0].next_move.value.steps[0].p_yes_band = { low: 0.6, high: 0.9 };
  const off = ask(15, 'offer.sent', { move_id: 'L1-m1' }, { plans: bad });
  assert.equal(off.trade_outcome.state, 'not_recorded');
  assert.match(off.trade_outcome.reason, /does not contain/);
});

test('G7: retracting "I sent it" takes the sent mark back off', () => {
  const doc = plans();
  doc.entries[0].league = 16;
  const sent = ask(16, 'offer.sent', { move_id: 'L1-m2' }, { plans: doc });
  assert.equal(sent.trade_outcome.state, 'recorded');
  const undo = ask(16, 'retract', { request_id: sent.id });
  assert.equal(undo.payload.undo.state, 'unmarked');
  assert.equal(row('SELECT sent_at FROM trade_outcomes WHERE id = ?', sent.trade_outcome.id).sent_at, null);
  assert.equal(leagueInputs(16).consume.sent.length, 0, 'a retracted send writes no campaign step');
});

/* ------------------------------------------------------------ G8 */

test('G8: the fatigue cap counts trade_outcomes sent rows once each, War Room and TradeCard alike', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
    league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
    type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
    team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
    bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (league_id, season, tx_id))`);
  const now = Date.parse('2026-10-02T12:00:00Z');
  const at = h => new Date(now - h * 3_600_000).toISOString();
  const band = { band: { low: 0.2, mid: 0.3, high: 0.4 }, basis: 'heuristic_unanchored' };
  const deal = (partner, g) => ({ partner_id: partner, i_give: [{ id: g, espn_id: g }], i_get: [{ id: g + 1, espn_id: g + 1 }], acceptance: band });
  // TradeCard tap to team 2; War Room tap to team 2; one to team 4 that ESPN also shows (matched); one 9 days old.
  recordSentOffer({ league_id: 11, season: SEASON, deal: deal('2', 1), model_version: 't', sent_at: at(2) });
  recordSentOffer({ league_id: 11, season: SEASON, deal: deal('2', 3), model_version: 't', sent_at: at(5), move_id: 'L11-m1', price_band: 'at_point' });
  const matched = recordSentOffer({ league_id: 11, season: SEASON, deal: deal('4', 5), model_version: 't', sent_at: at(6) });
  run(`UPDATE trade_outcomes SET matched_tx_id = 'tx-9' WHERE id = ?`, matched.id);
  recordSentOffer({ league_id: 11, season: SEASON, deal: deal('2', 7), model_version: 't', sent_at: at(9 * 24) });
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, execution_type, proposed_at, team_id, items_json, first_seen_at, last_seen_at)
       VALUES (11, ?, 'tx-9', 'TRADE_PROPOSAL', 'EXECUTE', ?, 3, ?, ?, ?)`, SEASON, at(6),
  JSON.stringify([{ fromTeamId: 3, toTeamId: 4, playerId: 5 }, { fromTeamId: 4, toTeamId: 3, playerId: 6 }]), at(6), at(6));
  const svc = { db: { rows }, tactics: { toTime: t => Date.parse(t) } };
  const sent = sentThisWeek(svc, 11, SEASON, '3', now);
  assert.equal(sent.get('2'), 2, 'two taps to team 2 this week, the old one out');
  assert.equal(sent.get('4'), 1, 'the tapped offer ESPN also shows counts once');
});

/* ------------------------------------------------------------ G9 */

test('G9: consuming an "I sent it" writes the campaign_steps predicted row', () => {
  const inputs = leagueInputs(FIXTURE_LEAGUE);
  assert.equal(inputs.consume.sent.length, 2, 'the card send and the opening send');
  const n = consumeWith([inputs.consume], () => {}, { at: '2026-10-01T00:00:00.000Z' });
  assert.equal(n.campaign_steps, 1, 'one step identity (league, move, step 0); the second is ignored');
  const s = row('SELECT * FROM campaign_steps WHERE league_id = ? AND move_id = ?', FIXTURE_LEAGUE, 'L1-m1');
  assert.equal(s.predicted_title_odds_gain, 0.018);
  assert.equal(s.predicted_se, 0.005);
  assert.equal(s.realized_title_odds_gain, null);
  assert.equal(consumeWith([leagueInputs(FIXTURE_LEAGUE).consume], () => {}).campaign_steps, 0, 'nothing pending twice');
});

/* ------------------------------------------------------------ G10 */

test('G10: the shown next move is logged to follow_ledger once, and the war_room surface is served', () => {
  const lg = row('SELECT * FROM leagues WHERE id = ?', FIXTURE_LEAGUE);
  const p = plans();
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  const first = logWarRoomShown(res, lg, p);
  assert.equal(first.follow_ledger.state, 'recorded');
  assert.ok(first.serve_log.request_id);
  const again = logWarRoomShown(res, lg, p);
  assert.equal(again.follow_ledger.state, 'recorded');
  const logged = rows(`SELECT * FROM follow_ledger WHERE league_id = ? AND kind = 'next_move'`, FIXTURE_LEAGUE);
  assert.equal(logged.length, 1, 'a re-render inserts nothing');
  assert.equal(JSON.parse(logged[0].pick_json).move_id, 'L1-m1');
  assert.equal(logged[0].action, 'trade');

  const nums = servedNumbers('war_room', { ...p.entries[0], plans_version: p.id });
  const pick = (entity, field) => nums.find(n => n.entity.startsWith(entity) && n.field === field)?.value;
  assert.equal(pick('deal:3|7|', 'p_yes'), 0.38);
  assert.equal(pick('deal:3|7|', 'title_odds_delta'), 0.018);
  assert.equal(pick('deal:3|7|', 'title_after'), 0.136);
  assert.equal(pick('team:3', 'title_now'), 0.118);

  const none = logWarRoomShown(res, lg, { status: 'unknown', reason: 'No plan has been run yet' });
  assert.equal(none.follow_ledger.state, 'not_logged');
  assert.match(none.serve_log.reason, /No plan/);
});
