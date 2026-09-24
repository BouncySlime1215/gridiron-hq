/**
 * SELF-01b: bias flags for Nick, read from his own record only.
 *
 * Two habits are looked for, and only these two:
 *   - IGNORES: which kinds of call he skips. Source: follow_ledger (082, SELF-01a),
 *     rows resolved to 'follow' or 'ignore'. 'no_action' and still-open rows are
 *     not events: an unchanged lineup is not a skip, and a missing capture is not
 *     anything. They are counted aside so the card can say how many there were.
 *   - OVERPAYS: what he pays too much for in trades. Source: trade_outcomes (067),
 *     observed trades he was party to that were accepted. A trade is an overpay when
 *     the players he sent scored more realised fantasy points (player_gamelog) than
 *     the players he got, over the OVERPAY_HORIZON_WEEKS after the trade's scoring
 *     period. A trade whose horizon is not over yet, or that names a player with no
 *     local row, is not scored and is counted by reason.
 *
 * Also here (FIX-284-3):
 *   - REGRET LEDGER: per settled trade or offer where the choice was his, the
 *     alternative he passed on (keeping his side when he accepted; taking the deal
 *     when he declined, countered or let one lapse), valued AS OF that week, and its
 *     realised outcome once the horizon is over. His own offers that were turned
 *     down are not his choice and are counted aside.
 *   - CONCESSION GUARD: a re-offer (his offer to a manager who already turned down
 *     an earlier one this season) concedes the rise in the net value he gives. Both
 *     offers are re-measured with the values as of the re-offer's week, so a player
 *     whose value moved in between is not mistaken for a concession. His norm is
 *     the median of his EARLIER concessions (MIN_FIT_N at least). A re-offer above
 *     the norm is guarded, and the guard reaches the card only when its category
 *     (the position he was after) passes the same walk-forward check as a flag.
 *   As-of values are weekly_prediction_snapshots.prediction for that week: what the
 *   engine projected before the week, never a later number.
 *
 * NOT BUILT, ON PURPOSE (ENGINE-SPECS SELF-01b): the endowment effect and post-loss
 * panic were already killed on his own data. KILLED_BIASES names them so nobody
 * adds them back here by accident.
 *
 * THE CHECK (pre-registered 2026-09-24, before any flag was computed on real rows).
 * Each habit splits into categories (the call kind, and kind x position; for trades,
 * the position acquired). `walkForward()` replays his weeks in order. At each week it
 * fits on EARLIER weeks only: a category is active when it has at least MIN_FIT_N
 * earlier events and its earlier hit rate is above the earlier overall rate. Every
 * event in an active category that week is a forward prediction. A category is SHOWN
 * only if it is a candidate on the full record today, has at least MIN_EVAL_N forward
 * predictions, and its forward precision is strictly above the base rate: the hit
 * rate of all events in the weeks it was active. Anything else is held back and only
 * counted. A per-position flag is dropped when its parent kind is shown with at least
 * the same precision, because it says nothing more.
 *
 * Read-only. Writes nothing and needs no migration: the regret ledger is rebuilt
 * from stored as-of snapshots and game logs on every read, so there is nothing to log.
 */
import { row, rows } from '../../db/index.js';
import { leagueCurrentWeek } from '../league-week.js';

/** Earlier events a category needs before it can be active at a week. Pre-registered, not fitted. */
export const MIN_FIT_N = 4;
/** Forward predictions a flag needs before its precision is read at all. Pre-registered, not fitted. */
export const MIN_EVAL_N = 4;
/** Weeks after a trade over which the two sides' realised points are compared. */
export const OVERPAY_HORIZON_WEEKS = 4;
/** Last fantasy week counted for a finished season. */
const LAST_WEEK = 17;
/** Killed on Nick's own data before this unit (ENGINE-SPECS SELF-01b). Never built here. */
export const KILLED_BIASES = Object.freeze(['endowment', 'post_loss_panic']);

const KIND_LABEL = Object.freeze({
  start_sit: 'start/sit', waiver: 'waiver', trade: 'trade', next_move: 'War Room next-move',
});

const tableExists = name =>
  !!row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`, name);
const round4 = v => Math.round(v * 1e4) / 1e4;
const bump = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };

/* ------------------------------------------------------------------ the check */

/**
 * Walk-forward precision per category. `events` = [{ period, hit: 0|1, cats: [..] }],
 * `period` any sortable number (season * 100 + week). Pure.
 */
export function walkForward(events, { minFit = MIN_FIT_N, minEval = MIN_EVAL_N } = {}) {
  const periods = [...new Set(events.map(e => e.period))].sort((a, b) => a - b);
  const prior = { n: 0, hits: 0 }, priorCat = new Map();
  const fwd = new Map(); // category -> { n, hits, base_n, base_hits }
  for (const p of periods) {
    const now = events.filter(e => e.period === p);
    if (prior.n) {
      const overall = prior.hits / prior.n;
      const active = new Set([...priorCat].filter(([, s]) => s.n >= minFit && s.hits / s.n > overall).map(([c]) => c));
      const hitsNow = now.reduce((a, e) => a + e.hit, 0);
      for (const c of active) {
        const f = fwd.get(c) ?? { n: 0, hits: 0, base_n: 0, base_hits: 0 };
        f.base_n += now.length; f.base_hits += hitsNow;
        for (const e of now) if (e.cats.includes(c)) { f.n++; f.hits += e.hit; }
        fwd.set(c, f);
      }
    }
    for (const e of now) {
      prior.n++; prior.hits += e.hit;
      for (const c of e.cats) {
        const s = priorCat.get(c) ?? { n: 0, hits: 0 };
        s.n++; s.hits += e.hit;
        priorCat.set(c, s);
      }
    }
  }

  const overall = prior.n ? prior.hits / prior.n : 0;
  const candidates = [];
  for (const [category, s] of priorCat) {
    if (s.n < minFit || !(s.hits / s.n > overall)) continue;
    const f = fwd.get(category) ?? { n: 0, hits: 0, base_n: 0, base_hits: 0 };
    const precision = f.n ? round4(f.hits / f.n) : null;
    const baseRate = f.base_n ? round4(f.base_hits / f.base_n) : null;
    let heldReason = null;
    if (f.n < minEval) heldReason = 'too_few_forward';
    else if (!(precision > baseRate)) heldReason = 'not_above_base';
    candidates.push({
      category,
      fit: { n: s.n, hits: s.hits, rate: round4(s.hits / s.n), overall: round4(overall) },
      forward: { n: f.n, hits: f.hits, precision, base_rate: baseRate, base_n: f.base_n },
      shown: heldReason == null, held_reason: heldReason,
    });
  }
  return { candidates, events: prior.n };
}

/* ------------------------------------------------------------- which calls he skips */

const positionOf = id => (id == null ? null : row('SELECT position FROM players WHERE id = ?', Number(id))?.position ?? null);

/** Local player ids the pick is about: the starter, the add, or the players to get. */
function pickPlayers(kind, pick) {
  if (!pick || typeof pick !== 'object') return [];
  if (kind === 'waiver') return pick.add == null ? [] : [pick.add];
  if (kind === 'trade') return Array.isArray(pick.get) ? pick.get : [];
  if (kind === 'start_sit') return pick.id == null ? [] : [pick.id];
  return [];
}

/**
 * Follow-ledger rows as events (hit = he skipped the call), plus the per-kind counts
 * the card shows. Returns state 'absent' when 082 has not run.
 */
export function followEvents(leagueId) {
  const out = { state: 'ok', events: [], excluded: {}, by_kind: {}, unreadable: 0 };
  if (!tableExists('follow_ledger')) return { ...out, state: 'absent' };
  const all = rows(`SELECT season, week, kind, outcome, pick_json FROM follow_ledger
                    WHERE league_id = ? ORDER BY season, week, id`, leagueId);
  if (!all.length) return { ...out, state: 'empty' };
  for (const r of all) {
    const k = out.by_kind[r.kind] ??= { follow: 0, ignore: 0, no_action: 0, open: 0 };
    const key = r.outcome ?? 'open';
    k[key]++;
    if (r.outcome !== 'follow' && r.outcome !== 'ignore') { bump(out.excluded, key); continue; }
    let pick;
    try { pick = JSON.parse(r.pick_json); } catch (e) {
      // A row the ledger wrote but that does not parse is counted, not guessed at.
      out.unreadable++;
      continue;
    }
    const cats = [r.kind];
    for (const pos of new Set(pickPlayers(r.kind, pick).map(positionOf).filter(Boolean))) cats.push(`${r.kind}:${pos}`);
    out.events.push({ period: r.season * 100 + r.week, hit: r.outcome === 'ignore' ? 1 : 0, cats });
  }
  return out;
}

/* ----------------------------------------------------------- what he overpays for */

function parseItems(json) {
  const v = JSON.parse(json ?? '[]');
  if (!Array.isArray(v)) throw new Error('not an item list');
  return v;
}

/** ESPN item -> local player { id, position }, or null when there is no local row. */
function localPlayer(item) {
  const espn = item?.playerId;
  if (espn == null) return null;
  return row('SELECT id, position FROM players WHERE espn_id = ?', Number(espn)) ?? null;
}

function realisedPoints(ids, season, from, to) {
  if (!ids.length) return 0;
  const marks = ids.map(() => '?').join(',');
  return row(`SELECT COALESCE(SUM(fantasy_points), 0) AS pts FROM player_gamelog
              WHERE season = ? AND week BETWEEN ? AND ? AND player_id IN (${marks})`,
  season, from, to, ...ids).pts;
}

/**
 * Accepted observed trades Nick was party to, as events (hit = he gave up more
 * realised points than he got). The scoring period comes from the raw ESPN row the
 * outcome was settled from.
 */
export function overpayEvents(leagueId) {
  const out = { state: 'ok', events: [], unscorable: {} };
  if (!tableExists('trade_outcomes')) return { ...out, state: 'absent' };
  const lg = row('SELECT id, season, current_week, payload, my_team_id FROM leagues WHERE id = ?', leagueId);
  const me = lg?.my_team_id == null ? null : String(lg.my_team_id);
  if (!me) return { ...out, state: 'no_my_team' };
  const trades = rows(`SELECT season, proposer_team_id, give_json, get_json, espn_tx_id FROM trade_outcomes
                       WHERE league_id = ? AND source = 'observed' AND status = 'accepted'
                         AND (proposer_team_id = ? OR counterparty_team_id = ?)
                       ORDER BY season, COALESCE(proposed_at, created_at), id`, leagueId, me, me);
  if (!trades.length) return { ...out, state: 'empty' };
  const rawOk = tableExists('league_transactions_raw');
  const current = leagueCurrentWeek(lg);

  for (const t of trades) {
    const sp = rawOk
      ? row(`SELECT scoring_period FROM league_transactions_raw WHERE league_id = ? AND season = ? AND tx_id = ?`,
        leagueId, t.season, t.espn_tx_id)?.scoring_period ?? null
      : null;
    if (!(Number(sp) >= 1)) { bump(out.unscorable, 'no_scoring_period'); continue; }
    const from = Number(sp) + 1, to = Number(sp) + OVERPAY_HORIZON_WEEKS;
    const lastDone = Number(t.season) < Number(lg.season) ? LAST_WEEK : current - 1;
    if (to > lastDone) { bump(out.unscorable, 'horizon_open'); continue; }

    let proposerGives, proposerGets;
    try { proposerGives = parseItems(t.give_json); proposerGets = parseItems(t.get_json); } catch (e) {
      bump(out.unscorable, 'unreadable_items');
      continue;
    }
    const iProposed = String(t.proposer_team_id) === me;
    const gave = (iProposed ? proposerGives : proposerGets).map(localPlayer);
    const got = (iProposed ? proposerGets : proposerGives).map(localPlayer);
    if (!gave.length || !got.length) { bump(out.unscorable, 'one_sided'); continue; }
    if (gave.includes(null) || got.includes(null)) { bump(out.unscorable, 'unmapped_player'); continue; }

    const gavePts = round4(realisedPoints(gave.map(p => p.id), t.season, from, to));
    const gotPts = round4(realisedPoints(got.map(p => p.id), t.season, from, to));
    out.events.push({
      period: t.season * 100 + Number(sp), hit: gavePts > gotPts ? 1 : 0,
      cats: [...new Set(got.map(p => p.position).filter(Boolean))].map(pos => `acquire:${pos}`),
      gave_points: gavePts, got_points: gotPts,
    });
  }
  return out;
}

/* ------------------------------------------------ regret ledger and concession guard */

/** Statuses where an offer is settled. 'proposed' is still live. */
const SETTLED = new Set(['accepted', 'declined', 'countered', 'expired']);

/**
 * As-of weekly value of a set of local players: the sum of the snapshot predictions
 * made for `week`. null when any player has no snapshot that week (never a 0).
 */
function asOfValue(ids, season, week) {
  if (!ids.length) return 0;
  let total = 0;
  for (const id of ids) {
    const v = row(`SELECT prediction FROM weekly_prediction_snapshots WHERE season = ? AND week = ? AND player_id = ?`,
      season, week, id)?.prediction;
    if (v == null) return null;
    total += v;
  }
  return total;
}

/**
 * Nick's side of every observed offer he was party to, oldest first, with the
 * scoring period and local players. Rows that cannot be read are counted by reason.
 */
function nickOffers(leagueId) {
  const out = { state: 'ok', offers: [], unscorable: {} };
  if (!tableExists('trade_outcomes')) return { ...out, state: 'absent' };
  const lg = row('SELECT id, season, current_week, payload, my_team_id FROM leagues WHERE id = ?', leagueId);
  const me = lg?.my_team_id == null ? null : String(lg.my_team_id);
  if (!me) return { ...out, state: 'no_my_team' };
  const all = rows(`SELECT id, season, status, proposer_team_id, counterparty_team_id, give_json, get_json, espn_tx_id
                    FROM trade_outcomes
                    WHERE league_id = ? AND source = 'observed' AND (proposer_team_id = ? OR counterparty_team_id = ?)
                    ORDER BY season, COALESCE(proposed_at, created_at), id`, leagueId, me, me);
  if (!all.length) return { ...out, state: 'empty' };
  const rawOk = tableExists('league_transactions_raw');
  out.lastDone = season => (Number(season) < Number(lg.season) ? LAST_WEEK : leagueCurrentWeek(lg) - 1);
  for (const t of all) {
    const sp = rawOk
      ? row(`SELECT scoring_period FROM league_transactions_raw WHERE league_id = ? AND season = ? AND tx_id = ?`,
        leagueId, t.season, t.espn_tx_id)?.scoring_period ?? null
      : null;
    if (!(Number(sp) >= 1)) { bump(out.unscorable, 'no_scoring_period'); continue; }
    let gives, gets;
    try { gives = parseItems(t.give_json); gets = parseItems(t.get_json); } catch (e) {
      bump(out.unscorable, 'unreadable_items');
      continue;
    }
    const iProposed = String(t.proposer_team_id) === me;
    const gave = (iProposed ? gives : gets).map(localPlayer);
    const got = (iProposed ? gets : gives).map(localPlayer);
    if (!gave.length || !got.length) { bump(out.unscorable, 'one_sided'); continue; }
    if (gave.includes(null) || got.includes(null)) { bump(out.unscorable, 'unmapped_player'); continue; }
    out.offers.push({
      id: t.id, season: Number(t.season), week: Number(sp), period: t.season * 100 + Number(sp), status: t.status,
      proposed: iProposed, partner: String(iProposed ? t.counterparty_team_id : t.proposer_team_id),
      gave: gave.map(p => p.id), got: got.map(p => p.id),
      got_positions: [...new Set(got.map(p => p.position).filter(Boolean))],
    });
  }
  return out;
}

/**
 * The regret ledger: one entry per settled offer where the choice was his.
 * `as_of_edge` and `realised_regret` are points over OVERPAY_HORIZON_WEEKS, from the
 * alternative's side: positive means the road he did not take looked (as of) or
 * turned out (realised) better. Realised is null until the horizon is over.
 */
export function regretLedger(leagueId, src = nickOffers(leagueId)) {
  const out = { state: src.state, entries: [], aside: { ...src.unscorable } };
  if (src.state !== 'ok') return out;
  const H = OVERPAY_HORIZON_WEEKS;
  for (const o of src.offers) {
    if (!SETTLED.has(o.status)) { bump(out.aside, 'not_settled'); continue; }
    const accepted = o.status === 'accepted';
    if (!accepted && o.proposed) { bump(out.aside, 'not_his_call'); continue; }
    // Accepted: he passed on keeping his side. Otherwise: he passed on taking the deal.
    const altIn = accepted ? o.gave : o.got, altOut = accepted ? o.got : o.gave;
    const vIn = asOfValue(altIn, o.season, o.week), vOut = asOfValue(altOut, o.season, o.week);
    const entry = {
      period: o.period, status: o.status, role: o.proposed ? 'proposer' : 'counterparty',
      passed_on: accepted ? 'keep' : 'accept',
      as_of_edge: vIn == null || vOut == null ? null : round4((vIn - vOut) * H),
      realised_regret: null, realised_state: 'ok',
    };
    entry.as_of_state = entry.as_of_edge == null ? 'no_snapshot' : 'ok';
    const from = o.week + 1, to = o.week + H;
    if (to > src.lastDone(o.season)) entry.realised_state = 'horizon_open';
    else {
      entry.realised_regret = round4(realisedPoints(altIn, o.season, from, to) - realisedPoints(altOut, o.season, from, to));
    }
    out.entries.push(entry);
  }
  return out;
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Concession guard. Each re-offer's concession is the rise in the net as-of value he
 * gives (give - get, per week) from his last turned-down offer to the same manager,
 * both measured with values as of the re-offer's week. Its norm is the median of
 * concessions from EARLIER weeks. Events feed walkForward (hit = above his norm).
 */
export function concessionGuard(leagueId, src = nickOffers(leagueId)) {
  const out = { state: src.state, reoffers: [], events: [], aside: {} };
  if (src.state !== 'ok') return out;
  const lastDown = new Map(); // `${season}:${partner}` -> the last offer of his that was turned down
  const net = (o, season, week) => {
    const g = asOfValue(o.gave, season, week), r = asOfValue(o.got, season, week);
    return g == null || r == null ? null : g - r;
  };
  const done = []; // { period, concession }
  for (const o of src.offers.filter(x => x.proposed)) {
    const key = `${o.season}:${o.partner}`;
    const prev = lastDown.get(key);
    if (prev) {
      const now = net(o, o.season, o.week), then = net(prev, o.season, o.week);
      if (now == null || then == null) bump(out.aside, 'no_snapshot');
      else {
        const concession = round4(now - then);
        const earlier = done.filter(d => d.period < o.period).map(d => d.concession);
        const norm = earlier.length >= MIN_FIT_N ? round4(median(earlier)) : null;
        const over = norm == null ? null : concession > norm;
        out.reoffers.push({ period: o.period, status: o.status, concession, norm, over_norm: over,
          cats: o.got_positions.map(pos => `concede:${pos}`) });
        if (over != null) out.events.push({ period: o.period, hit: over ? 1 : 0, cats: o.got_positions.map(pos => `concede:${pos}`) });
        else bump(out.aside, 'no_norm_yet');
        done.push({ period: o.period, concession });
      }
    }
    if (o.status === 'accepted') lastDown.delete(key);
    else if (o.status !== 'proposed') lastDown.set(key, o);
  }
  return out;
}

/* ------------------------------------------------------------------- the reader */

function labelOf(bias, category) {
  if (bias === 'concedes') return `You give up more than your norm when you re-offer for ${category.split(':')[1]}s`;
  if (bias === 'overpays') return `You pay too much when you trade for ${category.split(':')[1]}s`;
  const [kind, pos] = category.split(':');
  return `You skip ${KIND_LABEL[kind] ?? kind} calls${pos ? ` for ${pos}s` : ''}`;
}

function flagsFrom(bias, candidates) {
  const shown = candidates.filter(c => c.shown);
  const byCat = new Map(shown.map(c => [c.category, c]));
  const keep = [], dropped = [];
  for (const c of shown) {
    const parent = c.category.includes(':') && bias === 'ignores' ? byCat.get(c.category.split(':')[0]) : null;
    if (parent && !(c.forward.precision > parent.forward.precision)) { dropped.push(c); continue; }
    keep.push({ category: c.category, bias, label: labelOf(bias, c.category),
      forward: { n: c.forward.n, hits: c.forward.hits, precision: c.forward.precision, base_rate: c.forward.base_rate } });
  }
  const held = candidates.filter(c => !c.shown);
  return { keep, held, redundant: dropped.length };
}

/**
 * Nick's bias flags for one league: the shown flags, how many candidates were held
 * back (by reason), his follow / ignore counts per call kind, and the state of each
 * source. Never throws on a missing source; says which one is missing.
 */
export function selfBiasFlags(leagueId) {
  const follow = followEvents(leagueId);
  const trades = overpayEvents(leagueId);
  const ig = flagsFrom('ignores', walkForward(follow.events).candidates);
  const op = flagsFrom('overpays', walkForward(trades.events).candidates);
  const offers = nickOffers(leagueId);
  const regret = regretLedger(leagueId, offers);
  const guard = concessionGuard(leagueId, offers);
  const cg = flagsFrom('concedes', walkForward(guard.events).candidates);
  // A guarded re-offer reaches the card only when its category passed the forward check.
  const passed = new Set(cg.keep.map(f => f.category));
  const guarded = guard.reoffers.filter(r => r.over_norm && r.cats.some(c => passed.has(c)))
    .map(({ period, status, concession, norm }) => ({ period, status, concession, norm }));
  const heldByReason = {};
  for (const c of [...ig.held, ...op.held, ...cg.held]) bump(heldByReason, c.held_reason);
  return {
    state: 'ok',
    flags: [...ig.keep, ...op.keep, ...cg.keep].sort((a, b) => b.forward.precision - a.forward.precision),
    held: ig.held.length + op.held.length + cg.held.length,
    held_by_reason: heldByReason,
    follow: { by_kind: follow.by_kind, excluded: follow.excluded, events: follow.events.length, unreadable: follow.unreadable },
    trades: { events: trades.events.length, unscorable: trades.unscorable },
    regret: {
      entries: regret.entries, aside: regret.aside,
      scored: regret.entries.filter(e => e.realised_regret != null).length,
    },
    concession: {
      reoffers: guard.reoffers.length, events: guard.events.length, aside: guard.aside,
      guarded, guarded_held: guard.reoffers.filter(r => r.over_norm).length - guarded.length,
    },
    sources: { follow_ledger: follow.state, trade_outcomes: trades.state },
    check: { min_fit_n: MIN_FIT_N, min_eval_n: MIN_EVAL_N, overpay_horizon_weeks: OVERPAY_HORIZON_WEEKS },
    killed: KILLED_BIASES,
  };
}
