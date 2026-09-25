/**
 * CAMPAIGN-01 search core: single-player values, the flip map, and the
 * acquisition path search (ACQ-01), over an injected world. Deterministic
 * given the world; no DB, no env, no clock.
 *
 * One env read, by exception: flipLegsFlag (GRIDIRON_FLIP_LEGS, or the preview switch via
 * preview-mode.js) when the adapter does not set searchOpts.flipLegs itself.
 *
 * The world (`W`) is built by the producer script from season-sim.js
 * (tradeImpactWorld, the fast rescore) and handed in; tests hand in a fixture.
 *   W.rescore(state, a, b) -> { me, them }   state: Map team -> ids (changed teams only)
 * Extends the ACQ-FLIP prototype (PR #227): same search shape, plus an objective
 * metric (title / playoffs / points), 3-player packages for the final leg, a
 * rescore budget, and the per-step states kept for the confirm pass.
 */
import { screenFair, flipSpread, linearNick, combos, pathExpectation, isChained, dealKey,
  fairBand, onesInBand, pairsInBand, shapeOf, oneForOneOnly } from './paths.js';
import { metricOf } from './objectives.js';
import { excluded } from './partners.js';
import { previewUnconfirmed } from '../preview-mode.js';

/** A served basis of p-yes.js's own (activity baseline, LIVE-BLEND blend), not the clone's. */
const servedBasis = b => b === 'activity_baseline' || b === 'pyes_blend';
/**
 * LIVE-BLEND: what a priced step carries beside p. p_basis when p-yes.js served it; p_gate = the
 * baseline p that Nick's rules read (planner.js#confirmGate), so the blend can only move ranking;
 * probe = the shadow information-gain tie-breaker. All absent on the clone path.
 */
export const stepPExtras = pr => ({ ...(servedBasis(pr.basis ?? pr.p_basis) ? { p_basis: pr.basis ?? pr.p_basis } : {}),
  ...(pr.p_gate != null ? { p_gate: pr.p_gate } : {}), ...(pr.probe != null ? { probe: pr.probe } : {}) });

export const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * NO-OVERPAY: Nick's cap on what he gives up in market value (the adapter's player value, the app's
 * one market price: player_metrics fc_value). A fraction of what he gets: 0 (the default, Nick's
 * stated preference) means he never gives more market value than he receives; 0.05 allows +5%.
 * A hard filter on every planned step, every flip leg Nick is on and the walk-away (planner.js).
 */
export const DEFAULT_MAX_OVERPAY = 0;
const OVERPAY_EPS = 1e-9;

/** The destination's max_overpay when it is a number >= 0 (Infinity = no cap), else the default. */
export function maxOverpayOf(tol) {
  const v = Number(tol?.max_overpay);
  return tol?.max_overpay != null && !Number.isNaN(v) && v >= 0 ? v : DEFAULT_MAX_OVERPAY;
}

/** Nick's overpay as a fraction of what he gets: (given - received) / received (negative = he gets more). */
export function overpayPct(giveValue, getValue) {
  if (!(getValue > 0)) return giveValue > 0 ? Infinity : 0;
  return (giveValue - getValue) / getValue;
}

/** Whether Nick gives more market value than he gets by more than `max`. */
export function nickOverpays(giveValue, getValue, max = DEFAULT_MAX_OVERPAY) {
  return overpayPct(giveValue, getValue) > max + OVERPAY_EPS;
}

/** A fresh sink for the steps the cap turned away: how many, and the closest one to the target. */
export function newOverpaySink(max = DEFAULT_MAX_OVERPAY) {
  return { max_overpay: max, rejected: 0, closest: null };
}

/** A rescore wrapper with a memo, a counter and a budget. */
export function makeScorer(W, adapter) {
  const baseRoster = adapter.rosters;
  const memo = new Map();
  let count = 0;
  const key = (state, a, b) => JSON.stringify([[...state.entries()].map(([k, v]) => [k, [...v].map(String).sort()]).sort(), a, b]);
  const rescore = (state, a = adapter.league.me, b = null) => {
    const k = key(state, a, b);
    if (!memo.has(k)) { count++; memo.set(k, W.rescore(state, a, b)); }
    return memo.get(k);
  };
  const rosterOf = (state, id) => state.get(id) ?? baseRoster.get(id);
  const applyTrade = (state, x, y, xGives, yGives) => {
    const s = new Map(state);
    const gx = new Set(xGives), gy = new Set(yGives);
    s.set(x, [...rosterOf(state, x).filter(id => !gx.has(id)), ...yGives]);
    s.set(y, [...rosterOf(state, y).filter(id => !gy.has(id)), ...xGives]);
    return s;
  };
  const ownerOf = (state, pid) => {
    for (const id of baseRoster.keys()) if (rosterOf(state, id).includes(pid)) return id;
    return null;
  };
  return { rescore, rosterOf, applyTrade, ownerOf, count: () => count };
}

/** Single-player values on the objective: what each outside player adds to Nick, what each of his costs. */
export function playerValues(S, adapter, objective) {
  const me = adapter.league.me;
  const P = adapter.players;
  // Nick's untouchables (adapter.untouchable, the reader's nick block) are never a target, a get or a flip leg.
  const untouchable = adapter.untouchable ?? new Set();
  const tradable = id => !untouchable.has(String(id)) && SCORED.has(P.get(id)?.position) && (P.get(id)?.value ?? 0) > 0;
  const addN = new Map(), addSe = new Map(), lossO = new Map(), lossN = new Map();
  for (const [tid, ids] of adapter.rosters) {
    if (tid === me || excluded(adapter.managers.get(tid))) continue;
    for (const pid of ids.filter(tradable)) {
      const r = S.rescore(S.applyTrade(new Map(), me, tid, [], [pid]), me, tid);
      const m = metricOf(r.me, objective);
      addN.set(pid, m.delta); addSe.set(pid, m.se);
      lossO.set(pid, { team: tid, delta: r.them.title_delta, se: r.them.title_delta_se });
    }
  }
  for (const pid of adapter.rosters.get(me).filter(tradable)) {
    const s = new Map([[me, adapter.rosters.get(me).filter(id => id !== pid)]]);
    lossN.set(pid, metricOf(S.rescore(s, me).me, objective).delta);
  }
  return { addN, addSe, lossO, lossN, tradable };
}

/**
 * FLIP-LEGS switch: 'on' (GRIDIRON_FLIP_LEGS=1), 'preview' (on only via preview mode), 'off'
 * (unset, or =0, which vetoes preview). On: flip candidates are the players Nick can reach and
 * a leg may be a two-player package on either side (flipMap below).
 */
export const FLIP_LEGS_ENV = 'GRIDIRON_FLIP_LEGS';
export function flipLegsFlag(env = process.env) {
  if (env[FLIP_LEGS_ENV] === '1') return 'on';
  if (env[FLIP_LEGS_ENV] === '0') return 'off';
  return previewUnconfirmed() ? 'preview' : 'off';
}

/**
 * FLIP-LEGS: the value of the best package of one or two of Nick's players he can give, and the
 * highest player value that package still reads fair for on the other screen (the planner's
 * fairBand: a player is in reach when his band's floor is at or under that package).
 */
export function flipReach(myValues) {
  const top = [...myValues].filter(v => v > 0).sort((a, b) => b - a).slice(0, 2);
  const pkg = top.reduce((s, v) => s + v, 0);
  return { package_value: pkg, reaches: v => { const b = fairBand(v); return !!b && b.lo <= pkg; } };
}

/**
 * FLIP-LEGS legs. Leg 1 (Nick -> A for the player): one or two of Nick's players whose value (a
 * pair: its SUM) is in the player's fairBand, the one planner's onesInBand / pairsInBand; the one
 * that costs Nick least on his single-player losses. Leg 2 (B -> Nick for the player): one or two
 * of B's players the player reads screen-fair against (a pair on its SUM, the same screenFair);
 * the one that adds most to Nick. Returns the ids or null per leg.
 */
export function flipLegs({ player, myIds, bIds, val, lossN, addN, pairLimit = SEARCH_DEFAULTS.pairLimit,
  maxOverpay = DEFAULT_MAX_OVERPAY }) {
  const pv = val(player);
  const band = fairBand(pv);
  const items = myIds.filter(id => id !== player).map(id => ({ id, value: val(id) }));
  const sum = (ids, m) => ids.reduce((s, id) => s + (m.get(id) ?? 0), 0);
  const worth = ids => ids.reduce((s, id) => s + val(id), 0);
  const fairGives = [...onesInBand(items, band), ...pairsInBand(items, band, { limit: pairLimit })];
  // NO-OVERPAY: leg 1 never gives more market value than the player is worth; leg 2 never gives him for less.
  const gives = fairGives.filter(ids => !nickOverpays(worth(ids), pv, maxOverpay));
  const legX = gives.sort((x, y) => sum(y, lossN) - sum(x, lossN) || x.length - y.length)[0] ?? null;
  const fairGets = combos(bIds.filter(id => id !== player), 2).filter(ids => screenFair(pv, worth(ids)));
  const gets = fairGets.filter(ids => !nickOverpays(pv, worth(ids), maxOverpay));
  const legY = gets.sort((x, y) => sum(y, addN) - sum(x, addN) || x.length - y.length)[0] ?? null;
  return { legX, legY, capped: { a: !legX && fairGives.length > 0, b: !legY && fairGets.length > 0 } };
}

/**
 * FLIP-01: every key player on A, moved to every B; ranked by spread x P(A) x P(B) x days left,
 * where a pair has no realised legs its P terms are 1 (spread only). Chat sentiment (B loves him,
 * A hates him) is a targeting hint: ranked first among equal-clearing pairs, labelled "from chat".
 *
 * FLIP-LEGS (adapter.searchOpts.flipLegs, else flipLegsFlag): the key players are each roster's top
 * `topPer` by value among those in Nick's reach (flipReach), never an untouchable (Nick's block,
 * adapter.untouchable and each manager's nick.untouchable); a leg may be 2-for-1 (flipLegs); a flip
 * that still does not realise says which leg is missing (why, why_code).
 */
export function flipMap(S, adapter, vals, { topPer = 3, realise = 6, daysLeft = 1, maxOverpay = DEFAULT_MAX_OVERPAY } = {}) {
  const me = adapter.league.me;
  const P = adapter.players;
  const val = id => Math.max(0, Number(P.get(id)?.value) || 0);
  const legsOn = adapter.searchOpts?.flipLegs ?? (flipLegsFlag() !== 'off');
  const untouchable = new Set([...(adapter.untouchable ?? [])].map(String));
  for (const m of adapter.managers.values()) for (const id of m?.nick?.untouchable ?? []) untouchable.add(String(id));
  const flipOk = legsOn ? id => vals.tradable(id) && !untouchable.has(String(id)) : vals.tradable;
  const myIds = S.rosterOf(new Map(), me).filter(flipOk);
  const reach = legsOn ? flipReach(myIds.map(val)) : null;
  const flips = [];
  for (const [aId, ids] of adapter.rosters) {
    if (aId === me || excluded(adapter.managers.get(aId))) continue;
    const key = ids.filter(flipOk).filter(id => !reach || reach.reaches(val(id))).sort((x, y) => val(y) - val(x)).slice(0, topPer);
    for (const pid of key) {
      for (const bId of adapter.rosters.keys()) {
        if (bId === me || bId === aId || excluded(adapter.managers.get(bId))) continue;
        const r = S.rescore(S.applyTrade(new Map(), bId, aId, [], [pid]), bId, aId);
        const s = flipSpread(r.me.title_delta, r.me.title_delta_se, r.them.title_delta, r.them.title_delta_se);
        const pa = adapter.priceOf(aId, pid), pb = adapter.priceOf(bId, pid);
        const chatA = adapter.managers.get(aId)?.chat, chatB = adapter.managers.get(bId)?.chat;
        const hint = (chatA?.hates ?? []).includes(String(pid)) || (chatB?.loves ?? []).includes(String(pid));
        flips.push({ player: pid, a: aId, b: bId, dB: r.me.title_delta, dA: r.them.title_delta, ...s,
          price_a: pa.price, price_b: pb.price, mult_a: pa.mult, mult_b: pb.mult, chat_hint: hint });
      }
    }
  }
  const blocked = t => excluded(adapter.managers.get(t)) || !!adapter.managers.get(t)?.checked_out;
  const pairLimit = { ...SEARCH_DEFAULTS, ...(adapter.searchOpts ?? {}) }.pairLimit;
  const realised = [];
  for (const f of flips.filter(x => x.clears).sort((x, y) => y.spread - x.spread).slice(0, realise * 2)) {
    if (realised.length >= realise) break;
    if (blocked(f.a) || blocked(f.b)) continue;
    const pv = val(f.player);
    let gx, gy;
    if (legsOn) {
      const legs = flipLegs({ player: f.player, myIds, bIds: adapter.rosters.get(f.b).filter(flipOk), val,
        lossN: vals.lossN, addN: vals.addN, pairLimit, maxOverpay });
      gx = legs.legX; gy = legs.legY;
      if (!gx || !gy) {
        // NO-OVERPAY: a leg that only the cap removed says so (every fair package gives more than it gets).
        const cappedOnly = (!gx ? legs.capped.a : true) && (!gy ? legs.capped.b : true);
        const code = cappedOnly ? 'no_leg_overpay' : !gx && !gy ? 'no_leg_either' : !gx ? 'no_leg_a' : 'no_leg_b';
        const why = cappedOnly ? `every fair package ${!gx ? `for him on Team ${f.a}'s screen` : `from Team ${f.b} for him`} gives more market value than you get (your cap: +${Math.round(maxOverpay * 100)}%)`
          : !gx && !gy ? `no fair package (1 or 2 players) on either screen: none of yours for him to Team ${f.a}, none of Team ${f.b}'s for him`
            : !gx ? `no fair package of 1 or 2 of your players for him on Team ${f.a}'s screen`
              : `no fair package of 1 or 2 of Team ${f.b}'s players for him on their screen`;
        realised.push({ ...f, legs: null, why, why_code: code });
        continue;
      }
    } else {
      const legX = myIds.filter(x => screenFair(val(x), pv) && !nickOverpays(val(x), pv, maxOverpay))
        .sort((x, y) => (vals.lossN.get(y) ?? 0) - (vals.lossN.get(x) ?? 0))[0];
      const legY = adapter.rosters.get(f.b).filter(vals.tradable).filter(y => screenFair(pv, val(y)) && !nickOverpays(pv, val(y), maxOverpay))
        .sort((x, y) => (vals.addN.get(y) ?? 0) - (vals.addN.get(x) ?? 0))[0];
      if (legX == null || legY == null) { realised.push({ ...f, legs: null, why: 'no fair one-player leg on both screens' }); continue; }
      gx = [legX]; gy = [legY];
    }
    const s1 = S.applyTrade(new Map(), me, f.a, gx, [f.player]);
    const s2 = S.applyTrade(s1, me, f.b, [f.player], gy);
    const r1 = S.rescore(s1, me, f.a), r2 = S.rescore(s2, me, f.b);
    const pr1 = adapter.priceStep(f.a, [f.player], gx), pr2 = adapter.priceStep(f.b, gy, [f.player]);
    const p1 = pr1.p, p2 = pr2.p;
    const e = pathExpectation([{ p: p1, delta: r1.me.title_delta }, { p: p2, delta: r2.me.title_delta, se: r2.me.title_delta_se }]);
    // give_a / get_b stay one id (the package's most valuable player) for the served contract; the ids are the package.
    const lead = ids => [...ids].sort((x, y) => val(y) - val(x))[0];
    realised.push({ ...f, legs: { give_a: lead(gx), get_b: lead(gy),
      ...(legsOn ? { give_a_ids: gx, get_b_ids: gy, shape_1: `${gx.length}-for-1`, shape_2: `1-for-${gy.length}` } : {}),
      p1, p2, ...(servedBasis(pr1.basis) ? { p_basis: pr1.basis } : {}), d1: r1.me.title_delta, d2: r2.me.title_delta,
      se2: r2.me.title_delta_se, clears2: r2.me.title_delta_clears_noise, ...e } });
  }
  const rankOf = f => {
    const r = realised.find(x => x.player === f.player && x.a === f.a && x.b === f.b && x.legs);
    return f.spread * (r ? r.legs.p1 * r.legs.p2 : 1) * Math.max(1, daysLeft) * (f.chat_hint ? 1.25 : 1);
  };
  // FLIP-LEGS: among clearing pairs, the ones with fair legs on both screens come first (still ranked
  // by spread x P1 x P2), so an unpriced pair's P = 1 never pushes a realised flip out of the top 10.
  const hasLegs = f => (legsOn && realised.some(x => x.player === f.player && x.a === f.a && x.b === f.b && x.legs) ? 1 : 0);
  const ranked = flips.map(f => ({ ...f, rank_score: rankOf(f) }))
    .sort((x, y) => (Number(y.clears) - Number(x.clears)) || (hasLegs(y) - hasLegs(x)) || (y.rank_score - x.rank_score));
  return { pairs: flips.length, clears: flips.filter(f => f.clears).length, top: ranked.slice(0, 10), realised,
    ...(legsOn ? { legs_mode: 'flip_legs', reach_value: reach.package_value } : {}) };
}

/** ONE-PLANNER search options, read from the adapter (the producer sets them; a fixture may not). */
export const SEARCH_DEFAULTS = Object.freeze({ twoForOne: false, pairLimit: 60, fillers: 4 });

/** A fresh stats sink for one league's searches (the producer hangs it on the adapter). */
export function newSearchStats(twoForOne = false) {
  return { two_for_one_on: !!twoForOne, screened: {}, shortlisted: {}, targets: [] };
}

/**
 * IDEA-038 per league: the best exact-scored path with a two-player side vs the best
 * 1-for-1-only path, per target (same world, same seed).
 */
export function twoForOneSummary(stats) {
  if (!stats) return null;
  const rows = stats.targets;
  return {
    on: stats.two_for_one_on, screened: stats.screened, shortlisted: stats.shortlisted,
    two_for_one_screened: stats.screened['2-for-1'] ?? 0,
    targets: rows.length,
    best_is_two: rows.filter(r => r.best_is_two).length,
    one_for_one_finds_nothing: rows.filter(r => r.best_one_for_one == null && r.best_with_two != null).length,
    rows,
  };
}

/**
 * ACQ-01 path search for one target. Returns candidate plans with exact per-step metric deltas and
 * the per-step states (kept in memory for the confirm pass, dropped from the output).
 *
 * ONE-PLANNER (moved in from PR #267): with adapter.searchOpts.twoForOne on, a step's gives are
 * enumerated on value bands (single pieces, pairs whose SUM is screen-fair, and the incumbent's
 * triples on the final leg), an offer to the target's owner may also take a filler from him
 * (1-for-2), and the exact-scored shortlist is taken per arm (1-for-1-only paths and paths with a
 * two-player side) so each arm is scored on its own merits. Off, the incumbent search runs
 * unchanged. Either way a target whose owner Nick marked unreachable (or never trading) gets no
 * path: that manager is never a step (FIX-02c nick block).
 */
export function searchTarget(S, adapter, vals, objective, target, { maxGiveFinal = 3, shortlist = [8, 12, 8],
  maxOverpay = DEFAULT_MAX_OVERPAY, overpaySink = null } = {}) {
  const me = adapter.league.me;
  const P = adapter.players;
  const o = { ...SEARCH_DEFAULTS, ...(adapter.searchOpts ?? {}) };
  const two = !!o.twoForOne;
  const stats = adapter.searchStats ?? null;
  const val = id => Math.max(0, Number(P.get(id)?.value) || 0);
  const owner = vals.lossO.get(target)?.team ?? S.ownerOf(new Map(), target);
  if (owner == null || owner === me || excluded(adapter.managers.get(owner)) || adapter.untouchable?.has(String(target))) return [];
  const origMine = adapter.rosters.get(me);
  const partners = [...adapter.rosters.keys()].filter(id => id !== me && !excluded(adapter.managers.get(id))
    && !adapter.managers.get(id)?.checked_out);
  const lin = state => linearNick(S.rosterOf(state, me), origMine, vals.addN, vals.lossN);
  const count = (bucket, st) => { if (stats) { const k = shapeOf(st); stats[bucket][k] = (stats[bucket][k] ?? 0) + 1; } };
  const stepsFrom = (state, team, onlyGet = null, maxGive = 2) => {
    const mine = S.rosterOf(state, me).filter(vals.tradable);
    const theirs = onlyGet != null ? [onlyGet] : S.rosterOf(state, team).filter(vals.tradable);
    const out = [];
    // NO-OVERPAY: a step where Nick gives more market value than he gets (past the cap) is never planned;
    // the sink keeps the closest such offer for the target so the deck can say what it would have cost.
    const push = st => {
      const pct = overpayPct(st.give.reduce((s, id) => s + val(id), 0), st.get.reduce((s, id) => s + val(id), 0));
      if (pct > maxOverpay + OVERPAY_EPS) {
        if (overpaySink) {
          overpaySink.rejected++;
          const c = overpaySink.closest;
          if (st.get.some(id => String(id) === String(target)) && Number.isFinite(pct) && (!c || pct < c.pct)) {
            overpaySink.closest = { team: st.team, give: [...st.give], get: [...st.get], pct };
          }
        }
        return;
      }
      count('screened', st); out.push(st);
    };
    if (!two) {
      for (const get of theirs) for (const give of combos(mine, maxGive)) {
        if (give.includes(onlyGet)) continue;
        if (!screenFair(give.reduce((s, id) => s + val(id), 0), val(get))) continue;
        push({ team, give, get: [get] });
      }
      return out;
    }
    const items = mine.filter(id => id !== onlyGet).map(id => ({ id, value: val(id) }));
    for (const get of theirs) {
      const band = fairBand(val(get));
      for (const give of onesInBand(items, band)) push({ team, give, get: [get] });
      if (maxGive >= 2) for (const give of pairsInBand(items, band, { limit: o.pairLimit })) push({ team, give, get: [get] });
      if (maxGive >= 3) {
        for (const give of combos(items.map(x => x.id), 3)) {
          if (give.length !== 3 || !screenFair(give.reduce((s, id) => s + val(id), 0), val(get))) continue;
          push({ team, give, get: [get] });
        }
      }
    }
    if (onlyGet != null && o.fillers > 0) {
      // 1-for-2: the target plus a filler from his owner, for one of Nick's (ACQ-01).
      const fillers = S.rosterOf(state, team).filter(id => id !== onlyGet && vals.tradable(id))
        .sort((x, y) => (vals.addN.get(y) ?? 0) - (vals.addN.get(x) ?? 0)).slice(0, o.fillers);
      for (const f of fillers) {
        for (const give of onesInBand(items, fairBand(val(onlyGet) + val(f)))) push({ team, give, get: [onlyGet, f] });
      }
    }
    return out;
  };
  const withP = (state, st) => {
    const pr = adapter.priceStep(st.team, st.get, st.give);
    // PYES-ONE: a baseline p carries no band, so its basis rides on the step (absent with the flag off).
    // LIVE-BLEND: p_gate (the baseline p the rules read) and probe (shadow tie-breaker) ride along too.
    return { ...st, p: pr.p, band: pr.band ? { ...pr.band, basis: pr.basis ?? null } : null,
      ...stepPExtras(pr), state: S.applyTrade(state, me, st.team, st.give, st.get) };
  };
  const h = steps => pathExpectation(steps.map(x => ({ p: x.p, delta: lin(x.state) })));
  const direct = stepsFrom(new Map(), owner, target, maxGiveFinal).map(st => [withP(new Map(), st)]);
  const chipLayer = (prefixes, maxGive) => {
    const next = [];
    for (const pre of prefixes) {
      const state = pre.length ? pre[pre.length - 1].state : new Map();
      for (const team of partners) for (const st of stepsFrom(state, team, null, maxGive)) {
        if (st.get[0] === target) continue;
        next.push([...pre, withP(state, st)]);
      }
    }
    return next;
  };
  const finish = prefix => {
    const state = prefix[prefix.length - 1].state;
    const own = S.ownerOf(state, target);
    if (own == null || own === me) return null;
    let best = null;
    for (const st of stepsFrom(state, own, target, 2)) {
      const steps = [...prefix, withP(state, st)];
      const e = h(steps);
      if (!best || e.expected > best.e.expected) best = { steps, e };
    }
    return best;
  };
  const byExp = (a, b) => b.e.expected - a.e.expected;
  const byFinal = (a, b) => b.e.delta_final - a.e.delta_final;
  const d1 = direct.map(steps => ({ steps, e: h(steps) }));
  const d2 = chipLayer([[]], 2).map(finish).filter(Boolean);
  const d3 = chipLayer(d2.sort(byExp).slice(0, 6).map(c => c.steps.slice(0, 1)), 1).map(finish).filter(Boolean);
  // Two shortlists per depth: by expected (balanced / safe) and by final delta (all-in).
  const pick1 = (list, n) => [...list.sort(byExp).slice(0, n), ...list.sort(byFinal).slice(0, Math.ceil(n / 2))];
  // With the 2-for-1 search on, each arm (1-for-1-only, two-player side) gets its own shortlist,
  // so the 1-for-1 arm is exactly what the incumbent would have scored and never crowded out.
  const pick = (list, n) => (two
    ? [...pick1(list.filter(c => oneForOneOnly(c.steps)), n), ...pick1(list.filter(c => !oneForOneOnly(c.steps)), n)]
    : pick1(list, n));
  const seen = new Set();
  const short = [...pick(d1, shortlist[0]), ...pick(d2, shortlist[1]), ...pick(d3, shortlist[2])].filter(c => {
    const k = c.steps.map(dealKey).join('>');
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  const plans = short.map(c => {
    const steps = c.steps.map(st => {
      const m = metricOf(S.rescore(st.state, me).me, objective);
      return { team: st.team, give: st.give, get: st.get, p: st.p, band: st.band, ...stepPExtras(st),
        delta: m.delta, se: m.se, clears: m.clears, state: st.state };
    });
    const oneOnly = oneForOneOnly(steps);
    if (stats) { const k = oneOnly ? 'one_for_one_only' : 'two_side'; stats.shortlisted[k] = (stats.shortlisted[k] ?? 0) + 1; }
    return { target, owner, depth: steps.length, heuristic: c.e.expected, chained: isChained(steps), steps,
      ...pathExpectation(steps) };
  });
  if (stats) {
    const best = f => plans.filter(f).reduce((b, p) => (b == null || p.expected > b ? p.expected : b), null);
    const one = best(p => oneForOneOnly(p.steps)), withTwo = best(p => !oneForOneOnly(p.steps));
    stats.targets.push({ target: String(target), owner: String(owner), best_one_for_one: one, best_with_two: withTwo,
      gain: withTwo == null ? null : withTwo - (one ?? 0), best_is_two: withTwo != null && (one == null || withTwo > one) });
  }
  return plans;
}

/** Drop the in-memory states from a plan before it is written. */
export function publicPlan(p) {
  if (!p) return null;
  const { steps, ...rest } = p;
  return { ...rest, steps: steps.map(({ state, ...s }) => s) };
}
