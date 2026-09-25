/**
 * SEARCH-WIDE (ONE-PLAN section 5, night 6): the one planner's search, widened (pure).
 *
 * search.js#searchTarget runs today's shortlist first and unchanged; with the flag on it then
 * scores more of the paths it already enumerates, in heuristic order, until a league-wide budget
 * runs out:
 *   node budget  exact-scored candidates beyond today's shortlist (`candidates`) and fresh
 *                rescores (`rescores`: PRODUCER-FAST cache misses when the adapter has the
 *                cache, else planner memo misses; cache hits are free).
 *   depth 3      the second chip layer takes the top `beam` distinct first steps (today 6) and
 *                may give 2 (today 1). CHESS-01a (#258) is folded in here, not a second planner.
 *   laterals     a trade step where every player given and got is below the Blue chip floor
 *                (depth for depth) is kept only when the path ends at the floor: everything
 *                Nick acquires and still holds at the end passes it. Unscored fails closed.
 *   claims       a path of 1 or 2 trades may end with one free-agent claim (partner
 *                FREE_AGENT): add a pool free agent, drop Nick's same-position depth piece,
 *                only when the free agent's ros_ppg beats the dropped piece's.
 *
 * Flag GRIDIRON_SEARCH_WIDE: '1' on; anything else off. The preview switch does NOT turn it on:
 * it moves served numbers (more paths ranked), so it stays off until measured on league 4.
 * Nick's hard rules sit outside this module and apply to every path it adds.
 */
import { floorRead } from './gets-floor.js';
import { NEVER_DEPTH } from './search.js';
import { PINNED_NEVER_GET } from './never-give.js';

export const SEARCH_WIDE_ENV = 'GRIDIRON_SEARCH_WIDE';
export const SEARCH_WIDE_CANDIDATES_ENV = 'GRIDIRON_SEARCH_WIDE_CANDIDATES';
export const SEARCH_WIDE_RESCORES_ENV = 'GRIDIRON_SEARCH_WIDE_RESCORES';
export const SEARCH_WIDE_BEAM_ENV = 'GRIDIRON_SEARCH_WIDE_BEAM';

/**
 * League-wide defaults. candidates: the plan's ">= 2,000 candidates scored", with headroom.
 * rescores: ~10 min cold at the measured ~250 ms per fresh rescore (397 in 97.9 s, 2026-09-24
 * 14:23Z); a guess until league 4 is timed. beam: distinct first steps the second chip extends.
 */
export const WIDE_DEFAULTS = Object.freeze({ candidates: 2400, rescores: 2400, beam: 24 });
/** Free agents the adapter simulates as claimable (the sim's `universe`), best ros_ppg first. */
export const CLAIM_POOL_SIZE = 10;
/** The partner id of a claim step. */
export const FREE_AGENT = 'free_agent';

/** 'on' only when GRIDIRON_SEARCH_WIDE=1. */
export function searchWideFlag(env = process.env) {
  return env?.[SEARCH_WIDE_ENV] === '1' ? 'on' : 'off';
}

const posInt = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

/** { candidates, rescores, beam } from the env overrides (positive integers), else the defaults. */
export function wideBudget(env = process.env) {
  return {
    candidates: posInt(env?.[SEARCH_WIDE_CANDIDATES_ENV]) ?? WIDE_DEFAULTS.candidates,
    rescores: posInt(env?.[SEARCH_WIDE_RESCORES_ENV]) ?? WIDE_DEFAULTS.rescores,
    beam: posInt(env?.[SEARCH_WIDE_BEAM_ENV]) ?? WIDE_DEFAULTS.beam };
}

/** A fresh sink for one league's wide search. */
export function newWideSink(budget = WIDE_DEFAULTS) {
  return { flag: 'on', budget: { ...budget }, used: { extras: 0, rescores: 0 }, budget_hit: null,
    enumerated: 0, laterals: { seen: 0, dropped: 0 }, claims: { pool: 0, built: 0, scored: 0, kept: 0 } };
}

export const isClaim = st => st?.claim === true;

/** A trade step that swaps depth for depth: every player given and got fails the floor. */
export function isLateral(st, tierOk) {
  if (isClaim(st) || !st.give.length || !st.get.length) return false;
  return [...st.give, ...st.get].every(id => !tierOk(id));
}

/** Everything Nick acquires on the path and still holds at its end. */
export function heldAtEnd(steps) {
  const held = new Set();
  for (const st of steps) { for (const id of st.give) held.delete(String(id)); for (const id of st.get) held.add(String(id)); }
  return [...held];
}

/** A path with a lateral is kept only when everything held at its end passes the floor. */
export function lateralOk(steps, tierOk) {
  if (!steps.some(st => isLateral(st, tierOk))) return true;
  return heldAtEnd(steps).every(id => tierOk(id));
}

/**
 * Which of Nick's players a claim may drop: scored below the floor (depth), never untouchable,
 * never one of NEVER_DEPTH (160 / 80 / 277). No score source, or no score, is never droppable.
 */
export function makeDropOk({ scoreOf, floor, untouchable = new Set() }) {
  const u = new Set([...untouchable].map(String));
  return id => {
    const k = String(id);
    if (NEVER_DEPTH.has(k) || u.has(k)) return false;
    return floorRead(scoreOf, id, floor).why === 'below_floor';
  };
}

/**
 * The claim pool: the adapter's free agents that its world simulates (adapter.claimUniverse),
 * never a pinned never-get or an untouchable. No universe, no pool (fails closed).
 */
export function claimPoolOf(adapter, untouchable = new Set()) {
  const uni = adapter.claimUniverse;
  if (!(uni instanceof Set) || !uni.size) return [];
  const blocked = new Set([...PINNED_NEVER_GET, ...[...untouchable].map(String)]);
  return (adapter.freeAgents ?? []).filter(f => uni.has(String(f.id)) && !blocked.has(String(f.id))
    && Number.isFinite(f.ros_ppg) && f.position);
}

/**
 * The best claim on a roster: the (free agent, drop) pair of the same position with the largest
 * ros_ppg edge, where the drop passes dropOk, was not acquired on the path, and the free agent
 * beats it. roster: Nick's ids at that point; pool: [{ id, position, ros_ppg }]. Or null.
 */
export function bestClaim({ roster, pool, playerOf, dropOk, acquired = new Set() }) {
  const held = new Set(roster.map(String));
  let best = null;
  for (const fa of pool) {
    if (held.has(String(fa.id))) continue;
    for (const id of roster) {
      const p = playerOf(id);
      if (!p || p.position !== fa.position || acquired.has(String(id)) || !dropOk(id)) continue;
      const edge = fa.ros_ppg - (Number(p.ros_ppg) || 0);
      if (!(edge > 0)) continue;
      if (!best || edge > best.edge) best = { drop: id, add: fa.id, edge };
    }
  }
  return best;
}

/** Distinct first steps by risk mode's confirmed best, and whether they differ (the plan's MODES check). */
export function modesFirstSteps(confirmedBest, keyOf) {
  const out = Object.fromEntries(Object.entries(confirmedBest).map(([m, p]) => [m, p ? keyOf(p.steps[0]) : null]));
  const keys = Object.values(out).filter(Boolean);
  return { modes_first_steps: out, modes_differ: new Set(keys).size > 1 };
}
