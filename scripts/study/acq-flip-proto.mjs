#!/usr/bin/env node
/**
 * ACQ-FLIP prototype (study only; serves nothing, writes nothing to the DB).
 *
 * Two questions, asked on one league state per league, in the fast-rescore
 * world (season-sim.js#tradeImpactWorld, RL-19-2), under one seed per league:
 *
 *   1. FLIP map. For every rostered player p on team A and every other
 *      league-mate B: what p is worth to A's title odds and to B's (move p from
 *      A to B and rescore), what each of them prices p at on today's
 *      counterparty model (counterparty-pricing.js#playerValuation), and whether
 *      Nick can stand in the middle with two legs that both look fair on each
 *      manager's own screen (FantasyCalc market value, the trade finder's own
 *      fairness window).
 *   2. ACQ planner. Pick Nick's best reachable upgrade target, then search
 *      1-3 step trade paths (direct, chip -> target, chip -> chip -> target) and
 *      score each by P(path completes) x Nick's title-odds gain, and by the full
 *      expectation that also counts the states where a later leg is declined.
 *      Compared against the served trade finder's single offers
 *      (title-odds-trades.js), in the same world and seeds.
 *
 * Every P(accept) here is today's model: trade-acceptance.js#acceptanceBand's
 * midpoint on readDeal's output. It is not fitted and is validated by nothing
 * beyond the receptiveness activity AUC (which is itself default-off). The edge
 * test is set to pass for every step, because an intermediate chip step is not
 * meant to be positive on its own; the served finder would print no band for it.
 *
 * Claims (free agents) are NOT searched: a world holding free agents has to be
 * built per deal (tradeImpactWorld's `universe` rule), which this prototype
 * does not pay for. Stated in the report.
 *
 * The scoring functions at the top are pure and exported (test/acq-flip-proto.test.js);
 * everything that reads the DB is loaded inside main().
 *
 * Usage (on a DB copy, never the live one):
 *   SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<copy> node scripts/study/acq-flip-proto.mjs \
 *     [--leagues 1,2,3] [--out <report.md>] [--json <out.json>] [--baseline-only]
 * The report names players (public) and team ids only; it contains league data
 * and must stay local.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/* --------------------------------------------------------------- pure scoring */

/** The trade finder's fairness window on the counterparty's side, in percent. */
export const SCREEN_WINDOW = Object.freeze({ low: -12, high: 18 });
/** A title-odds number is real only past this many standard errors (season-sim.js). */
export const NOISE_K = 2;

/**
 * How a deal reads on the counterparty's own market screen: what he gets minus
 * what he gives, as a percent of what he gives (FantasyCalc values).
 */
export function screenPct(theyGetValue, theyGiveValue) {
  if (!(theyGiveValue > 0)) return null;
  return ((theyGetValue - theyGiveValue) / theyGiveValue) * 100;
}

/** Whether a deal looks fair on his screen: inside the finder's window. */
export function screenFair(theyGetValue, theyGiveValue, window = SCREEN_WINDOW) {
  const pct = screenPct(theyGetValue, theyGiveValue);
  return pct != null && pct >= window.low && pct <= window.high;
}

/**
 * Score one path. `steps[i]` = { p: P(step i accepted | steps before it done),
 * delta: Nick's title-odds change vs today once steps 0..i are done }.
 *
 *   p_complete   = product of every p
 *   score        = p_complete x final delta (the spec's path score)
 *   expected     = sum over where the path stops: stopping after step j (j done,
 *                  j+1 declined) leaves Nick at delta_j (delta_{-1} = 0). This is
 *                  the honest number: a declined second leg strands the first.
 */
export function pathExpectation(steps) {
  if (!steps.length) return { p_complete: 0, delta_final: 0, score: 0, expected: 0, stranded: 0, expected_se: null };
  let reach = 1, expected = 0, stranded = 0, var_ = 0, seKnown = true;
  for (let i = 0; i < steps.length; i++) {
    const before = i === 0 ? 0 : steps[i - 1].delta;
    const stop = reach * (1 - steps[i].p);
    expected += stop * before;
    if (i > 0) {
      stranded += stop * before;
      if (steps[i - 1].se == null) seKnown = false; else var_ += (stop * steps[i - 1].se) ** 2;
    }
    reach *= steps[i].p;
  }
  const last = steps[steps.length - 1];
  expected += reach * last.delta;
  if (last.se == null) seKnown = false; else var_ += (reach * last.se) ** 2;
  // Monte Carlo SE of `expected` given the P(accept)s, treating each state's
  // paired SE as independent (they share seeds, so this is approximate).
  return { p_complete: reach, delta_final: last.delta, score: reach * last.delta, expected, stranded,
    expected_se: seKnown ? Math.sqrt(var_) : null };
}

/**
 * Whether a path is a real chain: some later step hands on a player an earlier
 * step brought in. A path whose steps never touch each other's players is just
 * several independent single offers sent in a row.
 */
export function isChained(steps) {
  const acquired = new Set();
  for (const s of steps) {
    if (s.give.some(id => acquired.has(id))) return true;
    for (const id of s.get) acquired.add(id);
  }
  return false;
}

/**
 * A flip spread: p moved from A to B changes B's title odds by dB and A's by
 * dA. The spread is dB + dA (what p is worth to B beyond what he is worth to
 * A). SE combines both paired SEs as if independent (the per-run indicators are
 * not exposed by tradeImpact); A and B cannot both win one run, so their
 * deltas' errors are not positively correlated and this does not understate it.
 */
export function flipSpread(dB, seB, dA, seA, k = NOISE_K) {
  const spread = dB + dA;
  const se = Math.sqrt((seB ?? 0) ** 2 + (seA ?? 0) ** 2);
  return { spread, se, clears: se > 0 && spread > k * se };
}

/**
 * Linear approximation of Nick's title-odds change from single-player values:
 * sum of what he gains for each outside player he ends with, plus what he loses
 * for each of his own players he no longer has. Used only to shortlist; every
 * shortlisted path is rescored exactly.
 */
export function linearNick(finalIds, originalIds, addValue, lossValue) {
  const orig = new Set(originalIds), fin = new Set(finalIds);
  let v = 0;
  for (const id of fin) if (!orig.has(id)) v += addValue.get(id) ?? 0;
  for (const id of orig) if (!fin.has(id)) v += lossValue.get(id) ?? 0;
  return v;
}

/** k-subsets of size 1..max of a list. */
export function combos(list, max = 2) {
  const out = list.map(x => [x]);
  if (max >= 2) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]]);
  return out;
}

/* -------------------------------------------------------------- study harness */

const pct = v => (v == null || !Number.isFinite(v) ? 'n/a' : `${(v * 100).toFixed(2)}%`);
const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);

function args(argv) {
  const out = { leagues: null, out: null, json: null, baselineOnly: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--leagues') out.leagues = argv[++i].split(',').map(Number);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--baseline-only') out.baselineOnly = true;
  }
  return out;
}

async function main() {
  process.env.SCHEDULER_DISABLED = '1';
  if (!process.env.GRIDIRON_DB_PATH) throw new Error('set GRIDIRON_DB_PATH to a DB copy');
  const opts = args(process.argv);
  const { rows, row } = await import('../../server/db/index.js');
  const sim = await import('../../server/services/season-sim.js');
  const { counterpartyLayer, readDeal, playerValuation } = await import('../../server/services/counterparty-pricing.js');
  const { pYesFor } = await import('../../server/services/p-yes.js');
  const { findTrades, tradeWeekContext } = await import('../../server/services/trade-engine.js');
  const { titleOddsTrades } = await import('../../server/services/title-odds-trades.js');
  const { tradeImpactWorld, tradeImpact, __test: { lineupPoints } } = sim;

  const leagues = rows('SELECT id, my_team_id, espn_s2 IS NOT NULL AS has_cookie FROM leagues ORDER BY id')
    .filter(l => !opts.leagues || opts.leagues.includes(l.id));
  const week = tradeWeekContext();
  const results = [];

  for (const L of leagues) {
    const t0 = Date.now();
    const lg = row('SELECT * FROM leagues WHERE id = ?', L.id);
    const meId = String(lg.my_team_id);
    const res = { league: L.id, me: meId, owner_mapping_present: !!L.has_cookie };
    let rescores = 0;

    /* ---- baseline: the served trade finder's single offers, same seed/runs ---- */
    const tb = Date.now();
    const served = titleOddsTrades(L.id, { teamId: meId });
    const found = findTrades(lg, { myTeamId: meId, requireMutual: true, limit: 8 * 3 });
    const bandFor = d => {
      const f = (found.deals ?? []).find(x => x.partner_id === d.partner_id
        && x.i_give.map(p => p.id).join() === d.i_give.map(p => p.id).join()
        && x.i_get.map(p => p.id).join() === d.i_get.map(p => p.id).join());
      return f?.acceptance?.band?.mid ?? null;
    };
    const singles = (served.deals ?? []).map(d => {
      const p = bandFor(d);
      return { partner: d.partner_id, give: d.i_give.map(x => x.name), get: d.i_get.map(x => x.name),
        delta: d.title_delta, se: d.title_delta_se, clears: d.title_delta_clears_noise, p,
        expected: p == null ? null : p * d.title_delta,
        expected_se: p == null || d.title_delta_se == null ? null : p * d.title_delta_se };
    });
    res.baseline = {
      ms: Date.now() - tb, considered: served.considered ?? 0, simulated: singles.length,
      top_by_title: singles[0] ?? null,
      best_expected: singles.filter(s => s.expected != null).sort((a, b) => b.expected - a.expected)[0] ?? null,
      deals: singles, error: served.error ?? null
    };
    if (opts.baselineOnly) { res.runtime_ms = Date.now() - t0; results.push(res); console.log(JSON.stringify({ league: L.id, baseline: res.baseline.best_expected, top: res.baseline.top_by_title })); continue; }

    /* ---- the world, and an exact rescore of any roster state ---- */
    const w = tradeImpactWorld(lg);
    if (w.fail) { res.error = 'world failed'; results.push(res); continue; }
    const assets = w.prep.assets;
    const teamPoints = players => {
      const out = new Map();
      for (const [wk, { byRun, expected }] of w.draws) {
        const arr = new Float64Array(w.runs);
        for (let run = 0; run < w.runs; run++) arr[run] = lineupPoints(players, w.prep.slots, byRun[run], expected);
        out.set(wk, arr);
      }
      return out;
    };
    const baseRoster = new Map(w.prep.teams.map(t => [t.roster_id, t.players.map(p => p.id)]));
    /** state: Map roster_id -> ids for changed teams only. Returns tradeImpact's me/them vs today. */
    const rescore = (state, a = meId, b = null) => {
      rescores++;
      const teams = w.prep.teams.map(t => state.has(t.roster_id)
        ? { ...t, players: state.get(t.roster_id).map(id => assets.get(id)).filter(Boolean) } : t);
      const points = new Map(w.points);
      for (const t of teams) if (state.has(t.roster_id)) points.set(t.roster_id, teamPoints(t.players));
      const other = b ?? [...state.keys()].find(id => id !== a) ?? teams.find(t => t.roster_id !== a).roster_id;
      const r = tradeImpact(lg, { myTeamId: a, theirTeamId: other, iGive: [], iGet: [], world: { ...w, prep: { ...w.prep, teams }, points } });
      if (r.error) throw new Error(r.error);
      return r;
    };
    const applyTrade = (state, x, y, xGives, yGives) => {
      const s = new Map(state);
      const rx = s.get(x) ?? baseRoster.get(x), ry = s.get(y) ?? baseRoster.get(y);
      const gx = new Set(xGives), gy = new Set(yGives);
      s.set(x, [...rx.filter(id => !gx.has(id)), ...yGives]);
      s.set(y, [...ry.filter(id => !gy.has(id)), ...xGives]);
      return s;
    };
    const rosterOf = (state, id) => state.get(id) ?? baseRoster.get(id);
    const ownerOf = (state, pid) => {
      for (const id of baseRoster.keys()) if (rosterOf(state, id).includes(pid)) return id;
      return null;
    };

    // Sanity: the composed rescore equals tradeImpact on the same one-for-one deal.
    {
      const other = w.prep.teams.find(t => t.roster_id !== meId);
      const give = baseRoster.get(meId).find(id => assets.get(id)?.value > 0);
      const get = baseRoster.get(other.roster_id).find(id => assets.get(id)?.value > 0);
      const direct = tradeImpact(lg, { myTeamId: meId, theirTeamId: other.roster_id, iGive: [give], iGet: [get], world: w });
      const composed = rescore(applyTrade(new Map(), meId, other.roster_id, [give], [get]), meId, other.roster_id);
      res.sanity_composed_equals_direct = direct.me.title_after === composed.me.title_after
        && direct.them.title_after === composed.them.title_after;
    }

    /* ---- today's counterparty model ---- */
    const cp = counterpartyLayer(L.id, { season: week.season, week: week.week });
    const blocked = new Set(rows(`SELECT roster_id FROM manager_profiles WHERE league_id = ? AND tradeability = 'never'`, L.id)
      .map(r => String(r.roster_id)));
    const val = id => Math.max(0, Number(assets.get(id)?.value) || 0);
    const slim = id => { const p = assets.get(id); return { id, name: p?.name, position: p?.position, value: p?.value }; };
    /** P(accept) of one step, his side: he gives theyGive, gets theyGet. Today's model, edge assumed passed. */
    const priceStep = (team, theyGive, theyGet) => {
      const m = cp.get(String(team)) ?? null;
      const counterparty = m
        ? { ...readDeal({ theirGive: theyGive.map(slim), theirGet: theyGet.map(slim), managerProfile: m }), counterparty_data: true }
        : { receptiveness: 1, perception_delta: null, counterparty_data: false };
      const band = pYesFor({ counterparty, edge: { passes: true }, profile: m?.negotiation ?? null });
      return { p: band.band?.mid ?? 0, basis: band.basis, informed: !!counterparty.perception_informed };
    };
    const priceOf = (team, id) => {
      const m = cp.get(String(team));
      const mult = m ? playerValuation(m, slim(id)).multiplier : 1;
      return { mult, price: val(id) * mult };
    };

    /* ---- single-player title values (exact rescores) ---- */
    const tv = Date.now();
    const tradable = id => SCORED.has(assets.get(id)?.position) && val(id) > 0;
    const addN = new Map(), lossO = new Map(), addSe = new Map();
    for (const [tid, ids] of baseRoster) {
      if (tid === meId) continue;
      for (const pid of ids.filter(tradable)) {
        const r = rescore(applyTrade(new Map(), meId, tid, [], [pid]), meId, tid);
        addN.set(pid, r.me.title_delta); addSe.set(pid, r.me.title_delta_se);
        lossO.set(pid, { team: tid, delta: r.them.title_delta, se: r.them.title_delta_se });
      }
    }
    const lossN = new Map();
    for (const pid of baseRoster.get(meId).filter(tradable)) {
      const s = new Map([[meId, baseRoster.get(meId).filter(id => id !== pid)]]);
      lossN.set(pid, rescore(s, meId).me.title_delta);
    }
    res.value_ms = Date.now() - tv;

    /* ---- 1. FLIP map ---- */
    const tf = Date.now();
    const flips = [];
    const topPer = 8;
    for (const [aId, ids] of baseRoster) {
      if (aId === meId) continue;
      const keyPlayers = ids.filter(tradable).sort((x, y) => val(y) - val(x)).slice(0, topPer);
      for (const pid of keyPlayers) {
        for (const bId of baseRoster.keys()) {
          if (bId === meId || bId === aId) continue;
          const r = rescore(applyTrade(new Map(), bId, aId, [], [pid]), bId, aId);
          const s = flipSpread(r.me.title_delta, r.me.title_delta_se, r.them.title_delta, r.them.title_delta_se);
          const pa = priceOf(aId, pid), pb = priceOf(bId, pid);
          flips.push({ player: pid, a: aId, b: bId, dB: r.me.title_delta, dA: r.them.title_delta,
            ...s, price_a: pa.price, price_b: pb.price, mult_a: pa.mult, mult_b: pb.mult,
            price_spread: pb.price - pa.price });
        }
      }
    }
    flips.sort((x, y) => y.spread - x.spread);
    const myIds = baseRoster.get(meId).filter(tradable);
    // Realise the biggest spreads with two screen-fair legs through Nick.
    const realised = [];
    for (const f of flips.filter(x => x.clears).slice(0, 12)) {
      if (blocked.has(f.a) || blocked.has(f.b)) continue;
      const pv = val(f.player);
      const legX = myIds.filter(x => screenFair(val(x), pv)).sort((x, y) => (lossN.get(y) ?? 0) - (lossN.get(x) ?? 0))[0];
      const legY = baseRoster.get(f.b).filter(tradable).filter(y => screenFair(pv, val(y)))
        .sort((x, y) => (addN.get(y) ?? 0) - (addN.get(x) ?? 0))[0];
      if (legX == null || legY == null) { realised.push({ ...f, legs: null, why: 'no screen-fair one-player leg' }); continue; }
      const s1 = applyTrade(new Map(), meId, f.a, [legX], [f.player]);
      const s2 = applyTrade(s1, meId, f.b, [f.player], [legY]);
      const r1 = rescore(s1, meId, f.a), r2 = rescore(s2, meId, f.b);
      const p1 = priceStep(f.a, [f.player], [legX]), p2 = priceStep(f.b, [legY], [f.player]);
      const e = pathExpectation([{ p: p1.p, delta: r1.me.title_delta }, { p: p2.p, delta: r2.me.title_delta }]);
      realised.push({ ...f, legs: { give_a: legX, get_b: legY, p1: p1.p, p2: p2.p,
        d1: r1.me.title_delta, d2: r2.me.title_delta, se2: r2.me.title_delta_se,
        clears2: r2.me.title_delta_clears_noise, ...e } });
    }
    res.flip = {
      ms: Date.now() - tf, pairs: flips.length, clears: flips.filter(f => f.clears).length,
      clears_positive_for_nick: realised.filter(x => x.legs?.clears2 && x.legs.d2 > 0).length,
      top: flips.slice(0, 10), realised
    };

    /* ---- 2. ACQ planner ---- */
    const tp = Date.now();
    const origMine = baseRoster.get(meId);
    const partners = [...baseRoster.keys()].filter(id => id !== meId && !blocked.has(id));
    // Candidate targets: the biggest single-player upgrades on Nick's title odds.
    const targets = [...addN.entries()].filter(([pid]) => !blocked.has(lossO.get(pid).team))
      .sort((x, y) => y[1] - x[1]).slice(0, 3).map(([pid]) => pid);
    const lin = state => linearNick(rosterOf(state, meId), origMine, addN, lossN);
    /** Nick's trades from `state`: he gives 1-2, gets 1 from `team`, fair on the team's screen. */
    const stepsFrom = (state, team, onlyGet = null) => {
      const mine = rosterOf(state, meId).filter(tradable);
      const theirs = onlyGet != null ? [onlyGet] : rosterOf(state, team).filter(tradable);
      const out = [];
      for (const get of theirs) for (const give of combos(mine, 2)) {
        if (give.includes(onlyGet)) continue;
        if (!screenFair(give.reduce((s, id) => s + val(id), 0), val(get))) continue;
        out.push({ team, give, get: [get] });
      }
      return out;
    };
    const plans = [];
    for (const target of targets) {
      const owner = lossO.get(target).team;
      const cands = [];
      // depth 1: direct
      for (const st of stepsFrom(new Map(), owner, target)) {
        const s1 = applyTrade(new Map(), meId, owner, st.give, st.get);
        const p1 = priceStep(owner, st.get, st.give).p;
        cands.push({ steps: [{ ...st, p: p1, state: s1 }], h: p1 * lin(s1) });
      }
      // depth 2 and 3: chip(s) then the target
      const chipLayer = (prefixes, maxGive = 2) => {
        const next = [];
        for (const pre of prefixes) {
          const state = pre.length ? pre[pre.length - 1].state : new Map();
          for (const team of partners) for (const st of stepsFrom(state, team)) {
            if (st.give.length > maxGive) continue;
            if (st.get[0] === target) continue;
            const s = applyTrade(state, meId, team, st.give, st.get);
            next.push([...pre, { ...st, p: priceStep(team, st.get, st.give).p, state: s }]);
          }
        }
        return next;
      };
      const finish = prefix => {
        const state = prefix[prefix.length - 1].state;
        let best = null;
        const own = ownerOf(state, target);
        if (own == null || own === meId) return null;
        for (const st of stepsFrom(state, own, target)) {
          const s = applyTrade(state, meId, own, st.give, st.get);
          const p = priceStep(own, st.get, st.give).p;
          const steps = [...prefix, { ...st, p, state: s }];
          const h = pathExpectation(steps.map(x => ({ p: x.p, delta: lin(x.state) }))).expected;
          if (!best || h > best.h) best = { steps, h };
        }
        return best;
      };
      const d2 = chipLayer([[]]).map(finish).filter(Boolean).sort((a, b) => b.h - a.h);
      const chips1 = d2.slice(0, 6).map(c => c.steps.slice(0, 1));
      const d3 = chipLayer(chips1, 1).map(finish).filter(Boolean).sort((a, b) => b.h - a.h);
      cands.sort((a, b) => b.h - a.h);
      const shortlist = [...cands.slice(0, 8), ...d2.slice(0, 12), ...d3.slice(0, 8)];
      const memo = new Map();
      const exact = state => {
        const k = JSON.stringify([...state.entries()].sort());
        if (!memo.has(k)) memo.set(k, rescore(state, meId).me);
        return memo.get(k);
      };
      for (const c of shortlist) {
        const ex = c.steps.map(st => { const m = exact(st.state); return { p: st.p, delta: m.title_delta, se: m.title_delta_se, clears: m.title_delta_clears_noise }; });
        const e = pathExpectation(ex);
        plans.push({ target, owner, depth: c.steps.length, heuristic: c.h, chained: isChained(c.steps),
          steps: c.steps.map((st, i) => ({ team: st.team, give: st.give, get: st.get, ...ex[i] })), ...e });
      }
    }
    plans.sort((a, b) => b.expected - a.expected);
    const best = plans[0] ?? null;
    // Fallback branch for the best plan: if its last step is declined, the best
    // other plan that shares every step before it (exact-rescored already).
    let fallback = null;
    if (best) {
      const prefixKey = p => JSON.stringify(p.steps.slice(0, best.steps.length - 1).map(s => [s.team, s.give, s.get]));
      fallback = plans.find(p => p !== best && p.depth === best.depth && prefixKey(p) === prefixKey(best)) ?? plans.find(p => p !== best) ?? null;
    }
    const bestBy = d => plans.filter(p => p.depth === d).sort((a, b) => b.expected - a.expected)[0] ?? null;
    res.acq = { ms: Date.now() - tp, targets, candidates_scored: plans.length, best, fallback,
      best_direct: bestBy(1), best_two: bestBy(2), best_three: bestBy(3),
      best_chained: plans.filter(p => p.chained).sort((a, b) => b.expected - a.expected)[0] ?? null };
    res.rescores = rescores;
    res.runtime_ms = Date.now() - t0;
    res.names = Object.fromEntries([...new Set([
      ...res.flip.top.map(f => f.player), ...res.flip.realised.flatMap(f => [f.player, f.legs?.give_a, f.legs?.get_b]),
      ...plans.slice(0, 5).flatMap(p => p.steps.flatMap(s => [...s.give, ...s.get])), ...targets,
      ...[res.acq.best_direct, res.acq.best_two, res.acq.best_three, res.acq.best_chained, fallback].filter(Boolean).flatMap(p => p.steps.flatMap(s => [...s.give, ...s.get]))
    ].filter(x => x != null))].map(id => [id, `${assets.get(id)?.name ?? id} (${assets.get(id)?.position ?? '?'})`]));
    results.push(res);
    console.log(JSON.stringify({ league: L.id, runtime_ms: res.runtime_ms, rescores, flips_clear: res.flip.clears,
      best_expected: best?.expected, best_depth: best?.depth, baseline_expected: res.baseline.best_expected?.expected }));
  }

  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(results, null, 1));
  if (opts.out && !opts.baselineOnly) fs.writeFileSync(opts.out, report(results));
}

/* ------------------------------------------------------------------- report */

function report(results) {
  const n = (r, id) => r.names?.[id] ?? `#${id}`;
  const stepTxt = (r, s) => `team ${s.team}: give ${s.give.map(id => n(r, id)).join(' + ')} for ${s.get.map(id => n(r, id)).join(' + ')}`
    + ` | P(accept) ${s.p.toFixed(2)} | title after ${pct(s.delta)} (SE ${pct(s.se)}${s.clears ? ', clears 2 SE' : ', inside noise'})`;
  const L = [];
  L.push('# ACQ-FLIP prototype (local copy, study only)', '');
  L.push(`Generated ${new Date().toISOString()} by scripts/study/acq-flip-proto.mjs on a local DB copy. Team ids only; player names are public.`, '');
  L.push('Every P(accept) below is **today\'s model, unvalidated beyond activity AUC** (trade-acceptance.js acceptanceBand midpoint; edge test assumed passed for every step). Title odds: tradeImpactWorld, one world and one seed per league, 1200 paired runs; deltas are vs today\'s rosters.', '');
  L.push('## Headline', '');
  L.push('| league | flip pairs | pairs clearing 2 SE | realised flips +Nick past 2 SE | best plan E[gain] ± SE (depth, chained?) | best 1-step E | best 2-step E | best 3-step E | best chained E | finder best single E | finder top-by-title delta x P | runtime s | rescores |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    if (r.error) { L.push(`| ${r.league} | error: ${r.error} |`); continue; }
    const a = r.acq, b = r.baseline;
    L.push(`| ${r.league} | ${r.flip.pairs} | ${r.flip.clears} | ${r.flip.clears_positive_for_nick} | ${pct(a.best?.expected)} ± ${pct(a.best?.expected_se)} (${a.best?.depth ?? '-'}, ${a.best?.chained ? 'chained' : 'independent steps'}) | ${pct(a.best_direct?.expected)} | ${pct(a.best_two?.expected)} | ${pct(a.best_three?.expected)} | ${pct(a.best_chained?.expected)} | ${pct(b.best_expected?.expected)} ± ${pct(b.best_expected?.expected_se)} | ${pct(b.top_by_title?.expected)} | ${(r.runtime_ms / 1000).toFixed(0)} | ${r.rescores} |`);
  }
  L.push('');
  for (const r of results) {
    if (r.error) continue;
    L.push(`## League ${r.league} (Nick = team ${r.me})`, '');
    L.push(`Composed rescore equals served tradeImpact on a probe deal: ${r.sanity_composed_equals_direct ? 'yes' : 'NO'}.`, '');
    L.push('### Flip map: biggest title-odds spreads (p moved from A to B)', '');
    L.push('| player | A | B | dB | dA | spread | SE | clears | A prices | B prices |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const f of r.flip.top) L.push(`| ${n(r, f.player)} | ${f.a} | ${f.b} | ${pct(f.dB)} | ${pct(f.dA)} | ${pct(f.spread)} | ${pct(f.se)} | ${f.clears ? 'yes' : 'no'} | ${f.price_a.toFixed(0)} (x${f.mult_a}) | ${f.price_b.toFixed(0)} (x${f.mult_b}) |`);
    L.push('', '### Flips realised through Nick (two screen-fair legs)', '');
    for (const f of r.flip.realised) {
      if (!f.legs) { L.push(`- ${n(r, f.player)} ${f.a} -> ${f.b}: ${f.why}`); continue; }
      const g = f.legs;
      L.push(`- ${n(r, f.player)}: buy from team ${f.a} for ${n(r, g.give_a)} (P ${g.p1.toFixed(2)}), sell to team ${f.b} for ${n(r, g.get_b)} (P ${g.p2.toFixed(2)}). Nick after leg 1 ${pct(g.d1)}, after both ${pct(g.d2)} (SE ${pct(g.se2)}${g.clears2 ? ', clears' : ', inside noise'}); P(both) ${g.p_complete.toFixed(3)}, E[gain] ${pct(g.expected)}.`);
    }
    L.push('', '### ACQ plan', '');
    L.push(`Candidate targets (biggest single-player title upgrades): ${r.acq.targets.map(id => n(r, id)).join(', ')}. Paths exact-rescored: ${r.acq.candidates_scored}.`, '');
    const plan = (label, p) => {
      if (!p) { L.push(`**${label}**: none found.`, ''); return; }
      L.push(`**${label}** (target ${n(r, p.target)} on team ${p.owner}, ${p.depth} step${p.depth > 1 ? 's' : ''}): P(complete) ${p.p_complete.toFixed(3)}, final delta ${pct(p.delta_final)}, P x delta ${pct(p.score)}, E[gain incl. stranded legs] ${pct(p.expected)} ± ${pct(p.expected_se)}; ${p.chained ? 'chained (a later step spends a player an earlier step bought)' : 'steps are independent offers (no player passes through)'}.`, '');
      p.steps.forEach((s, i) => L.push(`${i + 1}. ${stepTxt(r, s)}`));
      L.push('');
    };
    plan('Best plan', r.acq.best);
    plan('Fallback if its last step is declined', r.acq.fallback);
    if (r.acq.best?.depth !== 1) plan('Best direct (1 step)', r.acq.best_direct);
    if (r.acq.best?.depth !== 2) plan('Best 2-step', r.acq.best_two);
    if (r.acq.best?.depth !== 3) plan('Best 3-step', r.acq.best_three);
    if (!r.acq.best?.chained) plan('Best chained path (a player passes through Nick)', r.acq.best_chained);
    const b = r.baseline;
    L.push('### Served trade finder (baseline, same world and seed)', '');
    L.push(`${b.simulated} deals simulated of ${b.considered} considered.`, '');
    for (const d of b.deals.slice(0, 5)) L.push(`- team ${d.partner}: give ${d.give.join(' + ')} for ${d.get.join(' + ')} | delta ${pct(d.delta)} (SE ${pct(d.se)}${d.clears ? ', clears' : ''}) | served P(accept) ${d.p?.toFixed(2) ?? 'none (edge test)'} | E ${pct(d.expected)}`);
    L.push('');
  }
  return L.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
