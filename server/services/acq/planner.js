/**
 * ACQ-01: the "go get player X" planner.
 *
 * For each target (one Nick names, or the biggest single-player title upgrades
 * on other rosters), search the paths that end with Nick holding him:
 *
 *   direct      one offer to his owner: 1-for-1, 2-for-1 (Nick sends two whose
 *               summed value is screen-fair, IDEA-038) or 1-for-2 (the target
 *               plus a filler from the owner for one of Nick's)
 *   chip first  a claim or a trade with a third team, then the offer for the
 *               target, which may spend the chip (a flip through Nick)
 *
 * Every step carries P(yes) (the adapter's acceptance model, his side of the
 * deal) and Nick's title-odds change vs today once it and the steps before it
 * are done, rescored exactly on the adapter's one world. A path is scored by
 * its full expectation: a declined later step strands Nick at the earlier
 * step's odds, it does not reset him to today (pathExpectation). Each step of a
 * served plan names a backup: the best other scored path to the same target
 * that shares the steps before it, and what it is worth from there.
 *
 * Search is two-stage, because exact rescores are the cost (each replays the
 * season): A.quick(state), Nick's expected starting-lineup points, ranks every
 * candidate and shortlists the targets, then only the targets' gains and a
 * shortlist of paths are rescored exactly. The shortlist is taken per bucket (direct
 * 1-for-1, direct 2-for-1, direct 1-for-2, chip paths of 1-for-1s, chip paths
 * with a two-player side) and scored round-robin across targets and buckets, so the 1-for-1 arm is
 * always scored on its own merits and a budget cut trims every arm evenly.
 * That makes the IDEA-038 comparison (best path with a 2-for-1 vs best
 * 1-for-1-only path, same world, same seeds) a measurement, not a by-product.
 *
 * The adapter (world-adapter.js on a real league, a fake in the tests):
 *   me, teams[], blocked:Set, freeAgents[], roster(team) -> ids, value(id),
 *   tradable(id), quick(state) -> Nick's expected lineup points (cheap),
 *   rescore(state) -> { title_before, title_after, title_delta,
 *   title_delta_se, clears }, pAccept(team, theyGive, theyGet) -> { p, low, high, basis },
 *   claimP(id) -> { p, basis, reason? }, now() -> ms.
 * `state` is a Map team -> ids holding only the rosters that changed.
 *
 * Pure apart from the adapter: no DB, no I/O.
 */
import { fairBand, onesInBand, pairsInBand } from './value-band.js';

export const CLAIM_PARTNER = 'waivers';

export const PLAN_DEFAULTS = Object.freeze({
  maxTargets: 3, twoForOne: true, claims: true, chips: true,
  budgetMs: 240_000, maxRescores: 5000,
  chipLimit: 150, perBucket: 5, pairLimit: 60, fillers: 4, deck: 5, untouchables: []
});

export class BudgetExceeded extends Error {}

/**
 * Score one path. `steps[i]` = { p: P(step i accepted | the steps before it
 * done), delta: Nick's title-odds change vs today once steps 0..i are done,
 * se? }. `start` is where Nick stands before step 0 (0 = today).
 */
export function pathExpectation(steps, start = 0) {
  if (!steps.length) return { p_complete: 0, delta_final: start, expected: start, stranded: 0, expected_se: null };
  let reach = 1, expected = 0, stranded = 0, var_ = 0, seKnown = true;
  for (let i = 0; i < steps.length; i++) {
    const before = i === 0 ? start : steps[i - 1].delta;
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
  return { p_complete: reach, delta_final: last.delta, expected, stranded, expected_se: seKnown ? Math.sqrt(var_) : null };
}

/** Whether a later step hands on a player an earlier step brought in. */
export function isChained(steps) {
  const got = new Set();
  for (const s of steps) {
    if (s.give.some(id => got.has(id))) return true;
    for (const id of s.get) got.add(id);
  }
  return false;
}

export const shapeOf = s => (s.kind === 'claim' ? 'claim' : `${s.give.length}-for-${s.get.length}`);
/** A path the one-for-one search could have found: every trade step is 1-for-1. */
export const oneForOneOnly = steps => steps.every(s => s.kind === 'claim' || shapeOf(s) === '1-for-1');
const sig = s => `${s.kind}|${s.partner}|${[...s.give].sort().join('+')}>${[...s.get].sort().join('+')}`;

export function planAcquisition(A, opts = {}) {
  const o = { ...PLAN_DEFAULTS, ...opts };
  const t0 = A.now();
  const stats = { rescores: 0, rescore_ms: 0, quick: 0, truncated: null, candidates: 0, scored: 0, phases_ms: {} };
  const untouch = new Set(o.untouchables);
  const memo = new Map();
  const keyOf = s => JSON.stringify([...s.entries()].map(([k, v]) => [k, [...v].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0))])
    .sort((a, b) => (a[0] > b[0] ? 1 : -1)));
  const overBudget = () => {
    if (A.now() - t0 > o.budgetMs) throw new BudgetExceeded(`time budget ${o.budgetMs} ms spent`);
  };
  const rescore = s => {
    const k = keyOf(s);
    if (memo.has(k)) return memo.get(k);
    if (stats.rescores >= o.maxRescores) throw new BudgetExceeded(`rescore cap ${o.maxRescores} reached`);
    overBudget();
    stats.rescores++;
    const t = A.now();
    const r = A.rescore(s);
    stats.rescore_ms += A.now() - t;
    memo.set(k, r);
    return r;
  };

  const base = new Map(A.teams.map(t => [t, A.roster(t)]));
  const rosterOf = (s, t) => s.get(t) ?? base.get(t);
  const applyStep = (s, st) => {
    const n = new Map(s);
    const give = new Set(st.give), get = new Set(st.get);
    n.set(A.me, [...rosterOf(s, A.me).filter(x => !give.has(x)), ...st.get]);
    if (st.kind === 'trade') n.set(st.partner, [...rosterOf(s, st.partner).filter(x => !get.has(x)), ...st.give]);
    return n;
  };
  const partners = A.teams.filter(t => t !== A.me && !A.blocked.has(t));
  const orig = new Set(base.get(A.me));
  const phase = (name, fn) => { const t = A.now(); try { return fn(); } finally { stats.phases_ms[name] = A.now() - t; } };

  /* ---- 0. quick values: Nick's expected lineup points, no season replay ---- */
  // An exact rescore replays the season (~1 s or more on a real league), so it is
  // spent only on shortlisted paths and target gains. Every ranking before that
  // uses A.quick(state): Nick's expected starting-lineup points over the
  // simulated weeks, which is cheap and moves with the same roster changes.
  const qMemo = new Map();
  const q0 = A.quick(new Map());
  const lin = s => {
    const k = keyOf(s);
    if (!qMemo.has(k)) { stats.quick++; qMemo.set(k, A.quick(s) - q0); }
    return qMemo.get(k);
  };
  const addQ = new Map(), lossQ = new Map(), addN = new Map(), addSe = new Map();
  phase('quick_values', () => {
    for (const t of partners) for (const pid of base.get(t).filter(A.tradable)) {
      addQ.set(pid, lin(applyStep(new Map(), { kind: 'trade', partner: t, give: [], get: [pid] })));
    }
    for (const pid of base.get(A.me).filter(A.tradable)) lossQ.set(pid, lin(new Map([[A.me, base.get(A.me).filter(x => x !== pid)]])));
    if (o.claims) for (const fa of A.freeAgents) addQ.set(fa, lin(new Map([[A.me, [...base.get(A.me), fa]]])));
  });

  /* ---- targets: shortlisted on quick value, chosen on exact title value ---- */
  const ownerOfBase = pid => A.teams.find(t => base.get(t).includes(pid)) ?? null;
  const exactGain = pid => {
    const ow = ownerOfBase(pid);
    const r = rescore(applyStep(new Map(), { kind: 'trade', partner: ow, give: [], get: [pid] }));
    addN.set(pid, r.title_delta); addSe.set(pid, r.title_delta_se);
  };
  let targetIds = [];
  try {
    phase('targets', () => {
      if (o.target != null) {
        targetIds = [o.target];
        const ow = ownerOfBase(o.target);
        if (ow && ow !== A.me) exactGain(o.target);
        return;
      }
      const cands = [...addQ.keys()].filter(pid => { const ow = ownerOfBase(pid); return ow && ow !== A.me && !A.blocked.has(ow); })
        .sort((x, y) => addQ.get(y) - addQ.get(x)).slice(0, o.maxTargets * 2);
      for (const pid of cands) exactGain(pid);
      targetIds = cands.sort((x, y) => addN.get(y) - addN.get(x)).slice(0, o.maxTargets);
    });
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
    stats.truncated = `target values: ${e.message}`;
    stats.two_for_one = twoForOneSummary([]);
    return { targets: [], plans: [], deck: [], stats: finish(stats, A, t0), values: { addQ, lossQ, addN } };
  }

  /* ---- P(yes), cached ---- */
  const pCache = new Map();
  const price = st => {
    const k = sig(st);
    if (!pCache.has(k)) pCache.set(k, st.kind === 'claim' ? A.claimP(st.get[0]) : A.pAccept(st.partner, st.get, st.give));
    return pCache.get(k);
  };
  const item = id => ({ id, value: A.value(id) });
  const mineItems = s => rosterOf(s, A.me).filter(id => A.tradable(id) && !untouch.has(id)).map(item);

  /** Offers to `owner` from state `s` that end with Nick holding `target`. */
  const targetSteps = (s, owner, target, allow2) => {
    const mine = mineItems(s);
    const band = fairBand(A.value(target));
    const out = onesInBand(mine, band).map(give => ({ kind: 'trade', partner: owner, give, get: [target] }));
    if (!allow2) return out;
    for (const give of pairsInBand(mine, band, { limit: o.pairLimit })) out.push({ kind: 'trade', partner: owner, give, get: [target] });
    const fillers = rosterOf(s, owner).filter(id => id !== target && A.tradable(id))
      .sort((a, b) => (addQ.get(b) ?? 0) - (addQ.get(a) ?? 0)).slice(0, o.fillers);
    for (const f of fillers) {
      for (const give of onesInBand(mine, fairBand(A.value(target) + A.value(f)))) out.push({ kind: 'trade', partner: owner, give, get: [target, f] });
    }
    return out;
  };

  /** First steps that are not with the owner: trades with third teams, and claims. */
  const chipSteps = (owner, target, allow2) => {
    const mine = mineItems(new Map());
    const floor = A.value(target) * 0.25;
    const out = [];
    for (const t of partners) {
      if (t === owner) continue;
      for (const c of base.get(t).filter(id => A.tradable(id) && A.value(id) >= floor)) {
        const band = fairBand(A.value(c));
        for (const give of onesInBand(mine, band)) out.push({ kind: 'trade', partner: t, give, get: [c] });
        if (allow2) for (const give of pairsInBand(mine, band, { limit: 6 })) out.push({ kind: 'trade', partner: t, give, get: [c] });
      }
    }
    // Capped per shape: pair chips must not crowd the 1-for-1 chips out of the pool,
    // or the 1-for-1 arm would be searched on less than a 1-for-1-only search sees.
    const gain = st => A.value(st.get[0]) - st.give.reduce((x, id) => x + A.value(id), 0);
    const capped = xs => xs.sort((a, b) => gain(b) - gain(a)).slice(0, o.chipLimit);
    const kept = [...capped(out.filter(st => st.give.length === 1)), ...capped(out.filter(st => st.give.length > 1))];
    out.length = 0;
    out.push(...kept);
    if (o.claims && A.freeAgents.length) {
      // The cut: the player whose loss costs Nick least, cheapest first.
      const drop = mine.map(x => x.id).sort((a, b) => (lossQ.get(b) ?? 0) - (lossQ.get(a) ?? 0) || A.value(a) - A.value(b))[0];
      if (drop != null) for (const fa of A.freeAgents) out.push({ kind: 'claim', partner: CLAIM_PARTNER, give: [drop], get: [fa] });
    }
    return out;
  };

  const heuristic = steps => {
    let s = new Map();
    return pathExpectation(steps.map(st => { s = applyStep(s, st); return { p: price(st).p, delta: lin(s) }; })).expected;
  };

  /* ---- search: enumerate every target's candidates, then score round-robin ---- */
  const plans = [];
  const targets = [];
  const enumerate = () => {
    const out = [];
    for (const target of targetIds) {
      const owner = ownerOfBase(target);
      if (!owner || owner === A.me) { targets.push({ target, owner, error: owner === A.me ? 'already on your roster' : 'not on any roster' }); continue; }
      if (A.blocked.has(owner)) { targets.push({ target, owner, error: 'his owner does not trade' }); continue; }
      const buckets = { '1-for-1': [], '2-for-1': [], '1-for-2': [], 'chip-1for1': [], 'chip-2side': [] };
      for (const st of targetSteps(new Map(), owner, target, o.twoForOne)) {
        buckets[shapeOf(st)].push({ steps: [st], h: heuristic([st]) });
      }
      if (o.chips) {
        for (const chip of chipSteps(owner, target, o.twoForOne)) {
          overBudget();
          const s1 = applyStep(new Map(), chip);
          let best = null;
          for (const st of targetSteps(s1, owner, target, o.twoForOne)) {
            const h = heuristic([chip, st]);
            if (!best || h > best.h) best = { steps: [chip, st], h };
          }
          // The 1-for-1 arm keeps its own best finish, so it is never crowded out:
          // with it, the arm is exactly what a twoForOne:false search scores.
          if (o.twoForOne && best && !oneForOneOnly(best.steps) && oneForOneOnly([chip])) {
            let b1 = null;
            for (const st of targetSteps(s1, owner, target, false)) {
              const h = heuristic([chip, st]);
              if (!b1 || h > b1.h) b1 = { steps: [chip, st], h };
            }
            if (b1) buckets['chip-1for1'].push(b1);
          }
          if (best) buckets[oneForOneOnly(best.steps) ? 'chip-1for1' : 'chip-2side'].push(best);
        }
      }
      const lists = Object.values(buckets).map(l => { l.sort((a, b) => b.h - a.h); stats.candidates += l.length; return l.slice(0, o.perBucket); });
      targets.push({ target, owner, gain_if_landed: addN.get(target) ?? null, gain_se: addSe.get(target) ?? null,
        fair_direct: Object.fromEntries(Object.entries(buckets).map(([k, l]) => [k, l.length])) });
      out.push({ target, owner, lists });
    }
    return out;
  };
  // Round-robin over rank, then target, then bucket: a budget cut trims every
  // target and every arm evenly instead of starving the last target.
  const score = work => {
    const seen = new Set();
    for (let r = 0; r < o.perBucket; r++) {
      for (const { target, owner, lists } of work) {
        for (const l of lists) {
          const c = l[r];
          if (!c) continue;
          const k = c.steps.map(sig).join(' ; ');
          if (seen.has(k)) continue;
          seen.add(k);
          plans.push(scorePath(target, owner, c));
        }
      }
    }
  };
  const scorePath = (target, owner, c) => {
    let s = new Map();
    const steps = c.steps.map(st => {
      s = applyStep(s, st);
      const r = rescore(s), pr = price(st);
      return { ...st, shape: shapeOf(st), p: pr.p, low: pr.low ?? null, high: pr.high ?? null, basis: pr.basis ?? null,
        p_reason: pr.reason ?? null, delta: r.title_delta, se: r.title_delta_se ?? null, clears: !!r.clears,
        title_before: r.title_before, title_after: r.title_after };
    });
    stats.scored++;
    return { target, owner, steps, depth: steps.length, chained: isChained(steps), one_for_one_only: oneForOneOnly(steps),
      heuristic: c.h, ...pathExpectation(steps) };
  };
  try {
    const work = phase('enumerate', enumerate);
    phase('score', () => score(work));
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
    stats.truncated = `path search: ${e.message}`;
  }

  /* ---- rank, deck, backups ---- */
  const byExp = (a, b) => b.expected - a.expected || b.p_complete - a.p_complete;
  plans.sort(byExp);
  for (const t of targets) {
    const mine = plans.filter(p => p.target === t.target);
    t.best = mine[0] ?? null;
    t.p_reach = t.best?.p_complete ?? null;
    t.best_one_for_one = mine.find(p => p.one_for_one_only) ?? null;
    t.best_with_two = mine.find(p => !p.one_for_one_only) ?? null;
  }
  const deck = [];
  const firsts = new Set();
  for (const p of plans) {
    if (deck.length >= o.deck) break;
    const k = sig(p.steps[0]);
    if (firsts.has(k) || !(p.expected > 0)) continue;
    firsts.add(k);
    deck.push({ ...p, backups: p.steps.map((_, i) => backupFor(plans, p, i)) });
  }
  stats.two_for_one = twoForOneSummary(targets);
  return { targets, plans, deck, stats: finish(stats, A, t0), values: { addQ, lossQ, addN } };
}

/** Where Nick stands going into step i of `steps`, and what the rest is worth from there. */
export function continuationExpected(steps, i) {
  return pathExpectation(steps.slice(i), i === 0 ? 0 : steps[i - 1].delta).expected;
}

/**
 * If step i of `plan` is declined: the best other scored path to the same target
 * that shares steps 0..i-1 and differs at step i. Null when there is none.
 */
export function backupFor(plans, plan, i) {
  const prefix = plan.steps.slice(0, i).map(sig).join(' ; ');
  const declined = sig(plan.steps[i]);
  let best = null, bestV = -Infinity;
  for (const q of plans) {
    if (q === plan || q.target !== plan.target || q.steps.length <= i) continue;
    if (q.steps.slice(0, i).map(sig).join(' ; ') !== prefix || sig(q.steps[i]) === declined) continue;
    const v = continuationExpected(q.steps, i);
    if (v > bestV) { best = q; bestV = v; }
  }
  return best ? { plan: best, from_step: i, expected: bestV } : null;
}

/** IDEA-038 per target: the best path with a two-player side vs the best 1-for-1-only path. */
export function twoForOneSummary(targets) {
  const rows = targets.filter(t => !t.error).map(t => {
    const one = t.best_one_for_one, two = t.best_with_two;
    const gain = two && (one ? two.expected - one.expected : two.expected);
    const se = two && one && two.expected_se != null && one.expected_se != null
      ? Math.sqrt(two.expected_se ** 2 + one.expected_se ** 2) : two?.expected_se ?? null;
    return { target: t.target, fair_direct: t.fair_direct, best_one_for_one: one?.expected ?? null, best_with_two: two?.expected ?? null,
      gain: gain ?? null, gain_se: se, gain_clears_2se: gain != null && se != null && se > 0 && gain > 2 * se,
      one_for_one_finds_nothing: !one && !!two, best_is_two: !!(t.best && !t.best.one_for_one_only) };
  });
  return { rows, targets: rows.length, missed_by_one_for_one: rows.filter(r => r.best_is_two && (r.gain ?? 0) > 0).length,
    one_for_one_finds_nothing: rows.filter(r => r.one_for_one_finds_nothing).length };
}

function finish(stats, A, t0) { return { ...stats, runtime_ms: A.now() - t0 }; }
