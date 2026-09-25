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
 * Hard filters (Nick 9/24, ONE-PLAN 10b), each counted in dropped_by_reason:
 *   final get      Blue chip, FINAL_FLOOR (83) on the PLAYER-SCORE score; unscored fails closed.
 *                  Everything Nick still holds at the end (gets minus later gives) is held to it too.
 *   never give     NEVER_GIVE (Nico Collins 160, Chase Brown 80, A.J. Brown 277 until AJ-HEALTHY
 *                  prices him), adapter.untouchable and the destination's untouchables, on every rung
 *   never get      NEVER_GET (Chris Olave 290: sold 9/17) and the caller's sold set (trade memory: no
 *                  buy-backs of any player Nick sold, from any team), on every rung
 *   overpay        no rung gives more market value than it gets past the planner's cap
 *   Fuck-it        at most ALL_IN_GUESS_MAX_RUNGS (2) rungs while any rung's p is the guess (a
 *                  3-rung ladder at 0.30 each lands 2.7% of the time, under ALL_IN_MIN_COMPLETE)
 *
 * Dice: every card number is the planning seed's (LADDER_BASIS). A backup at a "no" is offered only when
 * it beats doing nothing on the confirm dice (the caller's `confirmed`), and then shows that number.
 *
 * SHADOW: the cards never re-rank, filter or re-price the deck, the next move or any served number;
 * they are one extra section. Flag GRIDIRON_LADDER ('1' on; anything else off, and preview does
 * not turn it on). Off, the planner does not call this module and the section is 'unknown' with the reason.
 */
import { dealKey, isChained, pathExpectation } from './paths.js';
import { nickOverpays, DEFAULT_MAX_OVERPAY } from './search.js';
import { normaliseMode } from './modes.js';

export const LADDER_ENV = 'GRIDIRON_LADDER';
/** Nick's floor for the final get: Blue chip, 83+ (10b.2). */
export const FINAL_FLOOR = 83;
/** "Level below" starts here on Nick's board (ONE-PLAN 4: Bucky Irving 74). A display tier only. */
export const LEVEL_BELOW = 74;
/** Pinned by id so the rule holds when his notes are missing (the notes-derived set fails open). */
export const NEVER_GIVE = Object.freeze(['160', '80', '277']);
export const NEVER_GET = Object.freeze(['290']);
/** Fuck-it ladder length while P(yes) is the unfitted guess (ONE-PLAN 4, cause 5). */
export const ALL_IN_GUESS_MAX_RUNGS = 2;
export const MAX_CARDS = 5;
export const TIERS = Object.freeze(['blue_chip', 'level_below', 'depth', 'unscored']);
export const DROP_REASONS = Object.freeze(['not_a_ladder', 'never_get', 'sold', 'gives_untouchable', 'overpay',
  'final_unscored', 'final_below_floor', 'held_unscored', 'held_below_floor', 'all_in_rungs_p_guess', 'duplicate']);
/** What every number on a card is priced on: the planning seed (the cards are built before the confirm pass). */
export const LADDER_BASIS = 'planning dice: deltas and P(yes) from the planning seed, not confirmed on fresh dice';

/** Players Nick holds at the end of a path: every get, minus what a later rung gives on. */
export function heldAtEnd(steps) {
  const held = new Set();
  for (const s of steps) { for (const id of s.give) held.delete(String(id)); for (const id of s.get) held.add(String(id)); }
  return held;
}

/** 'on' | 'off'. */
export function ladderFlag(env = {}) {
  return env?.[LADDER_ENV] === '1' ? 'on' : 'off';
}

/** A score's display tier. */
export function tierOf(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'unscored';
  if (score >= FINAL_FLOOR) return 'blue_chip';
  if (score >= LEVEL_BELOW) return 'level_below';
  return 'depth';
}

/**
 * The planner's score reader: adapter.scoreOf (id -> { score } | null) when the adapter has one,
 * else the PLAYER-SCORE board's rows (adapter.blueChips(), off -> no scores), else null.
 */
export function scoreReader(adapter) {
  if (typeof adapter?.scoreOf === 'function') return adapter.scoreOf;
  const board = typeof adapter?.blueChips === 'function' ? adapter.blueChips() : null;
  if (!board || board.status !== 'ok' || !Array.isArray(board.rows)) return null;
  const byId = new Map(board.rows.map(r => [String(r.player), r]));
  return id => byId.get(String(id)) ?? null;
}

/** Whether a rung's P(yes) is still the guess (no fitted basis on it). */
const pGuess = s => s.p_basis !== 'fitted';

/**
 * plans: candidate plans in the mode's rank order (planner.js rankPlans(...).ranked).
 * opts: { mode, scoreOf, players (Map id -> { value }), untouchable (Set: adapter.untouchable),
 *   objectiveUntouchables (the destination's list), sold (Set of ids, or id -> truthy: trade memory's
 *   sold players, never bought back), confirmed (plan -> its confirm-dice expected when it beats doing
 *   nothing, else null; absent = no confirm dice, backups labelled planning dice), maxOverpay, n }
 * -> { mode, floor, rank_basis, considered, dropped_by_reason, cards }
 */
export function ladderCards(plans, { mode = 'balanced', scoreOf = null, players = new Map(), untouchable = new Set(),
  objectiveUntouchables = [], sold = null, confirmed = null, maxOverpay = DEFAULT_MAX_OVERPAY, n = MAX_CARDS } = {}) {
  const m = normaliseMode(mode);
  const P = players instanceof Map ? players : new Map();
  const val = id => Math.max(0, Number((P.get(id) ?? P.get(String(id)) ?? P.get(Number(id)))?.value) || 0);
  const sum = ids => ids.reduce((s, id) => s + val(id), 0);
  const score = id => {
    if (typeof scoreOf !== 'function') return null;
    const v = Number(scoreOf(id)?.score);
    return scoreOf(id)?.score != null && Number.isFinite(v) ? v : null;
  };
  const best = ids => ids.map(score).filter(v => v != null).reduce((a, v) => (a == null || v > a ? v : a), null);
  const never = new Set([...NEVER_GIVE, ...[...(untouchable ?? [])], ...[...(objectiveUntouchables ?? [])]].map(String));
  const isSold = typeof sold === 'function' ? id => !!sold(String(id))
    : id => !!sold && typeof sold.has === 'function' && (sold.has(String(id)) || sold.has(Number(id)));
  const dropped = Object.fromEntries(DROP_REASONS.map(k => [k, 0]));
  const kept = [];
  const seen = new Set();
  const whyNot = p => {
    const steps = p.steps ?? [];
    if (steps.length < 2 || !isChained(steps)) return 'not_a_ladder';
    if (steps.some(s => s.get.some(id => NEVER_GET.includes(String(id))))) return 'never_get';
    if (steps.some(s => s.get.some(isSold))) return 'sold';
    if (steps.some(s => s.give.some(id => never.has(String(id))))) return 'gives_untouchable';
    if (steps.some(s => nickOverpays(sum(s.give), sum(s.get), maxOverpay))) return 'overpay';
    const fs = score(p.target);
    if (fs == null) return 'final_unscored';
    if (fs < FINAL_FLOOR) return 'final_below_floor';
    // Everything still held at the end is a final get too (a 1-for-2 rung's second player, say).
    const held = [...heldAtEnd(steps)].map(score);
    if (held.some(v => v == null)) return 'held_unscored';
    if (held.some(v => v < FINAL_FLOOR)) return 'held_below_floor';
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
    // With confirm dice, a backup must beat doing nothing on them (and shows their number); without, it is labelled.
    for (const q of kept) {
      if (q === p || q.steps.length <= i || prefixOf(q, i) !== pre || dealKey(q.steps[i]) === dealKey(p.steps[i])) continue;
      const c = typeof confirmed === 'function' ? confirmed(q) : undefined;
      if (c === null || (c !== undefined && !(Number.isFinite(c) && c > 0))) continue;
      const s = q.steps[i];
      return { kind: 'backup', partner: String(s.team), give: s.give.map(String), get: s.get.map(String),
        expected: c === undefined ? pathExpectation(q.steps).expected : c, dice: c === undefined ? 'planning' : 'confirm' };
    }
    return { kind: 'stop', keep: i === 0 ? 0 : rungs[i - 1].if_yes };
  };
  const cards = kept.slice(0, n).map(p => {
    const rungs = [];
    p.steps.forEach((s, i) => {
      const r = { partner: String(s.team), give: s.give.map(String), get: s.get.map(String), get_tier: tierOf(best(s.get)),
        p: s.p, p_guess: pGuess(s), if_yes: s.delta, se: Number.isFinite(s.se) ? s.se : null };
      rungs.push(r);
      r.on_no = onNo(p, i, rungs);
    });
    const e = pathExpectation(p.steps);
    return { target: String(p.target), owner: String(p.owner ?? p.steps[p.steps.length - 1].team),
      climb: [tierOf(best(p.steps[0].give)), ...rungs.map(r => r.get_tier)], rank_basis: 'p_guess', rungs,
      p_complete: e.p_complete, if_complete: e.delta_final, expected: e.expected };
  });
  return { mode: m, floor: FINAL_FLOOR, rank_basis: 'p_guess', dice: 'planning', basis: LADDER_BASIS,
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
      p_complete: p(c.p_complete), if_complete: d(c.if_complete), expected: d(c.expected) }));
  return { status: 'ok', source: 'plan.path', guess: true,
    value: { mode: l.mode, floor: l.floor, rank_basis: l.rank_basis, dice: l.dice, basis: l.basis, considered: l.considered,
      dropped_by_reason: l.dropped_by_reason, cards } };
}
