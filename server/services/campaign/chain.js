/**
 * COACH-CHAIN: "after this move, what's the next move to fill the hole" (Nick 2026-09-26: "getting me
 * ok after we have this move lets go trade for this player to fill this hole").
 *
 * chain(adapter, moves, ctx) applies Nick's hypothetical moves IN SEQUENCE to a copy of the league's
 * rosters (a Map of changed teams, never the adapter's own rosters) and returns, per step:
 *   - lineup points per week and playoff odds after the step, from the campaign world's rescore (the
 *     same season-sim.js#tradeImpact dice and seed the War Room plan is scored on: adapter.world(adapter.seed));
 *   - the step's own change and the change against doing nothing;
 *   - Nick's rules on the step (never-give.js#ruleVerdict, the ONE rules module; a protected player
 *     that may move only on a true tier up makes the step "Needs your OK");
 *   - the new HOLE: Nick's weakest starting slot against the same slot on every other team in the
 *     league (rest-of-season points per game), with its gap to the league's median starter there and
 *     to a replacement-level starter (the best free agent who can play the slot);
 *   - the top follow-up candidates that fill it: one-trade paths from the planner's own search
 *     (search.js#searchTarget, direct paths only, restricted to players who play the slot and beat
 *     today's starter there) and, when the adapter carries a claim universe (SEARCH-WIDE's world), flip
 *     claims (claim a free agent, then trade him on for the filler: search-wide.js's claim rules).
 *     Every candidate passes ruleVerdict and beats doing nothing given the steps before it (STEP-REGRET).
 * With ctx.extend on, the chain continues with the best fill until it is CHAIN_MAX_STEPS long.
 *
 * Pure: no DB, no env, no clock. The runner (coach/chain-engine.js, in the Coach engine worker) builds
 * the adapter (scripts/campaign/league-adapter.mjs#buildAdapter), the rules (never-give.js#ruleGate),
 * the lineup slots (trade-engine.js#lineupSlots) and the objective, and hands them in.
 */
import { makeScorer, searchTarget, SCORED } from './search.js';
import { metricOf } from './objectives.js';
import { ruleVerdict, overpayCheck, withNeverGive } from './never-give.js';
import { excluded } from './partners.js';
import { screenFair, dealKey } from './paths.js';
import { claimPoolOf, claimProbability, claimRule, makeDropOk, pickDrop, FREE_AGENT } from './search-wide.js';
import { BLUE_CHIP_SCORE } from './search.js';
import { makeLookahead } from './chain-lookahead.js';
import { tierUpGets } from './protected-upgrade.js';

export const CHAIN_MAX_STEPS = 3;
export const CHAIN_FILLS = 3;
/** Players searched per hole (the best by rest-of-season points who play the slot). */
export const CHAIN_TARGETS = 5;
/** Free agents tried as flip-claim pieces per hole. */
export const CHAIN_CLAIM_POOL = 4;

const S = x => String(x);
const num = x => (Number.isFinite(Number(x)) ? Number(x) : null);
const medianOf = xs => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};
/** The rules' score reader (id -> number) in the shape gets-floor.js#floorRead reads (id -> { score }). */
const scoreRow = rules => id => { const v = rules.scoreOf(id); return v == null ? null : { score: v }; };
export function merge(a, b) { const m = new Map(a); for (const [k, v] of b) m.set(k, v); return m; }

/**
 * One team's starters slot by slot, by rest-of-season points per game: dedicated slots first in slot
 * order, then flex slots (the order season-sim.js#lineupStarters picks in). slots: trade-engine.js
 * #lineupSlots; flex: trade-engine.js#FLEX_ELIGIBLE. -> [{ slot, label, positions, id, position, ppg }]
 */
export function slotLineup(players, slots, flex) {
  const pool = players.filter(p => p && SCORED.has(p.position)).sort((a, b) => (num(b.ros_ppg) ?? 0) - (num(a.ros_ppg) ?? 0));
  const seen = {};
  const out = slots.map(slot => {
    seen[slot] = (seen[slot] ?? 0) + 1;
    const many = slots.filter(s => s === slot).length > 1;
    return { slot, label: many ? `${slot}${seen[slot]}` : slot, positions: SCORED.has(slot) ? [slot] : flex[slot] ?? [], id: null, position: null, ppg: 0 };
  });
  const used = new Set();
  const take = (i, ok) => {
    const p = pool.find(x => !used.has(x.id) && ok.includes(x.position));
    if (p) { used.add(p.id); Object.assign(out[i], { id: p.id, position: p.position, ppg: num(p.ros_ppg) ?? 0 }); }
  };
  slots.forEach((slot, i) => { if (SCORED.has(slot)) take(i, [slot]); });
  slots.forEach((slot, i) => { if (flex[slot]) take(i, flex[slot]); });
  return out.filter(o => o.positions.length);
}

/**
 * Nick's weakest starting slot against the league. Every team's lineup is read slot by slot; Nick's
 * slot i is ranked against every team's slot i (1 = best). The hole is the slot he ranks lowest in;
 * a tie goes to the one furthest under the league's median starter there.
 * -> { label, slot, positions, player, position, ppg, rank, of, league_median, gap_to_median,
 *      replacement: { player, ppg } | null, gap_to_replacement, slots: [every slot's row] } | null
 */
export function findHole({ rosters, players, me, slots, flex, freeAgents = [], prefer = null }) {
  const lineups = new Map([...rosters].map(([t, ids]) => [S(t), slotLineup(ids.map(id => players.get(id)).filter(Boolean), slots, flex)]));
  const mine = lineups.get(S(me));
  if (!mine?.length) return null;
  const rows = mine.map((s, i) => {
    const league = [...lineups.values()].map(l => l[i]?.ppg ?? 0);
    const median = medianOf(league);
    const repl = freeAgents.filter(f => s.positions.includes(f.position) && num(f.ros_ppg) != null)
      .sort((a, b) => b.ros_ppg - a.ros_ppg)[0] ?? null;
    return { label: s.label, slot: s.slot, positions: s.positions, player: s.id == null ? null : S(s.id), position: s.position, ppg: s.ppg,
      rank: 1 + league.filter(v => v > s.ppg).length, of: league.length, league_median: median, gap_to_median: s.ppg - median,
      replacement: repl ? { player: S(repl.id), ppg: num(repl.ros_ppg) } : null, gap_to_replacement: repl ? s.ppg - num(repl.ros_ppg) : null };
  });
  // Nick named a position ("who fills RB?"): the weakest slot that position starts in.
  const asked = prefer ? rows.filter(r => r.slot === prefer) : [];
  const pool = asked.length ? asked : prefer ? rows.filter(r => r.positions.includes(prefer)) : rows;
  const worst = [...(pool.length ? pool : rows)].sort((a, b) => (b.rank / b.of - a.rank / a.of) || (a.gap_to_median - b.gap_to_median))[0];
  return { ...worst, slots: rows };
}

/**
 * Nick's starting lineup slot by slot, with the best free agent who could start in each slot beside it
 * (each free agent used once, best slot first). `fa_would_start`: that free agent out-scores the starter,
 * so the season sim (which starts only rostered players) under-counts that slot by `fa_gain`. An empty
 * slot shows player null and ppg 0. -> [{ label, slot, player, position, ppg, fa: { player, ppg } | null, fa_would_start, fa_gain }]
 */
export function lineupTable(ids, players, slots, flex, freeAgents = []) {
  const rows = slotLineup(ids.map(id => players.get(id)).filter(Boolean), slots, flex);
  const used = new Set();
  return rows.map(r => {
    const fa = freeAgents.filter(f => r.positions.includes(f.position) && !used.has(S(f.id)) && num(f.ros_ppg) != null)
      .sort((a, b) => b.ros_ppg - a.ros_ppg)[0] ?? null;
    const starts = !!fa && num(fa.ros_ppg) > r.ppg;
    if (starts) used.add(S(fa.id));
    return { label: r.label, slot: r.slot, player: r.id == null ? null : S(r.id), position: r.position, ppg: r.ppg,
      fa: fa ? { player: S(fa.id), ppg: num(fa.ros_ppg) } : null, fa_would_start: starts, fa_gain: starts ? num(fa.ros_ppg) - r.ppg : 0 };
  });
}

/** A move as the chain reads it: a trade { team, give, get } or a claim { claim: true, give: [drop], get: [add] }. */
function normMove(m) {
  const ids = xs => (Array.isArray(xs) ? xs : xs == null ? [] : [xs]).map(S);
  return { team: m.claim ? FREE_AGENT : S(m.team), give: ids(m.give ?? m.drop), get: ids(m.get ?? m.add), ...(m.claim ? { claim: true } : {}),
    ...(m.source ? { source: m.source } : {}) };
}

/** The numbers after one state: lineup points per week, playoff and title odds (a rescore's `me`). */
export function read(me) {
  return { lineup: num(me.points_before) + num(me.points_delta ?? 0), lineup_se: num(me.points_delta_se),
    playoff: num(me.playoff_after), playoff_se: num(me.playoff_delta_se), title: num(me.title_after) };
}

/**
 * The chain. adapter: the campaign adapter (league-adapter.mjs#buildAdapter; test/fixtures fakes it).
 * moves: [{ team, give: ids, get: ids }] or claims [{ claim: true, drop, add }], Nick's order.
 * ctx: { rules (ruleGate(...).rules), slots, flex, objective, freeAgents?, fills?, targets?, extend? (default true),
 *   maxSteps? (<= CHAIN_MAX_STEPS), prefer? (a position Nick named: the hole is read at that position) }.
 */
export function chain(adapter, moves, ctx) {
  const { rules, slots, flex, objective } = ctx;
  const maxSteps = Math.min(CHAIN_MAX_STEPS, ctx.maxSteps ?? CHAIN_MAX_STEPS);
  const extend = ctx.extend !== false;
  const A = withNeverGive(adapter);
  const me = S(A.league.me);
  const meKey = [...A.rosters.keys()].find(k => S(k) === me);
  // Replacement level reads the whole free-agent pool by position (the runner passes it: the world's own
  // asset universe, league-adapter.mjs#freeAgentPool); adapter.freeAgents is only the top 40 overall.
  const freeAgents = ctx.freeAgents ?? A.freeAgents ?? [];
  const W = A.world(A.seed);
  if (!W || W.fail) return { error: `world failed: ${W?.fail ?? 'no world'}` };
  const base = makeScorer(W, A);
  const nothing = read(base.rescore(new Map(), meKey).me);
  const idOf = s => [...A.players.keys()].find(k => S(k) === S(s)) ?? null;
  const teamKey = t => [...A.rosters.keys()].find(k => S(k) === S(t)) ?? null;
  const steps = [];
  let state = new Map();
  let prev = nothing;
  let stopped = null;
  const queue = (moves ?? []).slice(0, maxSteps).map(m => ({ ...normMove(m), source: 'you' }));
  // LOOKAHEAD (chain-lookahead.js): the chain after Nick's moves is the expectimax line, not the greedy fill.
  const LA = ctx.lookahead === false ? null : makeLookahead(A, W, { rules, objective, slots, flex, freeAgents, meKey,
    k: ctx.k, budgetMs: ctx.budgetMs, prefer: ctx.prefer ?? null });
  let planned = null;
  for (let k = 0; k < maxSteps; k++) {
    let mv = queue[k] ?? null;
    if (!mv && LA && extend && !steps.some(s => s.error)) {
      planned ??= LA.line(state, maxSteps - k);
      const next = planned.shift();
      if (!next) { stopped = stopped ?? 'no next move beats doing nothing inside your rules'; break; }
      const trade = next.legs.at(-1), claim = next.legs.find(l => l.claim);
      mv = { team: S(trade.team), give: trade.give.map(S), get: trade.get.map(S), source: 'suggested',
        ...(claim ? { via_claim: { claim: true, team: FREE_AGENT, give: claim.give.map(S), get: claim.get.map(S) } } : {}) };
    }
    if (!mv) {
      const last = steps[steps.length - 1];
      if (!extend || !last || LA) break;
      const best = (last.fills ?? []).find(f => f.rules.ok && f.metric_gain > 0);
      if (!best) { stopped = stopped ?? (last.fills_status === 'ok' ? 'no follow-up fills the hole inside your rules' : last.fills_status); break; }
      // A flip claim is two moves (claim, then the trade); it counts as one step of the chain.
      mv = { ...best.steps[best.steps.length - 1], source: 'suggested', ...(best.kind === 'flip_claim' ? { via_claim: best.steps[0] } : {}) };
    }
    const legs = mv.via_claim ? [mv.via_claim, mv] : [mv];
    let next = state;
    let bad = null;
    for (const leg of legs) {
      const mine = base.rosterOf(next, meKey).map(S);
      const give = leg.give.map(idOf), get = leg.get.map(idOf);
      if (give.some(x => x == null) || get.some(x => x == null)) { bad = 'a player in this move is not in the league'; break; }
      if (!leg.give.every(id => mine.includes(id))) { bad = `you would no longer have ${leg.give.filter(id => !mine.includes(id)).join(', ')} at this step`; break; }
      if (leg.claim) { next = base.applyClaim(next, meKey, give, get); continue; }
      const tk = teamKey(leg.team);
      if (tk == null || S(tk) === me) { bad = 'the partner is not another team in the league'; break; }
      const theirs = base.rosterOf(next, tk).map(S);
      if (!leg.get.every(id => theirs.includes(id))) { bad = `the partner would not have ${leg.get.filter(id => !theirs.includes(id)).join(', ')} at this step`; break; }
      next = base.applyTrade(next, meKey, tk, give, get);
    }
    if (bad) { steps.push({ index: k + 1, source: mv.source, move: publicMove(mv), error: bad }); stopped = bad; break; }
    const tk = mv.claim ? null : teamKey(mv.team);
    const now = read(base.rescore(next, meKey, tk).me);
    const d = { lineup: now.lineup - prev.lineup, playoff: now.playoff - prev.playoff, title: now.title - prev.title };
    const traded = mv.claim ? null : ruleVerdict(rules, { give: mv.give, get: mv.get,
      premium: { points_delta: d.lineup, title_delta: d.title }, rises: { points_delta: d.lineup, playoff_delta: d.playoff } });
    const claimed = mv.claim || mv.via_claim ? claimVerdict(A, rules, legs) : null;
    const verdict = !traded ? claimed : !claimed ? traded
      : { ...traded, ok: traded.ok && claimed.ok, reasons: [...traded.reasons, ...claimed.reasons] };
    const priced = !mv.claim && typeof A.priceStep === 'function' ? A.priceStep(tk, mv.get.map(idOf), mv.give.map(idOf)) : null;
    const gain = metricGain(objective, d);
    const step = {
      index: k + 1, source: mv.source, move: publicMove(mv),
      p: priced ? { value: num(priced.p), basis: priced.basis ?? priced.band?.basis ?? null } : null,
      lineup: { after: now.lineup, step_delta: d.lineup, total_delta: now.lineup - nothing.lineup, total_se: now.lineup_se },
      playoff: { after: now.playoff, step_delta: d.playoff, total_delta: now.playoff - nothing.playoff, total_se: now.playoff_se },
      title: { after: now.title, step_delta: d.title, total_delta: now.title - nothing.title },
      rules: { ok: verdict.ok, reasons: verdict.reasons, needs_ok: !!verdict.requires_nick_confirm, ...(verdict.protected ? { protected: verdict.protected } : {}) },
      metric_gain: gain, beats_previous: gain > 0,
    };
    state = next;
    prev = now;
    const rostersAfter = new Map([...A.rosters].map(([t, ids]) => [t, state.get(t) ?? ids]));
    step.hole = findHole({ rosters: rostersAfter, players: A.players, me, slots, flex, freeAgents, prefer: ctx.prefer ?? null });
    // The whole lineup after the step, slot by slot (both FLEX spots), with what the free-agent pool would add.
    step.lineup_slots = lineupTable(rostersAfter.get(meKey) ?? [], A.players, slots, flex, freeAgents);
    step.roster = { size: (rostersAfter.get(meKey) ?? []).length, before: (A.rosters.get(meKey) ?? []).length };
    if (k + 1 >= maxSteps) { step.fills = []; step.fills_status = `the chain stops at ${maxSteps} steps`; }
    else if (!step.hole) { step.fills = []; step.fills_status = 'no lineup to read a hole from'; }
    else {
      const f = fillsFor(A, W, state, step.hole, { rules, objective, prev: now, fills: ctx.fills ?? CHAIN_FILLS, targets: ctx.targets ?? CHAIN_TARGETS, meKey });
      step.fills = f.fills; step.fills_status = f.status; step.fills_searched = f.searched; step.reach = f.reach ?? null;
      step.claims = f.claims ?? null;
    }
    steps.push(step);
  }
  const last = steps.filter(s => !s.error).at(-1) ?? null;
  const look = LA ? lookaheadBlock(LA, { steps, queue, maxSteps, idOf, teamKey }) : null;
  return {
    league: S(A.league.id), me, seed: A.seed, goal: objective.goal ?? null, metric: metricKeyOf(objective),
    nothing: { lineup: nothing.lineup, playoff: nothing.playoff, title: nothing.title,
      hole: findHole({ rosters: A.rosters, players: A.players, me, slots, flex, freeAgents }),
      lineup_slots: lineupTable(A.rosters.get(meKey) ?? [], A.players, slots, flex, freeAgents) },
    steps,
    totals: last ? { steps: steps.filter(s => !s.error).length,
      lineup: { nothing: nothing.lineup, after: last.lineup.after, delta: last.lineup.total_delta, se: last.lineup.total_se },
      playoff: { nothing: nothing.playoff, after: last.playoff.after, delta: last.playoff.total_delta, se: last.playoff.total_se },
      needs_ok: steps.some(s => s.rules?.needs_ok), breaks_rules: steps.some(s => s.rules && !s.rules.ok) } : null,
    stopped,
    ...(look ? { lookahead: look } : {}),
  };
}

/**
 * The lookahead's report, every value as the objective's change against doing nothing forever:
 *   best        the best three-move plan from today (V_3), with its line;
 *   baseline    doing nothing now, then the best moves (V_2): what any first move must beat;
 *   first_moves the top first moves ranked by continuation value (P(yes) x best follow-ups if yes, plus
 *               (1 - P(yes)) x the baseline), each with "now" and "with the best follow-ups";
 *   yours       Nick's own first move in the same terms (when he named one).
 */
function lookaheadBlock(LA, { steps, queue, maxSteps, idOf, teamKey }) {
  const s0 = new Map();
  const v0 = LA.value(s0);
  const rel = x => (x == null ? null : x - v0);
  const best = LA.best(s0, maxSteps);
  const baseline = LA.best(s0, maxSteps - 1);
  const first = LA.first(s0, maxSteps, 5).map(f => ({ move: f.move, p: f.move.p, now_delta: rel(f.now), now_se: f.now_se,
    if_yes_delta: rel(f.if_yes), cont_delta: rel(f.cont), line: f.line }));
  let yours = null;
  const mine = queue[0];
  if (mine && steps[0] && !steps[0].error && !mine.claim) {
    const y = LA.yours(s0, { legs: [{ team: teamKey(mine.team), give: mine.give.map(idOf), get: mine.get.map(idOf) }] }, maxSteps);
    if (y) yours = { move: publicMove(mine), p: y.p, now_delta: rel(y.now), if_yes_delta: rel(y.if_yes), cont_delta: rel(y.cont), line: y.line };
  }
  // Nick's own move is ranked with the search's: it joins the list when the search did not find it itself.
  if (yours) {
    const ids = l => l.map(S).sort().join();
    const same = m => S(m.team) === S(yours.move.team) && ids(m.give) === ids(yours.move.give) && ids(m.get) === ids(yours.move.get);
    for (const f of first) if (same(f.move)) f.yours = true;
    if (!first.some(f => same(f.move)) && yours.cont_delta != null) {
      first.push({ move: { ...yours.move, kind: 'trade', p: yours.p, needs_ok: !!steps[0].rules?.needs_ok }, p: yours.p, now_delta: yours.now_delta,
        now_se: steps[0].playoff?.total_se ?? null, if_yes_delta: yours.if_yes_delta, cont_delta: yours.cont_delta,
        line: [{ ...yours.move, p: yours.p }, ...yours.line], yours: true });
      first.sort((a, b) => b.cont_delta - a.cont_delta);
      const k = first.findIndex(f => same(f.move));
      if (k >= 5) first.splice(4, k - 4);
      first.length = Math.min(first.length, 5);
    }
  }
  const line = LA.line(s0, maxSteps).map(x => x.move);
  return { depth: maxSteps, nothing: v0, best: { value_delta: rel(best.value), line }, baseline: { value_delta: rel(baseline.value) },
    first_moves: first, yours, stats: LA.stats() };
}

export function metricKeyOf(o) { return o?.kind === 'points' ? 'points' : o?.goal === 'playoffs' ? 'playoff' : 'title'; }
/** The step's own gain on the objective (STEP-REGRET: must be > 0 to be worth doing). */
export function metricGain(objective, d) {
  const k = metricKeyOf(objective);
  return k === 'points' ? d.lineup : k === 'playoff' ? d.playoff : d.title;
}

export function publicMove(mv) {
  return { team: S(mv.team), give: mv.give.map(S), get: mv.get.map(S), ...(mv.claim ? { claim: true } : {}),
    ...(mv.via_claim ? { via_claim: publicMove(mv.via_claim) } : {}) };
}

/** A lone claim step: the FLIP-CLAIMS rules (a claim is only ever a flip piece). */
export function claimVerdict(A, rules, legs) {
  const dropOk = makeDropOk({ scoreOf: scoreRow(rules), floor: rules.floor ?? BLUE_CHIP_SCORE, untouchable: A.untouchable ?? new Set() });
  const why = claimRule(legs.map(l => ({ ...l, claim: !!l.claim })), { dropOk, valueOf: id => rules.fc.get(S(id)) ?? null, maxOverpay: rules.overpayCap ?? 0, sold: rules.sold });
  return why ? { ok: false, reasons: [why], requires_nick_confirm: false } : { ok: true, reasons: [], requires_nick_confirm: false };
}

/**
 * Nick's side of the league after `state`, for a search: the rosters, the planner's scorer on the chain's
 * world (W2 rescores every state on top of the chain so far), and what he may give. `allow`: protected
 * players this search may put on the table (PROTECTED-UPGRADE's tier-up search); everyone else Nick
 * protects, and every player the chain brought in, stays out.
 */
function prefixed(A, W, state, { rules, objective, meKey, allow = [] }) {
  const P = A.players;
  const rostersAfter = new Map([...A.rosters].map(([t, ids]) => [t, state.get(t) ?? ids]));
  const A2 = { ...A, rosters: rostersAfter, searchStats: null };
  const W2 = { ...W, rescore: (st, a, b) => W.rescore(merge(state, st), a, b) };
  const S2 = makeScorer(W2, A2);
  // A player the chain already brought in is kept: a fill never trades him on (a tier-up get for a
  // protected player must be held to the end of the move, never-give.js protected_upgrade_not_kept).
  const start = new Set((A.rosters.get(meKey) ?? []).map(S));
  const acquired = (rostersAfter.get(meKey) ?? []).map(S).filter(id => !start.has(id));
  const allowed = new Set(allow.map(S));
  const untouchable = new Set([...(A.untouchable ?? []), ...(objective.untouchables ?? []), ...acquired].map(S).filter(id => !allowed.has(id)));
  const floor = rules.floor ?? BLUE_CHIP_SCORE;
  A2.untouchable = untouchable;
  const tradable = id => !untouchable.has(S(id)) && SCORED.has(P.get(id)?.position) && (Number(P.get(id)?.value) || 0) > 0;
  const getOk = id => !rules.neverGet.has(S(id)) && !rules.sold.has(S(id)) && rules.fc.has(S(id)) && (rules.scoreOf(id) ?? -Infinity) >= floor;
  return { P, rostersAfter, A2, S2, untouchable, floor, tradable, getOk, mine: rostersAfter.get(meKey) ?? [] };
}

/** The planner's one-trade search (search.js#searchTarget, direct paths) for each picked target. */
function searchPicked(X, picked, { state, rules, objective, meKey }) {
  const { S2, A2, tradable, getOk, mine } = X;
  const zero = metricOf(S2.rescore(new Map(), meKey).me, objective).delta;
  const addN = new Map(), lossN = new Map(), lossO = new Map();
  for (const t of picked) {
    addN.set(t.id, metricOf(S2.rescore(S2.applyTrade(new Map(), meKey, t.team, [], [t.id]), meKey, t.team).me, objective).delta - zero);
    lossO.set(t.id, { team: t.team });
  }
  for (const id of mine.filter(tradable)) {
    lossN.set(id, metricOf(S2.rescore(new Map([[meKey, mine.filter(x => x !== id)]]), meKey).me, objective).delta - zero);
  }
  const vals = { addN, addSe: new Map(), lossO, lossN, tradable };
  const found = [];
  for (const t of picked) {
    for (const plan of searchTarget(S2, A2, vals, objective, t.id, { maxOverpay: rules.overpayCap ?? 0, getOk, chainGive: 2,
      untouchables: objective.untouchables ?? null, maxDepth: 1, shortlist: [4, 0, 0] })) {
      const st = plan.steps[0];
      found.push({ kind: 'trade', steps: [{ team: st.team, give: st.give, get: st.get, p: st.p, basis: st.band?.basis ?? st.p_basis ?? null }],
        state: merge(state, st.state), team: st.team });
    }
  }
  return found;
}

/**
 * The follow-ups that fill `hole` after `state`: the planner's own one-trade search for each player who
 * plays the slot and beats today's starter there, plus flip claims when the world carries free agents.
 * Every candidate is rescored on the full chain state (base world, so its numbers compare with doing
 * nothing) and kept only when it passes ruleVerdict and its own gain on the objective is > 0.
 */
export function fillsFor(A, W, state, hole, { rules, objective, prev, fills = CHAIN_FILLS, targets = CHAIN_TARGETS, meKey }) {
  const me = S(A.league.me);
  const X = prefixed(A, W, state, { rules, objective, meKey });
  const { P, rostersAfter, A2, S2, untouchable, floor, tradable, getOk, mine } = X;
  const pool = [];
  // Players who would fill the slot but a rule keeps out (the floor, a sold player, never-get): counted, never served.
  const hidden = {};
  for (const [t, ids] of rostersAfter) {
    if (S(t) === me) continue;
    const m = A.managers?.get(t);
    if (excluded(m) || m?.checked_out) continue;
    for (const id of ids) {
      const p = P.get(id);
      if (!p || !hole.positions.includes(p.position) || !((num(p.ros_ppg) ?? 0) > hole.ppg)) continue;
      if (!tradable(id)) continue;
      if (!getOk(id)) { const why = getWhy(id); hidden[why] = (hidden[why] ?? 0) + 1; continue; }
      pool.push({ id, team: t, ppg: num(p.ros_ppg) });
    }
  }
  function getWhy(id) {
    if (rules.neverGet.has(S(id))) return 'never_get';
    if (rules.sold.has(S(id))) return 'sold_this_season';
    if (!rules.fc.has(S(id))) return 'no_fc_value';
    return rules.scoreOf(id) == null ? 'unscored' : 'below_blue_chip';
  }
  const picked = pool.sort((a, b) => b.ppg - a.ppg).slice(0, targets);
  // Reach: what Nick's tradable players are worth at most (three of them, FantasyCalc) against the cheapest fill.
  const mineNow = mine.filter(tradable).map(id => rules.fc.get(S(id)) ?? 0).sort((a, b) => b - a);
  const cheapest = [...pool].sort((a, b) => (rules.fc.get(S(a.id)) ?? Infinity) - (rules.fc.get(S(b.id)) ?? Infinity))[0] ?? null;
  const reach = { top3_value: mineNow.slice(0, 3).reduce((s, v) => s + v, 0),
    cheapest: cheapest ? { player: S(cheapest.id), value: rules.fc.get(S(cheapest.id)) ?? null, team: S(cheapest.team) } : null,
    hidden_by_rules: Object.values(hidden).reduce((s, n) => s + n, 0), hidden_why: hidden };
  if (!picked.length) return { fills: [], status: `no player who plays ${hole.label} and beats your starter there passes your rules`, searched: 0, reach };
  const found = searchPicked(X, picked, { state, rules, objective, meKey });
  const claims = flipClaims(A2, S2, { state, picked, rules, untouchable, meKey, mine, tradable, floor });
  found.push(...claims.found);
  const scored = scoreFound(A, W, found, { rules, objective, prev, meKey });
  return { fills: scored.slice(0, fills), status: scored.length ? 'ok' : 'no follow-up fills the hole inside your rules and beats doing nothing',
    searched: found.length, claims: claims.status, reach };
}

/**
 * PROTECTED-UPGRADE moves after `state`: a protected player on 'Blue chips only' (rules.protectUpgrade) put on
 * the table for a true tier up only (a Blue chip whose score AND FantasyCalc value both beat his:
 * protected-upgrade.js#tierUpGets), searched the planner's way. Each still passes ruleVerdict with its own
 * rise, so every one that survives is a "Needs your OK" move.
 */
export function protectedMoves(A, W, state, { rules, objective, prev, meKey, targets = 6 }) {
  const me = S(A.league.me);
  const held = (new Map([...A.rosters].map(([t, ids]) => [t, state.get(t) ?? ids])).get(meKey) ?? []).map(S);
  const hard = new Set((objective.untouchables ?? []).map(S));
  const ids = [...(rules.protectUpgrade ?? [])].map(S).filter(id => held.includes(id) && !hard.has(id));
  const found = [];
  for (const pid of ids) {
    const X = prefixed(A, W, state, { rules, objective, meKey, allow: [pid] });
    const fcOf = x => (rules.fc.has(S(x)) ? rules.fc.get(S(x)) : null);
    const picked = [];
    for (const [t, list] of X.rostersAfter) {
      if (S(t) === me) continue;
      const m = A.managers?.get(t);
      if (excluded(m) || m?.checked_out) continue;
      for (const id of list) {
        if (!X.tradable(id) || !X.getOk(id)) continue;
        if (tierUpGets(pid, [id], { scoreOf: rules.scoreOf, fcOf }).length) picked.push({ id, team: t, ppg: num(X.P.get(id)?.ros_ppg) ?? 0 });
      }
    }
    // In reach only: a target worth no more than the protected player plus Nick's two best other tradable pieces
    // (the overpay cap is 0, so a dearer one can never be paid for); then the best by points per game.
    const others = X.mine.filter(id => S(id) !== pid && X.tradable(id)).map(id => fcOf(id) ?? 0).sort((a, b) => b - a);
    const reach = (fcOf(pid) ?? 0) + (others[0] ?? 0) + (others[1] ?? 0);
    const inReach = picked.filter(t => (fcOf(t.id) ?? Infinity) <= reach).sort((a, b) => b.ppg - a.ppg);
    found.push(...searchPicked(X, inReach.slice(0, targets), { state, rules, objective, meKey })
      .filter(c => c.steps[0].give.map(S).includes(pid)));
  }
  return scoreFound(A, W, found, { rules, objective, prev, meKey });
}

/** Rescore each found candidate on the full chain state and keep those that pass every rule and beat doing nothing. */
function scoreFound(A, W, found, { rules, objective, prev, meKey }) {
  const base = makeScorer(W, A);
  const seen = new Set();
  const scored = [];
  for (const c of found) {
    const key = c.steps.map(dealKey).join('>');
    if (seen.has(key)) continue;
    seen.add(key);
    const now = read(base.rescore(c.state, meKey, [...A.rosters.keys()].find(k => S(k) === S(c.team))).me);
    const d = { lineup: now.lineup - prev.lineup, playoff: now.playoff - prev.playoff, title: now.title - prev.title };
    const trade = c.steps[c.steps.length - 1];
    const v = ruleVerdict(rules, { give: trade.give, get: trade.get, premium: { points_delta: d.lineup, title_delta: d.title },
      rises: { points_delta: d.lineup, playoff_delta: d.playoff } });
    const cv = c.kind === 'flip_claim' ? claimVerdict(A, rules, c.steps) : { ok: true, reasons: [] };
    const gain = metricGain(objective, d);
    const ok = v.ok && cv.ok;
    if (!ok || !(gain > 0)) continue;
    scored.push({ kind: c.kind, steps: c.steps.map(s => ({ ...s, give: s.give.map(S), get: s.get.map(S), team: S(s.team) })),
      // The moves as the rosters hold them (typed ids, the team's own key): what the lookahead applies.
      legs: c.steps.map(s => ({ ...(s.claim ? { claim: true } : {}), team: s.team, give: [...s.give], get: [...s.get] })),
      team: S(c.team), give: trade.give.map(S), get: trade.get.map(S), p: num(trade.p), p_basis: trade.basis ?? null,
      lineup: { after: now.lineup, step_delta: d.lineup }, playoff: { after: now.playoff, step_delta: d.playoff },
      title: { after: now.title, step_delta: d.title },
      rules: { ok, reasons: [...v.reasons, ...cv.reasons], needs_ok: !!v.requires_nick_confirm }, metric_gain: gain });
  }
  scored.sort((a, b) => b.metric_gain - a.metric_gain || (b.p ?? 0) - (a.p ?? 0) || b.lineup.step_delta - a.lineup.step_delta);
  return scored;
}

/**
 * FLIP-CLAIMS as a fill: claim a free agent (dropping the cheapest droppable bench piece, pickDrop), then
 * give him (alone, or with one more of Nick's pieces) to a filler's owner. Only when the world simulates
 * free agents (adapter.claimUniverse, SEARCH-WIDE); otherwise off, with the reason.
 */
function flipClaims(A2, S2, { state, picked, rules, untouchable, meKey, mine, tradable, floor }) {
  if (!(A2.claimUniverse instanceof Set) || !A2.claimUniverse.size) return { found: [], status: 'off: free agents are simulated only with the wide search on' };
  const cp = claimProbability(A2.waiverRecord);
  if (cp.status !== 'ok') return { found: [], status: `off: ${cp.reason}` };
  const valueOf = id => rules.fc.get(S(id)) ?? null;
  const pool = claimPoolOf(A2, untouchable, rules.sold).filter(f => valueOf(f.id) != null)
    .sort((a, b) => valueOf(b.id) - valueOf(a.id)).slice(0, CHAIN_CLAIM_POOL);
  const dropOk = makeDropOk({ scoreOf: scoreRow(rules), floor, untouchable });
  const lineup = new Set(A2.starters ?? []);
  const found = [];
  for (const fa of pool) {
    const add = [...A2.players.keys()].find(k => S(k) === S(fa.id));
    if (add == null) continue;
    const drop = pickDrop({ roster: mine, add, dropOk, valueOf, starters: lineup, maxOverpay: rules.overpayCap ?? 0 });
    if (drop == null) continue;
    const claim = { team: FREE_AGENT, claim: true, give: [drop], get: [add], p: cp.p, basis: 'waiver.league_rate' };
    const claimed = S2.applyClaim(new Map(), meKey, [drop], [add]);
    for (const t of picked) {
      const gives = [[add], ...mine.filter(x => x !== drop && tradable(x)).map(x => [add, x])];
      const fair = gives.map(give => ({ give, o: overpayCheck(rules, { give: give.map(S), get: [S(t.id)] }) }))
        .filter(x => x.o.priced && !x.o.breaks && screenFair(x.give.reduce((s, id) => s + (valueOf(id) ?? 0), 0), valueOf(t.id) ?? 0))
        .sort((a, b) => b.o.over - a.o.over)[0];
      if (!fair) continue;
      const pr = A2.priceStep(t.team, [t.id], fair.give);
      const traded = S2.applyTrade(claimed, meKey, t.team, fair.give, [t.id]);
      found.push({ kind: 'flip_claim', team: t.team, state: traded,
        steps: [claim, { team: t.team, give: fair.give, get: [t.id], p: pr.p, basis: pr.basis ?? pr.band?.basis ?? null }] });
    }
  }
  return { found: found.map(f => ({ ...f, state: merge(state, f.state) })), status: 'on' };
}
