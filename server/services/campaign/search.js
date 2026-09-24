/**
 * CAMPAIGN-01 search core: single-player values, the flip map, and the
 * acquisition path search (ACQ-01), over an injected world. Deterministic
 * given the world; no DB, no env, no clock.
 *
 * The world (`W`) is built by the producer script from season-sim.js
 * (tradeImpactWorld, the fast rescore) and handed in; tests hand in a fixture.
 *   W.rescore(state, a, b) -> { me, them }   state: Map team -> ids (changed teams only)
 * Extends the ACQ-FLIP prototype (PR #227): same search shape, plus an objective
 * metric (title / playoffs / points), 3-player packages for the final leg, a
 * rescore budget, and the per-step states kept for the confirm pass.
 */
import { screenFair, flipSpread, linearNick, combos, pathExpectation, isChained, dealKey } from './paths.js';
import { metricOf } from './objectives.js';

export const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);

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
  const tradable = id => SCORED.has(P.get(id)?.position) && (P.get(id)?.value ?? 0) > 0;
  const addN = new Map(), addSe = new Map(), lossO = new Map(), lossN = new Map();
  for (const [tid, ids] of adapter.rosters) {
    if (tid === me || adapter.managers.get(tid)?.blocked) continue;
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
 * FLIP-01: every key player on A, moved to every B; ranked by spread x P(A) x P(B) x days left,
 * where a pair has no realised legs its P terms are 1 (spread only). Chat sentiment (B loves him,
 * A hates him) is a targeting hint: ranked first among equal-clearing pairs, labelled "from chat".
 */
export function flipMap(S, adapter, vals, { topPer = 3, realise = 6, daysLeft = 1 } = {}) {
  const me = adapter.league.me;
  const P = adapter.players;
  const val = id => Math.max(0, Number(P.get(id)?.value) || 0);
  const flips = [];
  for (const [aId, ids] of adapter.rosters) {
    if (aId === me) continue;
    const key = ids.filter(vals.tradable).sort((x, y) => val(y) - val(x)).slice(0, topPer);
    for (const pid of key) {
      for (const bId of adapter.rosters.keys()) {
        if (bId === me || bId === aId) continue;
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
  const myIds = S.rosterOf(new Map(), me).filter(vals.tradable);
  const blocked = t => !!adapter.managers.get(t)?.blocked || !!adapter.managers.get(t)?.checked_out;
  const realised = [];
  for (const f of flips.filter(x => x.clears).sort((x, y) => y.spread - x.spread).slice(0, realise * 2)) {
    if (realised.length >= realise) break;
    if (blocked(f.a) || blocked(f.b)) continue;
    const pv = val(f.player);
    const legX = myIds.filter(x => screenFair(val(x), pv)).sort((x, y) => (vals.lossN.get(y) ?? 0) - (vals.lossN.get(x) ?? 0))[0];
    const legY = adapter.rosters.get(f.b).filter(vals.tradable).filter(y => screenFair(pv, val(y)))
      .sort((x, y) => (vals.addN.get(y) ?? 0) - (vals.addN.get(x) ?? 0))[0];
    if (legX == null || legY == null) { realised.push({ ...f, legs: null, why: 'no fair one-player leg on both screens' }); continue; }
    const s1 = S.applyTrade(new Map(), me, f.a, [legX], [f.player]);
    const s2 = S.applyTrade(s1, me, f.b, [f.player], [legY]);
    const r1 = S.rescore(s1, me, f.a), r2 = S.rescore(s2, me, f.b);
    const p1 = adapter.priceStep(f.a, [f.player], [legX]).p, p2 = adapter.priceStep(f.b, [legY], [f.player]).p;
    const e = pathExpectation([{ p: p1, delta: r1.me.title_delta }, { p: p2, delta: r2.me.title_delta, se: r2.me.title_delta_se }]);
    realised.push({ ...f, legs: { give_a: legX, get_b: legY, p1, p2, d1: r1.me.title_delta, d2: r2.me.title_delta,
      se2: r2.me.title_delta_se, clears2: r2.me.title_delta_clears_noise, ...e } });
  }
  const rankOf = f => {
    const r = realised.find(x => x.player === f.player && x.a === f.a && x.b === f.b && x.legs);
    return f.spread * (r ? r.legs.p1 * r.legs.p2 : 1) * Math.max(1, daysLeft) * (f.chat_hint ? 1.25 : 1);
  };
  const ranked = flips.map(f => ({ ...f, rank_score: rankOf(f) }))
    .sort((x, y) => (Number(y.clears) - Number(x.clears)) || (y.rank_score - x.rank_score));
  return { pairs: flips.length, clears: flips.filter(f => f.clears).length, top: ranked.slice(0, 10), realised };
}

/**
 * ACQ-01 path search for one target. Returns candidate plans with exact per-step metric deltas and
 * the per-step states (kept in memory for the confirm pass, dropped from the output).
 */
export function searchTarget(S, adapter, vals, objective, target, { maxGiveFinal = 3, shortlist = [8, 12, 8] } = {}) {
  const me = adapter.league.me;
  const P = adapter.players;
  const val = id => Math.max(0, Number(P.get(id)?.value) || 0);
  const owner = vals.lossO.get(target)?.team ?? S.ownerOf(new Map(), target);
  if (owner == null || owner === me) return [];
  const origMine = adapter.rosters.get(me);
  const partners = [...adapter.rosters.keys()].filter(id => id !== me && !adapter.managers.get(id)?.blocked
    && !adapter.managers.get(id)?.checked_out);
  const lin = state => linearNick(S.rosterOf(state, me), origMine, vals.addN, vals.lossN);
  const stepsFrom = (state, team, onlyGet = null, maxGive = 2) => {
    const mine = S.rosterOf(state, me).filter(vals.tradable);
    const theirs = onlyGet != null ? [onlyGet] : S.rosterOf(state, team).filter(vals.tradable);
    const out = [];
    for (const get of theirs) for (const give of combos(mine, maxGive)) {
      if (give.includes(onlyGet)) continue;
      if (!screenFair(give.reduce((s, id) => s + val(id), 0), val(get))) continue;
      out.push({ team, give, get: [get] });
    }
    return out;
  };
  const withP = (state, st) => ({ ...st, p: adapter.priceStep(st.team, st.get, st.give).p,
    state: S.applyTrade(state, me, st.team, st.give, st.get) });
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
  const pick = (list, n) => [...list.sort(byExp).slice(0, n), ...list.sort(byFinal).slice(0, Math.ceil(n / 2))];
  const seen = new Set();
  const short = [...pick(d1, shortlist[0]), ...pick(d2, shortlist[1]), ...pick(d3, shortlist[2])].filter(c => {
    const k = c.steps.map(dealKey).join('>');
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  return short.map(c => {
    const steps = c.steps.map(st => {
      const m = metricOf(S.rescore(st.state, me).me, objective);
      return { team: st.team, give: st.give, get: st.get, p: st.p, delta: m.delta, se: m.se, clears: m.clears, state: st.state };
    });
    return { target, owner, depth: steps.length, heuristic: c.e.expected, chained: isChained(steps), steps,
      ...pathExpectation(steps) };
  });
}

/** Drop the in-memory states from a plan before it is written. */
export function publicPlan(p) {
  if (!p) return null;
  const { steps, ...rest } = p;
  return { ...rest, steps: steps.map(({ state, ...s }) => s) };
}
