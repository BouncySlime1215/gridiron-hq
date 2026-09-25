/**
 * LADDER-01 (ONE-PLAN night 5): ladder cards over the one planner's searched paths (pure).
 *
 * A ladder is a chained path (paths.js#isChained): an early rung brings a piece in and a later rung
 * spends it, depth -> level below -> blue chip. The search already lets a chained finish spend the
 * acquired piece (search.js stepsFrom reads the chained state's roster); how many players that finish
 * may give is the search's (REACH-01's chainGive), not this module's. This module only reads the
 * planner's candidate plans in the risk mode's rank order and turns the ones that are ladders into
 * cards: P(yes) per rung (labelled a guess while it is the acceptance band's midpoint, centre 0.30),
 * what Nick holds if the rung lands, and what happens at each "no" (the best other rung that shares
 * the rungs before it, else stop and keep what the rungs before it landed).
 *
 * Hard filters (Nick 9/24, ONE-PLAN 10b), each counted in dropped_by_reason. Every rule is main's, read
 * from its one home; this module keeps no copy of any list or threshold:
 *   final get      main's floor (gets-floor.js floorRead, 83+ or the destination's higher min_get_score)
 *                  on EVERYTHING Nick holds at the end (gets-floor.js heldAtEnd: gets minus later
 *                  gives), the target included. Unscored fails closed, whatever GRIDIRON_GETS_FLOOR says.
 *   never give     never-give.js PINNED_NEVER_GIVE (160, 80, 277), adapter.untouchable and the
 *                  destination's untouchables, on every rung
 *   never get      never-give.js PINNED_NEVER_GET (290) on every rung, and main's trade memory
 *                  (trade-memory.js applyTradeMemory: no buy-back of any player Nick sold, from any
 *                  team; no reversal, within a rung or across rungs)
 *   overpay        no rung gives more market value than it gets past the planner's cap
 *   Fuck-it        at most ALL_IN_GUESS_MAX_RUNGS (2) rungs while any rung's p is the guess (a
 *                  3-rung ladder at 0.30 each lands 2.7% of the time, under ALL_IN_MIN_COMPLETE)
 *
 * Dice: the rung numbers are the planning seed's (LADDER_BASIS). A card is served only when the planner's
 * confirmedActive (main's confirm-dice gate) returns it re-priced, i.e. it beats doing nothing on the
 * confirm dice, with a re-priced expected gain above 0; the card carries that gain as confirmed_expected.
 * A backup at a "no" passes the same gate and shows its confirm-dice number (dice: 'confirm'). No
 * confirm dice, no card and no backup.
 *
 * SHADOW: the cards never re-rank, filter or re-price the deck, the next move or any served number;
 * they are one extra section. Flag GRIDIRON_LADDER ('1' on; anything else off, and preview does
 * not turn it on). Off, the planner does not call this module and the section is 'unknown' with the reason.
 */
import { dealKey, isChained, pathExpectation } from './paths.js';
import { nickOverpays, DEFAULT_MAX_OVERPAY } from './search.js';
import { normaliseMode } from './modes.js';
import { PINNED_NEVER_GIVE, PINNED_NEVER_GET } from './never-give.js';
import { DEFAULT_GET_FLOOR, floorRead, heldAtEnd } from './gets-floor.js';
import { applyTradeMemory } from './trade-memory.js';

export const LADDER_ENV = 'GRIDIRON_LADDER';
/** "Level below" starts here on Nick's board (ONE-PLAN 4: Bucky Irving 74). A display tier only. */
export const LEVEL_BELOW = 74;
/** Fuck-it ladder length while P(yes) is the unfitted guess (ONE-PLAN 4, cause 5). */
export const ALL_IN_GUESS_MAX_RUNGS = 2;
export const MAX_CARDS = 5;
export const TIERS = Object.freeze(['blue_chip', 'level_below', 'depth', 'unscored']);
export const DROP_REASONS = Object.freeze(['not_a_ladder', 'never_get', 'sold', 'reversal', 'memory_floor', 'gives_untouchable',
  'overpay', 'final_unscored', 'final_below_floor', 'held_unscored', 'held_below_floor', 'all_in_rungs_p_guess', 'duplicate',
  'not_confirmed']);
/** trade-memory.js reasons -> this module's drop reasons (the shadow ones drop only with its floor flag on). */
const MEMORY_REASON = Object.freeze({ sold_recently: 'sold', reversal: 'reversal', below_his_floor: 'memory_floor', wrong_currency: 'memory_floor' });
/** What every number on a card is priced on: the planning seed (the cards are built before the confirm pass). */
export const LADDER_BASIS = 'planning dice: rung deltas and P(yes) from the planning seed; confirmed_expected and backups are the confirm dice';


/** 'on' | 'off'. */
export function ladderFlag(env = {}) {
  return env?.[LADDER_ENV] === '1' ? 'on' : 'off';
}

/** A score's display tier (floor: main's Blue chip floor for this run). */
export function tierOf(score, floor = DEFAULT_GET_FLOOR) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'unscored';
  if (score >= floor) return 'blue_chip';
  if (score >= LEVEL_BELOW) return 'level_below';
  return 'depth';
}

/** Whether a rung's P(yes) is still the guess (no fitted basis on it). */
const pGuess = s => s.p_basis !== 'fitted';

/**
 * plans: candidate plans in the mode's rank order (planner.js rankPlans(...).ranked).
 * opts: { mode, scoreOf (adapter.scoreOf), floor (the run's gets-floor number, never under 83),
 *   players (Map id -> { value }), untouchable (Set: adapter.untouchable), objectiveUntouchables (the
 *   destination's list), memory (trade-memory.js tradeMemory(...), or null when there is no ledger),
 *   env (the planner's env, for trade memory's floor flag), confirmed (the planner's confirmedActive:
 *   plan -> that plan re-priced on the confirm dice when it beats doing nothing, else null; absent = no
 *   confirm dice, so no backup), maxOverpay, n }
 * -> { mode, floor, rank_basis, considered, dropped_by_reason, cards }
 */
export function ladderCards(plans, { mode = 'balanced', scoreOf = null, floor = DEFAULT_GET_FLOOR, players = new Map(),
  untouchable = new Set(), objectiveUntouchables = [], memory = null, env = {}, confirmed = null,
  maxOverpay = DEFAULT_MAX_OVERPAY, n = MAX_CARDS } = {}) {
  const m = normaliseMode(mode);
  // Nick's floor is the least: a lower number from a caller never loosens it.
  const F = Math.max(DEFAULT_GET_FLOOR, Number(floor) || DEFAULT_GET_FLOOR);
  const P = players instanceof Map ? players : new Map();
  const val = id => Math.max(0, Number((P.get(id) ?? P.get(String(id)) ?? P.get(Number(id)))?.value) || 0);
  const sum = ids => ids.reduce((s, id) => s + val(id), 0);
  const read = id => floorRead(scoreOf, id, F);
  const score = id => read(id).score;
  const best = ids => ids.map(score).filter(v => v != null).reduce((a, v) => (a == null || v > a ? v : a), null);
  const never = new Set([...PINNED_NEVER_GIVE, ...[...(untouchable ?? [])], ...[...(objectiveUntouchables ?? [])]].map(String));
  // Main's trade memory on this one path: its first reason, mapped, or null.
  const memoryWhy = p => {
    if (!memory) return null;
    const r = applyTradeMemory([p], memory, { env });
    const k = Object.keys(r.dropped).find(x => r.dropped[x] > 0);
    return k ? MEMORY_REASON[k] ?? 'sold' : null;
  };
  const dropped = Object.fromEntries(DROP_REASONS.map(k => [k, 0]));
  const kept = [];
  const seen = new Set();
  const whyNot = p => {
    const steps = p.steps ?? [];
    if (steps.length < 2 || !isChained(steps)) return 'not_a_ladder';
    if (steps.some(s => s.get.some(id => PINNED_NEVER_GET.includes(String(id))))) return 'never_get';
    const mem = memoryWhy(p);
    if (mem) return mem;
    if (steps.some(s => s.give.some(id => never.has(String(id))))) return 'gives_untouchable';
    if (steps.some(s => nickOverpays(sum(s.give), sum(s.get), maxOverpay))) return 'overpay';
    const fr = read(p.target);
    if (fr.score == null) return 'final_unscored';
    if (!fr.passes) return 'final_below_floor';
    // Everything still held at the end is a final get too (a 1-for-2 rung's second player, say).
    const held = [...heldAtEnd(steps)].map(read);
    if (held.some(r => r.score == null)) return 'held_unscored';
    if (held.some(r => !r.passes)) return 'held_below_floor';
    if (m === 'all_in' && steps.length > ALL_IN_GUESS_MAX_RUNGS && steps.some(pGuess)) return 'all_in_rungs_p_guess';
    const key = steps.map(dealKey).join('>');
    if (seen.has(key)) return 'duplicate';
    seen.add(key);
    return null;
  };
  for (const p of plans) {
    const why = whyNot(p);
    if (why) { dropped[why]++; continue; }
    kept.push(p);
  }
  const prefixOf = (p, i) => p.steps.slice(0, i).map(dealKey).join('>');
  const onNo = (p, i, rungs) => {
    const pre = prefixOf(p, i);
    // A backup must beat doing nothing on the confirm dice (main's gate) and shows their number; no dice, no backup.
    if (typeof confirmed !== 'function') return { kind: 'stop', keep: i === 0 ? 0 : rungs[i - 1].if_yes };
    for (const q of kept) {
      if (q === p || q.steps.length <= i || prefixOf(q, i) !== pre || dealKey(q.steps[i]) === dealKey(p.steps[i])) continue;
      const c = confirmed(q);
      const g = c ? pathExpectation(c.steps).expected : null;
      if (!(Number.isFinite(g) && g > 0)) continue;
      const s = c.steps[i];
      return { kind: 'backup', partner: String(s.team), give: s.give.map(String), get: s.get.map(String), expected: g, dice: 'confirm' };
    }
    return { kind: 'stop', keep: i === 0 ? 0 : rungs[i - 1].if_yes };
  };
  // Nick's rule (main's gate): a card is served only when it beats doing nothing on the confirm dice, and it
  // carries that gain (confirmed_expected > 0). No confirm dice, no card. Checked in rank order until n are kept.
  const served = [];
  for (const p of kept) {
    if (served.length >= n) break;
    const c = typeof confirmed === 'function' ? confirmed(p) : null;
    const g = c ? pathExpectation(c.steps).expected : null;
    if (!(Number.isFinite(g) && g > 0)) { dropped.not_confirmed++; continue; }
    served.push({ p, confirmed_expected: g });
  }
  const cards = served.map(({ p, confirmed_expected }) => {
    const rungs = [];
    p.steps.forEach((s, i) => {
      const r = { partner: String(s.team), give: s.give.map(String), get: s.get.map(String), get_tier: tierOf(best(s.get), F),
        p: s.p, p_guess: pGuess(s), if_yes: s.delta, se: Number.isFinite(s.se) ? s.se : null };
      rungs.push(r);
      r.on_no = onNo(p, i, rungs);
    });
    const e = pathExpectation(p.steps);
    return { target: String(p.target), owner: String(p.owner ?? p.steps[p.steps.length - 1].team),
      climb: [tierOf(best(p.steps[0].give), F), ...rungs.map(r => r.get_tier)], rank_basis: 'p_guess', rungs,
      p_complete: e.p_complete, if_complete: e.delta_final, expected: e.expected, confirmed_expected };
  });
  return { mode: m, floor: F, rank_basis: 'p_guess', dice: 'planning', basis: LADDER_BASIS,
    considered: plans.length, dropped_by_reason: dropped, cards };
}

/* ------------------------------------------------------------ the plans-file section */

const fin = v => typeof v === 'number' && Number.isFinite(v);
const numF = (v, source, meta = {}) => (fin(v) ? { status: 'ok', value: v, source, ...meta }
  : { status: 'unknown', source, reason: 'Not computed for this rung.' });

/**
 * The `ladders` section (plans-schema.js): typed numbers, every one a guess (p is the band midpoint,
 * the deltas are the planning seed's). A card whose ids are not all in `names` is left out.
 * unit: the entry's objective unit (view.js UNIT).
 */
export function ladderSection(l, { names = {}, unit = 'title_odds' } = {}) {
  if (!l) return { status: 'unknown', source: 'plan.path', reason: 'Ladder cards are off (GRIDIRON_LADDER).' };
  const inNames = id => Object.hasOwn(names, String(id));
  const d = (v, se) => numF(v, 'sim.title', { ...(fin(se) && se >= 0 ? { se } : {}), unit, guess: true });
  const p = v => (fin(v) && v >= 0 && v <= 1 ? numF(v, 'clone.accept', { unit: 'probability', guess: true })
    : { status: 'unknown', source: 'clone.accept', reason: 'No P(yes) for this rung.' });
  const cards = l.cards.filter(c => inNames(c.target) && c.rungs.every(r => [...r.give, ...r.get].every(inNames)
    && (r.on_no.kind !== 'backup' || [...r.on_no.give, ...r.on_no.get].every(inNames))))
    .map(c => ({ target: c.target, owner: c.owner, climb: c.climb, rank_basis: c.rank_basis,
      rungs: c.rungs.map(r => ({ partner: r.partner, give: r.give, get: r.get, get_tier: r.get_tier,
        p: p(r.p), if_yes: d(r.if_yes, r.se),
        on_no: r.on_no.kind === 'backup'
          ? { kind: 'backup', partner: r.on_no.partner, give: r.on_no.give, get: r.on_no.get, expected: d(r.on_no.expected), dice: r.on_no.dice }
          : { kind: 'stop', keep: d(r.on_no.keep) } })),
      p_complete: p(c.p_complete), if_complete: d(c.if_complete), expected: d(c.expected),
      confirmed_expected: numF(c.confirmed_expected, 'sim.title', { unit }) }));
  return { status: 'ok', source: 'plan.path', guess: true,
    value: { mode: l.mode, floor: l.floor, rank_basis: l.rank_basis, dice: l.dice, basis: l.basis, considered: l.considered,
      dropped_by_reason: l.dropped_by_reason, cards } };
}
