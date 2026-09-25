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
 *                The tier is LADDER-01's (ladder.js#tierOfPlayer); this module keeps no copy.
 *   claims       FLIP-CLAIMS (Nick 2026-09-25): a free-agent claim (partner FREE_AGENT) is a step
 *                ONLY as a flip piece. The claim is step 1 and a later trade step in the same
 *                path gives the claimed player away, so Nick never ends a path holding a claim.
 *                The drop is never protected (claimDropOk) and is the lowest-value bench piece
 *                (pickDrop); the claim step and the flip step each pass the overpay cap; the
 *                path must beat doing nothing on the confirm dice with the stranded branch (claim
 *                done, flip declined) in the price. claimRule is the one check (planner.js).
 *
 * Flag GRIDIRON_SEARCH_WIDE: '1' on; anything else off. The preview switch does NOT turn it on:
 * it moves served numbers (more paths ranked), so it stays off until measured on league 4.
 * Nick's hard rules sit outside this module and apply to every path it adds.
 */
import { floorRead, heldAtEnd, isFlipPieceClaim } from './gets-floor.js';
import { NEVER_DEPTH, nickOverpays } from './search.js';
import { PINNED_NEVER_GET } from './never-give.js';
import { pathOutcomes } from './paths.js';

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
/**
 * #406 review finding 1: a claim's P(yes) is the chance Nick WINS it on waivers, never 1. The
 * estimate is this league's own record of processed waiver claims this season (all teams):
 * won = claims ESPN executed, lost = claims that failed because another team got the player
 * (FAILED_INVALIDPLAYERSOURCE). Laplace-smoothed, (won + 1) / (won + lost + 2). Fewer than
 * CLAIM_MIN_N decided claims: no estimate, so no claim is built (fails closed). A player who is
 * a plain free agent (no waiver) is easier than this, so the estimate is conservative.
 */
export const CLAIM_MIN_N = 5;
export const CLAIM_P_BASIS = 'waiver.league_rate';
export function claimProbability(record) {
  const won = Number(record?.won), lost = Number(record?.lost);
  if (!Number.isInteger(won) || !Number.isInteger(lost) || won < 0 || lost < 0) {
    return { status: 'no_history', reason: 'no waiver-claim record for this league', p: null };
  }
  const n = won + lost;
  if (n < CLAIM_MIN_N) return { status: 'not_enough_data', reason: `${n} decided waiver claims this season (needs ${CLAIM_MIN_N})`, n, p: null };
  return { status: 'ok', basis: CLAIM_P_BASIS, p: +((won + 1) / (n + 2)).toFixed(4), won, lost, n };
}

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
    enumerated: 0, laterals: { seen: 0, dropped: 0 }, claims: { pool: 0, built: 0, scored: 0, kept: 0, dropped_by_reason: Object.fromEntries(CLAIM_DROP_REASONS.map(k => [k, 0])) } };
}

export const isClaim = st => st?.claim === true;

/** A trade step that swaps depth for depth: every player given and got fails the floor. */
export function isLateral(st, tierOk) {
  if (isClaim(st) || !st.give.length || !st.get.length) return false;
  return [...st.give, ...st.get].every(id => !tierOk(id));
}

/**
 * A path with a lateral is kept only when everything held at its end passes the floor. "Held at the
 * end" is gets-floor.js#heldAtEnd (the planner's GETS-FLOOR and LADDER-01 read the same one), and
 * tierOk is LADDER-01's classification (ladder.js#tierOfPlayer === 'blue_chip', wired in planner.js).
 */
export function lateralOk(steps, tierOk) {
  if (!steps.some(st => isLateral(st, tierOk))) return true;
  return [...heldAtEnd(steps)].every(id => tierOk(id));
}

/**
 * Why a claim path is dropped. The first five are claimRule's (the one rule check below); the rest are
 * the planner's other gates as they fall on claim paths (FC value, GETS-FLOOR, trade memory, the active
 * mode's tolerances, the confirm dice: `claim_stranded` = does not beat doing nothing with the stranded
 * branch priced in, `confirm_failed` = no confirm dice at all) and the confirm pass's cap
 * (`not_confirmed`: more claim paths than it re-prices).
 */
export const CLAIM_DROP_REASONS = Object.freeze(['claim_not_flipped', 'protected_drop', 'claim_overpay', 'claim_sold',
  'no_fc_value', 'floor', 'trade_memory', 'mode_tolerance', 'claim_stranded', 'confirm_failed', 'not_confirmed']);
/** Claim paths re-priced on the confirm dice per league, best planning expected first. */
export const CLAIM_CONFIRM_MAX = 24;
/** Claimed players tried per target, and chips kept per claim before the finish (the search's own cap). */
export const CLAIM_FLIPS_PER = 4;

/**
 * Which of Nick's players a claim may drop (Nick 2026-09-25: never a protected player): scored below
 * the floor (so never a Blue chip, never unscored: fails closed), never untouchable (his notes and
 * the objectives file, passed in), never one of NEVER_DEPTH (160 / 80 / 277). No score source, or no
 * score, is never droppable.
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
 * The claim pool: the adapter's free agents that its world simulates (adapter.claimUniverse), never a
 * pinned never-get, an untouchable, or a player Nick sold this season (`sold`: whole season, no
 * price-fall exception). No universe, no pool (fails closed).
 */
export function claimPoolOf(adapter, untouchable = new Set(), sold = new Set()) {
  const uni = adapter.claimUniverse;
  if (!(uni instanceof Set) || !uni.size) return [];
  const blocked = new Set([...PINNED_NEVER_GET, ...[...untouchable].map(String), ...[...sold].map(String)]);
  return (adapter.freeAgents ?? []).filter(f => uni.has(String(f.id)) && !blocked.has(String(f.id))
    && Number.isFinite(f.ros_ppg) && f.position);
}

const priced = v => v != null && Number.isFinite(Number(v)) && Number(v) >= 0;

/**
 * The player Nick releases to claim `add`: among his roster at that point, one dropOk passes, not
 * acquired on the path and not `add`, with a FantasyCalc value no more than the claimed player's
 * (past the cap: the claim step counts the drop as what Nick gives for him). Bench before starters,
 * then the lowest value, then the id (deterministic). valueOf(id) -> FC value or null. Or null.
 */
export function pickDrop({ roster, add, dropOk, valueOf, starters = new Set(), acquired = new Set(), maxOverpay = 0 }) {
  const addV = valueOf(add);
  if (!priced(addV)) return null;
  const onField = new Set([...starters].map(String));
  const ok = roster.filter(id => String(id) !== String(add) && !acquired.has(String(id)) && dropOk(id)
    && priced(valueOf(id)) && !nickOverpays(Number(valueOf(id)), Number(addV), maxOverpay));
  ok.sort((x, y) => (onField.has(String(x)) - onField.has(String(y))) || (valueOf(x) - valueOf(y)) || String(x).localeCompare(String(y)));
  return ok[0] ?? null;
}

/**
 * FLIP-CLAIMS, the one rule check on a path with a claim (null = passes, else the reason):
 *   claim_not_flipped  a claimed player is not given away by a later step (he would be held at the end)
 *   protected_drop     the drop fails dropOk (160 / 80 / 277, an untouchable, a Blue chip, unscored)
 *   claim_sold         the claimed player is a pinned never-get or was sold this season (`sold`)
 *   no_fc_value        the drop or the claimed player has no FantasyCalc value (fails closed)
 *   claim_overpay      the drop is worth more than the claimed player past the cap (the claim step; the
 *                      flip step's own cap is the search's, on every trade step)
 * A path with no claim passes.
 */
export function claimRule(steps, { dropOk, valueOf, maxOverpay = 0, sold = new Set() }) {
  const soldS = new Set([...PINNED_NEVER_GET, ...[...sold].map(String)]);
  for (const st of steps) {
    if (!isClaim(st)) continue;
    const add = st.get.map(String), drop = st.give.map(String);
    // gets-floor.js#isFlipPieceClaim: the one flip-piece rule, shared with FLIP-STRANDED (#432).
    if (!isFlipPieceClaim(st, steps)) return 'claim_not_flipped';
    if (!drop.length || !drop.every(id => dropOk(id))) return 'protected_drop';
    if (add.some(id => soldS.has(id))) return 'claim_sold';
    const dv = drop.map(valueOf), av = add.map(valueOf);
    if (![...dv, ...av].every(priced)) return 'no_fc_value';
    if (nickOverpays(dv.reduce((s, v) => s + Number(v), 0), av.reduce((s, v) => s + Number(v), 0), maxOverpay)) return 'claim_overpay';
  }
  return null;
}

/**
 * The stranded branch of a claim path (Nick 2026-09-25): the claim went through and the flip leg did
 * not, so Nick holds the claimed free agent and has lost the drop. prob: the chance of ending there;
 * delta: its probability-weighted change (per the steps' own dice, so on the confirm dice once
 * re-priced). null when the path has no claim.
 */
export function strandedBranch(steps) {
  const i = steps.findIndex(isClaim);
  if (i < 0) return null;
  const add = steps[i].get.map(String);
  const j = steps.findIndex((s, k) => k > i && s.give.map(String).some(id => add.includes(id)));
  const last = j < 0 ? steps.length - 1 : j - 1;
  const outs = pathOutcomes(steps).filter(o => o.stop_after >= i && o.stop_after <= last);
  const prob = outs.reduce((s, o) => s + o.prob, 0);
  return { prob, delta: prob > 0 ? outs.reduce((s, o) => s + o.prob * o.delta, 0) / prob : null };
}

/** Distinct first steps by risk mode's confirmed best, and whether they differ (the plan's MODES check). */
export function modesFirstSteps(confirmedBest, keyOf) {
  const out = Object.fromEntries(Object.entries(confirmedBest).map(([m, p]) => [m, p ? keyOf(p.steps[0]) : null]));
  const keys = Object.values(out).filter(Boolean);
  return { modes_first_steps: out, modes_differ: new Set(keys).size > 1 };
}
