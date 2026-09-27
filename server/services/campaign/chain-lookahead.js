/**
 * COACH-CHAIN lookahead (Nick 2026-09-26: "a trade is only as good as its next steps ... assuming X,
 * what is the best thing to do"). An expectimax over acceptance, three moves deep, on the War Room
 * plan's own world (the same seeded season runs for every branch: paired dice).
 *
 *   V_0(s) = the objective's value of roster state s (playoff odds for a playoffs league), one rescore
 *   V_L(s) = max( V_(L-1)(s),  max over moves m [ P(yes|m) * V_(L-1)(s after m) + (1 - P(yes|m)) * V_(L-1)(s) ] )
 *
 * P(yes|m) is the plan's own price (adapter.priceStep: p-yes.js, the planner's P(yes); a waiver claim's
 * is the league's claim-win rate). Moves at a node come from the planner's candidate search
 * (chain.js#fillsFor: search.js#searchTarget direct paths for the slots Nick is weakest in, plus flip
 * claims when the world simulates free agents; and PROTECTED-UPGRADE's tier-up moves for a protected player on
 * 'Blue chips only', each a "Needs your OK" move), each rule-checked at that node (never-give.js
 * #ruleVerdict with that node's own rise; STEP-REGRET: its own gain > 0) and pruned to the top K by
 * P(yes) x gain (K per depth: LOOKAHEAD_K). Moves found at shallower nodes stay in a shared pool, so a
 * deep node re-checks known moves instead of searching again. Every state is rescored once (the
 * scorer's memo). A player the chain brought in is never traded on.
 *
 * Pure except for the wall clock the adapter carries (adapter.now, league-adapter.mjs): past
 * `budgetMs` the search stops expanding and scores what is left at its current value (truncated: true).
 */
import { makeScorer } from './search.js';
import { ruleVerdict } from './never-give.js';
import { fillsFor, protectedMoves, findHole, read, metricKeyOf, metricGain, claimVerdict, publicMove } from './chain.js';
import { dealKey } from './paths.js';

/** Candidates kept per node, by depth from the node the search starts at (8-12 at the root). */
export const LOOKAHEAD_K = Object.freeze([8, 5, 3]);
/** Wall-time cap on the lookahead per chain (local CPU only); past it the search scores what is left as it stands. */
export const LOOKAHEAD_MS = 60_000;
/** Weak slots searched for moves at a node that searches (the weakest by league rank, below the median). */
export const LOOKAHEAD_SLOTS = 3;

const S = x => String(x);
const stateKey = st => JSON.stringify([...st.entries()].map(([k, v]) => [S(k), [...v].map(S).sort()]).sort());
const moveKey = m => m.legs.map(l => (l.claim ? `claim|${dealKey(l)}` : dealKey(l))).join('>');

/**
 * A lookahead over one league. ctx: { rules, objective, slots, flex, freeAgents, meKey, k?, budgetMs?, prefer? }.
 * -> { value(state, L), best(state, L), line(state, L), first(state, L, n), move(state, m), stats }
 */
export function makeLookahead(A, W, ctx) {
  const { rules, objective, slots, flex, freeAgents = [], meKey } = ctx;
  const K = ctx.k ?? LOOKAHEAD_K;
  const me = S(A.league.me);
  const base = makeScorer(W, A);
  const metric = metricKeyOf(objective);
  const clock = () => (typeof A.now === 'function' ? A.now() : 0);
  const t0 = clock();
  const budget = ctx.budgetMs ?? LOOKAHEAD_MS;
  const stats = { states: 0, searched_nodes: 0, candidates_checked: 0, truncated: false, runtime_ms: 0 };
  const start = new Set((A.rosters.get(meKey) ?? []).map(S));
  const late = () => { if (budget > 0 && clock() - t0 > budget) { stats.truncated = true; return true; } return false; };

  const reads = new Map();
  const readOf = st => {
    const k = stateKey(st);
    if (!reads.has(k)) { stats.states++; reads.set(k, read(base.rescore(st, meKey).me)); }
    return reads.get(k);
  };
  const valueOfRead = r => (metric === 'points' ? r.lineup : metric === 'playoff' ? r.playoff : r.title);

  /** A move is still possible in `st`: every leg's gives are held by the giver, and nothing given was brought in by the chain. */
  const applicable = (st, m) => {
    let next = st;
    for (const leg of m.legs) {
      const mine = base.rosterOf(next, meKey);
      if (!leg.give.every(id => mine.includes(id))) return null;
      if (!leg.claim && leg.give.some(id => !start.has(S(id)) && !m.legs.some(l => l.claim && l.get.map(S).includes(S(id))))) return null;
      if (leg.claim) { next = base.applyClaim(next, meKey, leg.give, leg.get); continue; }
      const theirs = base.rosterOf(next, leg.team);
      if (!leg.get.every(id => theirs.includes(id))) return null;
      next = base.applyTrade(next, meKey, leg.team, leg.give, leg.get);
    }
    return next;
  };

  const prices = new Map();
  const pOf = m => {
    const k = moveKey(m);
    if (!prices.has(k)) {
      const trade = m.legs.at(-1);
      const claim = m.legs.find(l => l.claim);
      const pr = typeof A.priceStep === 'function' ? A.priceStep(trade.team, trade.get, trade.give) : null;
      const pt = Number.isFinite(pr?.p) ? pr.p : null;
      // A flip claim needs the claim AND the trade: the claim's own p (the league's claim-win rate) times the trade's.
      const p = pt == null ? null : claim ? pt * (Number.isFinite(m.claim_p) ? m.claim_p : 0) : pt;
      prices.set(k, { p, basis: pr?.basis ?? pr?.band?.basis ?? null });
    }
    return prices.get(k);
  };

  /** One move at one state: its numbers there and Nick's rules on it. null when it cannot be made there. */
  const evaluate = (st, m) => {
    const next = applicable(st, m);
    if (!next) return null;
    stats.candidates_checked++;
    const before = readOf(st), after = readOf(next);
    const d = { lineup: after.lineup - before.lineup, playoff: after.playoff - before.playoff, title: after.title - before.title };
    const trade = m.legs.at(-1);
    const v = ruleVerdict(rules, { give: trade.give, get: trade.get, premium: { points_delta: d.lineup, title_delta: d.title },
      rises: { points_delta: d.lineup, playoff_delta: d.playoff } });
    const cv = m.legs.some(l => l.claim) ? claimVerdict(A, rules, m.legs) : { ok: true, reasons: [] };
    const { p, basis } = pOf(m);
    return { m, next, d, gain: metricGain(objective, d), p, basis, ok: v.ok && cv.ok && p != null, needs_ok: !!v.requires_nick_confirm };
  };

  // The shared pool of moves the searches found, and each state's own searched list.
  const pool = new Map();
  const searched = new Map();
  const search = st => {
    const k = stateKey(st);
    if (searched.has(k)) return searched.get(k);
    stats.searched_nodes++;
    const rostersAfter = new Map([...A.rosters].map(([t, ids]) => [t, st.get(t) ?? ids]));
    const hole = findHole({ rosters: rostersAfter, players: A.players, me, slots, flex, freeAgents, prefer: ctx.prefer ?? null });
    const weak = (hole?.slots ?? []).filter(r => r.gap_to_median < 0).sort((a, b) => (b.rank / b.of - a.rank / a.of) || (a.gap_to_median - b.gap_to_median));
    const seen = new Set();
    const holes = [hole, ...weak].filter(h => h && !seen.has(h.label) && seen.add(h.label)).slice(0, LOOKAHEAD_SLOTS);
    const found = [];
    const add = x => {
      const claimLeg = x.steps.find(s => s.claim);
      const m = { legs: x.legs, kind: x.kind, heur: (x.p ?? 0) * x.metric_gain, ...(claimLeg ? { claim_p: claimLeg.p } : {}) };
      const key = moveKey(m);
      if (!pool.has(key) || pool.get(key).heur < m.heur) pool.set(key, m);
      found.push(pool.get(key));
    };
    for (const h of holes) {
      if (late()) break;
      fillsFor(A, W, st, h, { rules, objective, prev: readOf(st), fills: K[0], targets: 3, meKey }).fills.forEach(add);
    }
    // PROTECTED-UPGRADE: a protected player on 'Blue chips only' for a true tier up (every such move needs Nick's OK).
    if (!late()) protectedMoves(A, W, st, { rules, objective, prev: readOf(st), meKey }).slice(0, K[0]).forEach(add);
    searched.set(k, found);
    return found;
  };

  /** The top moves at a state, depth `level` from the search's start: searched there when shallow, the pool below. */
  const movesMemo = new Map();
  const movesAt = (st, level) => {
    const k = `${stateKey(st)}|${level}`;
    if (movesMemo.has(k)) return movesMemo.get(k);
    const own = level <= 1 ? search(st) : [];
    const keys = new Set();
    const cands = [...own, ...[...pool.values()].sort((a, b) => b.heur - a.heur)]
      .filter(m => { const mk = moveKey(m); if (keys.has(mk)) return false; keys.add(mk); return true; });
    const kN = K[Math.min(level, K.length - 1)];
    const out = [];
    for (const m of cands) {
      if (out.length >= kN * 2 || late()) break;
      const e = evaluate(st, m);
      if (e && e.ok && e.gain > 0) out.push(e);
    }
    out.sort((a, b) => b.p * b.gain - a.p * a.gain || b.gain - a.gain);
    const top = out.slice(0, kN);
    movesMemo.set(k, top);
    return top;
  };

  const memo = new Map();
  /** V_L(st), with the move that attains it: { value, move: evaluated move | null, next: V of the yes branch }. */
  const best = (st, L, level = 0) => {
    const k = `${stateKey(st)}|${L}`;
    if (memo.has(k)) return memo.get(k);
    let out;
    if (L <= 0 || late()) out = { value: valueOfRead(readOf(st)), move: null, next: null };
    else {
      const wait = best(st, L - 1, level + 1);
      out = { value: wait.value, move: null, next: null, wait };
      for (const e of movesAt(st, level)) {
        const yes = best(e.next, L - 1, level + 1);
        const v = e.p * yes.value + (1 - e.p) * wait.value;
        if (v > out.value) out = { value: v, move: e, next: yes, wait };
      }
    }
    memo.set(k, out);
    return out;
  };

  const lineOf = b => {
    const out = [];
    for (let x = b; x; x = x.move ? x.next : x.wait) if (x.move) out.push(x.move);
    return out;
  };
  const publicOf = e => {
    const trade = e.m.legs.at(-1);
    const claim = e.m.legs.find(l => l.claim);
    return { ...publicMove({ team: trade.team, give: trade.give, get: trade.get, ...(claim ? { via_claim: { ...claim, team: 'free_agent' } } : {}) }),
      kind: e.m.kind, p: e.p, p_basis: e.basis, needs_ok: e.needs_ok };
  };

  /** The first moves at `st`, ranked by continuation value: p * V_(L-1)(after) + (1 - p) * V_(L-1)(st). */
  const first = (st, L, n = 5) => {
    const wait = best(st, L - 1, 1);
    return movesAt(st, 0).map(e => {
      const yes = best(e.next, L - 1, 1);
      return { move: publicOf(e), now: valueOfRead(readOf(e.next)), if_yes: yes.value, cont: e.p * yes.value + (1 - e.p) * wait.value,
        now_se: metric === 'playoff' ? readOf(e.next).playoff_se : metric === 'points' ? readOf(e.next).lineup_se : null,
        line: [publicOf(e), ...lineOf(yes).map(publicOf)], legs: e.m.legs };
    }).sort((a, b) => b.cont - a.cont).slice(0, n);
  };

  /** Nick's own move m at `st` in the same terms (m: { legs, claim_p? }). null when it cannot be made there. */
  const yours = (st, m, L) => {
    const next = applicable(st, m);
    if (!next) return null;
    const { p } = pOf(m);
    const wait = best(st, L - 1, 1);
    const yes = best(next, L - 1, 1);
    return { now: valueOfRead(readOf(next)), if_yes: yes.value, cont: p == null ? null : p * yes.value + (1 - p) * wait.value, p,
      line: lineOf(yes).map(publicOf), legs: lineOf(yes).map(e => e.m.legs) };
  };

  return {
    value: st => valueOfRead(readOf(st)), best, first, yours, line: (st, L) => lineOf(best(st, L)).map(e => ({ move: publicOf(e), legs: e.m.legs })),
    stats: () => ({ ...stats, runtime_ms: clock() - t0, pool: pool.size, k: [...K], metric }),
  };
}
