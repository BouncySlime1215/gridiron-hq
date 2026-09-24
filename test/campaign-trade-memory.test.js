/**
 * TRADE-MEMORY (ONE-PLAN 4c): the planner remembers this season's executed trades.
 *  (a) a player Nick gave away in the last 4 weeks is not a target, unless his market value fell
 *      10%+ since; then the card says "buy-back: price fell from X to Y";
 *  (b) a counterparty's price for a player he acquired this season has a floor at what he paid, and
 *      his currency is read from what he gave up (shadow: reported, moves nothing unless the flag is on);
 *  (c) no offer undoes a trade Nick and that counterparty made this season.
 * Made-up leagues only (test/fixtures/campaign-league.mjs and hand-written ledgers); no DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const tm = await import('../server/services/campaign/trade-memory.js');
const { executedTrades, tradeMemory, stepMemory, applyTradeMemory, TRADE_MEMORY_WINDOW_DAYS, BUYBACK_FALL, FLOOR_FLAG } = tm;
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry, plansFile } = await import('../server/services/campaign/view.js');
const { validateLeague, validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

const DAY = 864e5;
const NOW = Date.parse('2026-09-24T12:00:00Z');
const ago = d => NOW - d * DAY;

/* ------------------------------------------------------------ the ledger */

test('executedTrades: executed TRADE_ACCEPT rows only, ESPN ids mapped, unmapped counted', () => {
  const items = JSON.stringify([
    { playerId: 9001, fromTeamId: 1, toTeamId: 7, type: 'TRADE' },
    { playerId: 9002, fromTeamId: 7, toTeamId: 1, type: 'TRADE' },
    { playerId: 9999, fromTeamId: 7, toTeamId: 1, type: 'TRADE' },
  ]);
  const rows = [
    { tx_id: 'a', type: 'TRADE_ACCEPT', execution_type: 'PROCESS', status: 'EXECUTED', items_json: items, processed_at: '2026-09-17T10:00:00Z' },
    // the same trade seen twice by the collector counts once
    { tx_id: 'a', type: 'TRADE_ACCEPT', execution_type: 'PROCESS', status: 'EXECUTED', items_json: items, processed_at: '2026-09-17T10:00:00Z' },
    { tx_id: 'b', type: 'TRADE_PROPOSAL', execution_type: 'EXECUTE', status: 'PENDING', items_json: items, proposed_at: '2026-09-18T10:00:00Z' },
    { tx_id: 'c', type: 'TRADE_ACCEPT', execution_type: 'CANCEL', status: 'CANCELED', items_json: items, processed_at: '2026-09-18T10:00:00Z' },
  ];
  const idOfEspn = e => ({ 9001: 101, 9002: 102 })[e] ?? null;
  const out = executedTrades(rows, { idOfEspn });
  assert.equal(out.trades.length, 1);
  assert.equal(out.trades[0].tx_id, 'a');
  assert.equal(out.trades[0].at, Date.parse('2026-09-17T10:00:00Z'));
  assert.deepEqual(out.trades[0].moves, [{ player: 101, from: '1', to: '7' }, { player: 102, from: '7', to: '1' }]);
  assert.equal(out.unmapped, 1, 'an ESPN id with no player in the universe is counted, never guessed');
  assert.throws(() => executedTrades([{ ...rows[0], items_json: '{bad' }], { idOfEspn }), /tx a: items_json is not JSON/);
});

/* ----------------------------------------------- a made-up Olave week */

// Nick (1) sold O (WR, 5,796 then) 1-for-1 to roster 7 for C (RB, 5,705 then) seven days ago.
// Roster 7 still holds O. Nick also sold X (WR) to roster 3 forty days ago (outside the window).
const P = new Map([
  [1, { position: 'WR', value: 5796 }],   // O, now on roster 7
  [2, { position: 'RB', value: 5705 }],   // C, now on Nick
  [3, { position: 'RB', value: 3583 }],   // an RB of Nick's
  [4, { position: 'RB', value: 1920 }],   // another RB of Nick's
  [5, { position: 'WR', value: 4000 }],   // a WR of Nick's
  [6, { position: 'WR', value: 3000 }],   // X, sold 40 days ago
  [7, { position: 'TE', value: 1000 }],   // roster 3's, went to Nick for X
]);
const ledger = (then = {}) => ({
  now: NOW,
  trades: [
    { tx_id: 't1', at: ago(7), moves: [{ player: 1, from: '1', to: '7' }, { player: 2, from: '7', to: '1' }] },
    { tx_id: 't0', at: ago(40), moves: [{ player: 6, from: '1', to: '3' }, { player: 7, from: '3', to: '1' }] },
  ],
  valueAt: (id, at) => (id in then ? then[id] : P.get(id)?.value ?? null),
});
const memOf = (then) => tradeMemory(ledger(then), { me: '1', valueNow: id => P.get(id)?.value ?? 0, positionOf: id => P.get(id)?.position ?? null });

test('(a) a player Nick sold inside the window is excluded; outside it he is not', () => {
  assert.equal(TRADE_MEMORY_WINDOW_DAYS, 28);
  const mem = memOf();
  assert.equal(mem.excluded(1), 'sold_recently');
  assert.equal(mem.buyBack(1), null);
  assert.equal(mem.excluded(6), null, 'sold 40 days ago: outside the 4-week window');
  assert.equal(mem.excluded(5), null, 'never sold');
});

test('(a) a buy-back is allowed once his price fell 10%+, and the card says so', () => {
  assert.equal(BUYBACK_FALL, 0.10);
  // O was 6,500 when Nick sold him; 5,796 now is a 10.8% fall.
  const mem = memOf({ 1: 6500 });
  assert.equal(mem.excluded(1), null);
  assert.deepEqual(mem.buyBack(1), { player: 1, was: 6500, now: 5796, text: 'buy-back: price fell from 6,500 to 5,796' });
  // A 9% fall is not enough.
  assert.equal(memOf({ 1: 6369 }).excluded(1), 'sold_recently');
  // No price on the day he sold: no fall can be shown, so he stays excluded.
  assert.equal(memOf({ 1: null }).excluded(1), 'sold_recently');
});

test('(b) the counterparty price floor is what he paid, and his currency is what he gave up', () => {
  const mem = memOf();
  assert.deepEqual(mem.floorOf('7', 1), { floor: 5705, at: ago(7), paid_with: [2], basis: 'value_at_trade' });
  assert.equal(mem.floorOf('7', 2), null, 'roster 7 no longer holds C');
  assert.deepEqual(mem.currencyOf('7'), { wants: ['WR'], sells: ['RB'] });
  // In a 2-for-1 he bought, the floor splits what he paid by what each player was worth then.
  const two = tradeMemory({ now: NOW, valueAt: (id) => ({ 1: 3000, 5: 1000, 3: 6000 })[id] ?? null,
    trades: [{ tx_id: 'x', at: ago(3), moves: [{ player: 1, from: '1', to: '7' }, { player: 5, from: '1', to: '7' }, { player: 3, from: '7', to: '1' }] }] },
  { me: '1', valueNow: id => P.get(id)?.value ?? 0, positionOf: id => P.get(id)?.position ?? null });
  assert.equal(two.floorOf('7', 1).floor, 4500);
  assert.equal(two.floorOf('7', 5).floor, 1500);
});

test('stepMemory: Olave for two RBs is flagged three ways; a fair WR offer after a price fall is not', () => {
  const mem = memOf();
  const olave = { team: '7', give: [3, 4], get: [1] };
  const r = stepMemory(mem, olave);
  assert.deepEqual(r.hard, ['sold_recently']);
  assert.deepEqual(r.shadow, ['below_his_floor', 'wrong_currency'], '5,503 of RBs is under the 5,705 he paid, and he sold RBs to get a WR');
  const fell = memOf({ 1: 6500 });
  assert.deepEqual(stepMemory(fell, olave).hard, [], 'a buy-back after a 10%+ fall is allowed');
  assert.deepEqual(stepMemory(fell, { team: '7', give: [5, 4], get: [1] }).shadow, [], '5,920 incl. a WR clears his floor and his currency');
});

test('(c) an offer that undoes a trade Nick and that counterparty made this season is a reversal', () => {
  const mem = memOf();
  // Give C back to roster 7 and get O back: the 9/17 trade undone.
  assert.ok(stepMemory(mem, { team: '7', give: [2], get: [1] }).hard.includes('reversal'));
  // Even 40 days on, with roster 3: TE 7 back for X.
  assert.deepEqual(stepMemory(mem, { team: '3', give: [7], get: [6] }).hard, ['reversal']);
  // Returning only one side is not an undo.
  assert.deepEqual(stepMemory(mem, { team: '3', give: [7], get: [99] }).hard, []);
});

test('applyTradeMemory: hard reasons always drop; shadow reasons drop only with the flag', () => {
  const mem = memOf();
  const plan = steps => ({ steps, target: steps.at(-1).get[0] });
  const plans = [plan([{ team: '7', give: [3, 4], get: [1] }]), plan([{ team: '7', give: [5], get: [99] }]), plan([{ team: '3', give: [7], get: [6] }])];
  // roster 7 bought 99 for 5,705 too, so a 4,000 WR is under his floor (shadow only).
  mem.floors.set('7:99', { floor: 5705, at: ago(1), paid_with: [2], basis: 'value_at_trade' });
  const off = applyTradeMemory(plans, mem, {});
  assert.equal(off.plans.length, 1);
  assert.deepEqual(off.dropped, { sold_recently: 1, reversal: 1, below_his_floor: 0, wrong_currency: 0 });
  assert.deepEqual(off.shadow, { below_his_floor: 2, wrong_currency: 1 });
  assert.equal(off.floor_on, false);
  const on = applyTradeMemory(plans, mem, { env: { [FLOOR_FLAG]: '1' } });
  assert.equal(on.plans.length, 0);
  assert.equal(on.dropped.below_his_floor, 1);
  assert.equal(on.floor_on, true);
});

/* ------------------------------------------------- through the planner */

// The fixture's best target is P11 (team 2's star WR). Say Nick sold him to team 2 ten days ago for P6,
// and swapped P22 (to team 3) for P4 on the same day.
const fixtureLedger = ({ then11 = 4200 } = {}) => ({
  now: NOW,
  trades: [
    { tx_id: 'f1', at: ago(10), moves: [{ player: 11, from: '1', to: '2' }, { player: 6, from: '2', to: '1' }] },
    { tx_id: 'f2', at: ago(10), moves: [{ player: 22, from: '1', to: '3' }, { player: 4, from: '3', to: '1' }] },
  ],
  valueAt: id => (id === 11 ? then11 : null),
});
const plan = (mode, extra = {}) => {
  const a = makeAdapter();
  Object.assign(a, extra);
  return { a, res: planLeague(a, { objective: normaliseObjective({ risk_mode: mode }), env: extra.env ?? {} }) };
};
const gets = res => res.deck.flatMap(c => c.plan.steps.flatMap(s => s.get.map(Number)));

test('planner: without a ledger nothing changes and memory says so', () => {
  const { res } = plan('balanced');
  assert.ok(res.targets.map(Number).includes(11), 'the fixture targets P11 without memory');
  assert.equal(res.trade_memory.status, 'no_ledger');
  assert.equal(res.trade_memory.dropped_total, 0);
});

test('planner: a player Nick sold 10 days ago is no longer a target, a get or a flip buy', () => {
  for (const mode of ['balanced', 'all_in']) {
    const { res } = plan(mode, { tradeLedger: fixtureLedger() });
    assert.equal(res.trade_memory.status, 'on');
    assert.ok(!res.targets.map(Number).includes(11), `${mode}: P11 is not a target`);
    assert.ok(!gets(res).includes(11), `${mode}: no card gets P11`);
    assert.ok(!res.flip.realised.some(f => Number(f.player) === 11), `${mode}: no flip buys P11`);
    assert.ok(res.trade_memory.dropped.targets >= 1);
    assert.ok(res.trade_memory.dropped_total >= 1);
    // (c): P4 back to team 3 for P22 is the f2 trade undone.
    for (const c of res.deck) for (const s of c.plan.steps) {
      assert.ok(!(String(s.team) === '3' && s.give.map(Number).includes(4) && s.get.map(Number).includes(22)), `${mode}: reversal served`);
    }
  }
});

test('planner: after a 10%+ fall P11 is a buy-back, labelled on the card', () => {
  const { a, res } = plan('all_in', { tradeLedger: fixtureLedger({ then11: 5000 }) });
  assert.ok(res.targets.map(Number).includes(11));
  const card = res.deck.find(c => c.plan.steps.some(s => s.get.map(Number).includes(11)));
  assert.ok(card, 'a card buys P11 back');
  assert.deepEqual(card.plan.buy_back, [{ player: 11, was: 5000, now: 4200, text: 'buy-back: price fell from 5,000 to 4,200' }]);
  const entry = toEntry(res, { names: a.names(), as_of: '2026-09-24T00:00:00Z' });
  const move = [entry.next_move, ...(entry.alternatives.value ?? [])].map(m => m.value ?? m).find(m => m?.buy_back);
  assert.equal(move.buy_back[0].text, 'buy-back: price fell from 5,000 to 4,200');
  assert.deepEqual(validateLeague(entry).errors, []);
});

test('view: _run.dropped_by_reason.trade_memory prints the count, and the file validates', () => {
  const { a, res } = plan('balanced', { tradeLedger: fixtureLedger() });
  const entry = toEntry(res, { names: a.names(), as_of: '2026-09-24T00:00:00Z' });
  assert.equal(entry._run.dropped_by_reason.trade_memory, res.trade_memory.dropped_total);
  assert.ok(entry._run.dropped_by_reason.trade_memory >= 1);
  assert.equal(entry._run.trade_memory.status, 'on');
  assert.deepEqual(validateLeague(entry).errors, []);
  const doc = plansFile([entry], { generated_at: '2026-09-24T00:00:00Z' });
  assert.equal(validatePlans(doc).ok, true, JSON.stringify(validatePlans(doc).errors));
});

test('planner: the floor is shadow by default and a filter with the flag', () => {
  // Team 2 bought P12 (QB) from team 4 for P32 two days ago, paying 3,000 then.
  const ledger = { now: NOW, valueAt: id => (id === 32 ? 3000 : id === 12 ? 2400 : null),
    trades: [{ tx_id: 'g', at: ago(2), moves: [{ player: 12, from: '4', to: '2' }, { player: 32, from: '2', to: '4' }] }] };
  const value = (a, ids) => ids.reduce((s, id) => s + (a.players.get(id)?.value ?? 0), 0);
  const off = plan('balanced', { tradeLedger: ledger });
  assert.ok(off.res.trade_memory.shadow.below_his_floor >= 1, 'the fixture has a P12 buy under 3,000');
  assert.ok(off.res.deck.some(c => c.plan.steps.some(s => s.get.map(Number).includes(12) && value(off.a, s.give) < 3000)), 'shadow: still served');
  const on = plan('balanced', { tradeLedger: ledger, env: { [FLOOR_FLAG]: '1' } });
  assert.ok(!on.res.deck.some(c => c.plan.steps.some(s => String(s.team) === '2' && s.get.map(Number).includes(12) && value(on.a, s.give) < 3000)));
  assert.ok(on.res.trade_memory.dropped.below_his_floor >= 1);
});
