/**
 * TRADE-MEMORY (ONE-PLAN 4c): the planner remembers this season's executed trades.
 *
 *  (a) a player Nick gave away in the last TRADE_MEMORY_WINDOW_DAYS is never a target, a get or a flip
 *      buy, unless his market value fell BUYBACK_FALL or more since the trade; then he is a buy-back and
 *      the card says "buy-back: price fell from X to Y". No price on the trade day: no fall can be shown,
 *      so he stays excluded.
 *  (b) a counterparty's floor for a player he bought this season is what he paid: the market value, on
 *      the trade day, of what he gave, split across what he got by what each was worth then. His currency
 *      is the positions he gave up (sells) and took in (wants), net over his season's trades.
 *      Both are an unfitted model of the other manager, so they are SHADOW: counted, never applied,
 *      unless FLOOR_FLAG is '1'.
 *  (c) a step undoes a trade when it takes back from a counterparty a player Nick sent him and gives
 *      him back a player he sent Nick, in one trade this season between the two. Never served.
 *
 * Pure: the ledger (trades, the clock, the price-on-a-day reader) comes in from the adapter
 * (scripts/campaign/league-adapter.mjs#tradeLedger; tests hand one in). No DB, env or clock here.
 */
export const TRADE_MEMORY_WINDOW_DAYS = 28;
export const BUYBACK_FALL = 0.10;
export const FLOOR_FLAG = 'GRIDIRON_TRADE_MEMORY_FLOOR';
const DAY = 864e5;
const HARD = ['sold_recently', 'reversal'];
const SHADOW = ['below_his_floor', 'wrong_currency'];

const toMsDefault = v => { const t = Date.parse(v ?? ''); return Number.isFinite(t) ? t : null; };
const fmt = n => Math.round(n).toLocaleString('en-US');

/**
 * league_transactions_raw rows -> executed trades. An executed trade is the TRADE_ACCEPT / PROCESS /
 * EXECUTED row (the one carrying the items; people/counterpart.js#tradeEvents reads the same rows).
 * idOfEspn(espnId) -> planner player id or null; an unmapped player is counted, never guessed.
 */
export function executedTrades(rows, { idOfEspn, toMs = toMsDefault }) {
  const trades = [];
  const seen = new Set();
  let unmapped = 0;
  for (const r of rows ?? []) {
    if (!(r.type === 'TRADE_ACCEPT' && r.execution_type === 'PROCESS' && r.status === 'EXECUTED')) continue;
    if (seen.has(r.tx_id)) continue;
    seen.add(r.tx_id);
    let items;
    try { items = JSON.parse(r.items_json || '[]'); } catch (e) { throw new Error(`tx ${r.tx_id}: items_json is not JSON (${e.message})`); }
    const at = toMs(r.processed_at) ?? toMs(r.proposed_at);
    if (at == null) continue;
    const moves = [];
    for (const i of Array.isArray(items) ? items : []) {
      if (i?.playerId == null || !(Number(i.fromTeamId) > 0) || !(Number(i.toTeamId) > 0)) continue;
      const player = idOfEspn(i.playerId);
      if (player == null) { unmapped++; continue; }
      moves.push({ player, from: String(i.fromTeamId), to: String(i.toTeamId) });
    }
    if (moves.length) trades.push({ tx_id: r.tx_id, at, moves });
  }
  return { trades: trades.sort((a, b) => a.at - b.at), unmapped };
}

/**
 * ledger: { now, trades: [{ tx_id, at, moves: [{ player, from, to }] }], valueAt(id, atMs) -> number|null }.
 * opts: { me, valueNow(id) -> number, positionOf(id) -> string|null, holderOf(id) -> team|null (optional) }.
 */
export function tradeMemory(ledger, { me, valueNow, positionOf, holderOf = null, windowDays = TRADE_MEMORY_WINDOW_DAYS, fall = BUYBACK_FALL }) {
  const now = ledger.now;
  const trades = ledger.trades ?? [];
  const then = (id, at) => { const v = ledger.valueAt?.(id, at); return Number.isFinite(v) ? v : null; };
  const sold = new Map();
  const floors = new Map();
  const net = new Map();          // team -> Map position -> net count taken in
  const nickTrades = new Map();   // team -> [{ nickGave: Set, nickGot: Set }]
  // Who holds each player now: the last move in the ledger, unless the adapter knows better.
  const lastTo = new Map();
  for (const t of trades) for (const m of t.moves) lastTo.set(String(m.player), m.to);
  const holder = id => (holderOf ? holderOf(id) : null) ?? lastTo.get(String(id)) ?? null;

  for (const t of trades) {
    const teams = new Set(t.moves.flatMap(m => [m.from, m.to]));
    for (const team of teams) {
      const got = t.moves.filter(m => m.to === team).map(m => m.player);
      const gave = t.moves.filter(m => m.from === team).map(m => m.player);
      const pos = net.get(team) ?? new Map();
      for (const id of got) { const p = positionOf(id); if (p) pos.set(p, (pos.get(p) ?? 0) + 1); }
      for (const id of gave) { const p = positionOf(id); if (p) pos.set(p, (pos.get(p) ?? 0) - 1); }
      net.set(team, pos);
      if (team === String(me)) continue;
      // (b) his floor on each player he got: what he paid, split by what each was worth then.
      const thenOr = id => then(id, t.at);
      const exact = gave.every(id => thenOr(id) != null);
      const paid = gave.reduce((s, id) => s + (thenOr(id) ?? valueNow(id) ?? 0), 0);
      const gotThen = got.map(id => thenOr(id) ?? valueNow(id) ?? 0);
      const gotSum = gotThen.reduce((s, x) => s + x, 0);
      got.forEach((id, k) => {
        if (String(holder(id)) !== team) return;
        const share = gotSum > 0 ? gotThen[k] / gotSum : 1 / got.length;
        floors.set(`${team}:${id}`, { floor: Math.round(paid * share), at: t.at, paid_with: gave, basis: exact ? 'value_at_trade' : 'value_now' });
      });
    }
    // Nick's own trades: what he sold (a) and what a step would have to send back to undo it (c).
    for (const team of teams) {
      if (team === String(me)) continue;
      const nickGave = t.moves.filter(m => m.from === String(me) && m.to === team).map(m => String(m.player));
      const nickGot = t.moves.filter(m => m.from === team && m.to === String(me)).map(m => String(m.player));
      if (nickGave.length && nickGot.length) {
        const list = nickTrades.get(team) ?? [];
        list.push({ tx_id: t.tx_id, nickGave: new Set(nickGave), nickGot: new Set(nickGot) });
        nickTrades.set(team, list);
      }
    }
    for (const m of t.moves) {
      if (m.from !== String(me) || now - t.at > windowDays * DAY) continue;
      const was = then(m.player, t.at);
      const cur = valueNow(m.player);
      // No price now (missing or 0) is unknown, not a 100% fall: he stays excluded.
      const fell = was != null && was > 0 && Number.isFinite(cur) && cur > 0 ? (was - cur) / was : null;
      const buyback = fell != null && fell >= fall - 1e-12;
      sold.set(String(m.player), { player: m.player, at: t.at, to: m.to, was, now: cur, fell, buyback,
        text: buyback ? `buy-back: price fell from ${fmt(was)} to ${fmt(cur)}` : null });
    }
  }

  const currency = new Map();
  for (const [team, pos] of net) {
    const wants = [...pos].filter(([, n]) => n > 0).map(([p]) => p).sort();
    const sells = [...pos].filter(([, n]) => n < 0).map(([p]) => p).sort();
    currency.set(team, { wants, sells });
  }

  return {
    me: String(me), now, windowDays, fall, trades: trades.length, sold, floors, currency, nickTrades, valueNow, positionOf,
    excluded(id) { const s = sold.get(String(id)); return s && !s.buyback ? 'sold_recently' : null; },
    buyBack(id) { const s = sold.get(String(id)); return s?.buyback ? { player: s.player, was: s.was, now: s.now, text: s.text } : null; },
    floorOf(team, id) { return floors.get(`${team}:${id}`) ?? null; },
    currencyOf(team) { return currency.get(String(team)) ?? { wants: [], sells: [] }; },
  };
}

/** One step's memory verdict: hard reasons (always drop) and shadow reasons (drop only with FLOOR_FLAG). */
export function stepMemory(mem, step) {
  const team = String(step.team);
  const give = step.give.map(String), get = step.get.map(String);
  const hard = [], shadow = [];
  if (get.some(id => mem.excluded(id))) hard.push('sold_recently');
  if ((mem.nickTrades.get(team) ?? []).some(t => get.some(id => t.nickGave.has(id)) && give.some(id => t.nickGot.has(id)))) hard.push('reversal');
  const v = id => Math.max(0, Number(mem.valueNow(id)) || 0);
  const floors = step.get.map(id => mem.floorOf(team, id));
  if (floors.some(Boolean)) {
    const required = step.get.reduce((s, id, k) => s + (floors[k] ? floors[k].floor : v(id)), 0);
    const offered = step.give.reduce((s, id) => s + v(id), 0);
    if (offered < required) shadow.push('below_his_floor');
  }
  const cur = mem.currencyOf(team);
  if (cur.sells.length) {
    const pos = step.give.map(id => mem.positionOf(id)).filter(Boolean);
    if (pos.length && pos.every(p => cur.sells.includes(p)) && !pos.some(p => cur.wants.includes(p))) shadow.push('wrong_currency');
  }
  return { hard, shadow };
}

export const floorOn = env => (env ?? {})[FLOOR_FLAG] === '1';

/** plans: the planner's candidates. Each plan is dropped under its first reason; shadow reasons are counted on every plan. */
export function applyTradeMemory(plans, mem, { env = {} } = {}) {
  const on = floorOn(env);
  const dropped = Object.fromEntries([...HARD, ...SHADOW].map(k => [k, 0]));
  const shadow = Object.fromEntries(SHADOW.map(k => [k, 0]));
  const kept = [];
  for (const p of plans) {
    const verdicts = p.steps.map(s => stepMemory(mem, s));
    const hard = HARD.find(k => verdicts.some(v => v.hard.includes(k)));
    const soft = SHADOW.filter(k => verdicts.some(v => v.shadow.includes(k)));
    for (const k of soft) shadow[k]++;
    const why = hard ?? (on ? soft[0] : undefined);
    if (why) { dropped[why]++; continue; }
    const bb = [...new Set(p.steps.flatMap(s => s.get.map(String)))].map(id => mem.buyBack(id)).filter(Boolean);
    kept.push(bb.length ? { ...p, buy_back: bb } : p);
  }
  return { plans: kept, dropped, shadow, floor_on: on };
}

/** A step passes memory: no hard reason, and no shadow reason when the floor flag is on. */
export function stepPasses(mem, step, on) {
  const v = stepMemory(mem, step);
  return !v.hard.length && !(on && v.shadow.length);
}

/**
 * The summary the planner returns (and the view puts under `_run.trade_memory`). Ids only, no names.
 * dropped_total counts candidate PATHS only (one unit); targets, flips and ladder rows are removed
 * before or after path search and are reported beside it, never summed into it.
 */
export function memorySummary(mem, { dropped, shadow, floorOn: on, targets = 0, flips = 0, ladderRows = 0, refused = [], unmapped = 0 }) {
  if (!mem) return { status: 'no_ledger', dropped_total: 0 };
  const d = { ...dropped };
  return {
    status: 'on', window_days: mem.windowDays, buyback_fall: mem.fall, trades: mem.trades, unmapped,
    floor: on ? 'filter' : 'shadow',
    sold_recently: [...mem.sold.values()].filter(s => !s.buyback).map(s => String(s.player)),
    buy_backs: [...mem.sold.values()].filter(s => s.buyback).map(s => ({ player: String(s.player), was: s.was, now: s.now, text: s.text })),
    floors: [...mem.floors].map(([k, f]) => ({ key: k, floor: f.floor, basis: f.basis })),
    currency: Object.fromEntries(mem.currency),
    dropped: d, shadow, removed: { targets, flips, ladder_rows: ladderRows }, refused_targets: refused.map(String),
    dropped_total: Object.values(d).reduce((s, x) => s + x, 0),
  };
}
