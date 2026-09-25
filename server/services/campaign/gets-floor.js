/**
 * GETS-FLOOR: the player Nick ends a plan holding must be a real player. Nick 9/24 (ONE-PLAN 10b.2):
 * the final GET is a Blue chip, 83+ on the blue-chip score. The floor applies to the final leg's
 * target only; what Nick pays with (a "Level below" Bucky Irving, say) is never floored, and a
 * chip picked up on the way to the target is not a final get.
 *
 * The score is PLAYER-SCORE's (people/player-score.js via adapter.scoreOf; a labelled BLEND, not a
 * validated cutoff). With no score source, or no score for a player, the floor fails closed: an
 * unscored player is never certified as a Blue chip.
 *
 * Flag GRIDIRON_GETS_FLOOR: ON BY DEFAULT (integration-7: Nick's rule is a hard filter, not an
 * experiment). Unset or '1' enforces (targets under the floor are dropped before the top-N slice, and
 * a path is dropped unless everything Nick holds at its end passes); 'shadow' only counts; only an
 * explicit '0' turns it off, and the run then carries a loud warning. Pure: the env arrives as
 * planner settings.
 */

export const GETS_FLOOR_ENV = 'GRIDIRON_GETS_FLOOR';
/** Nick's floor for the final get: Blue chip, 83+ (10b.2). */
export const DEFAULT_GET_FLOOR = 83;
/** How many under-floor reads the run keeps by name (the counts cover all of them). */
const BELOW_KEPT = 20;

/** 'on' (default) | 'shadow' | 'off' (only an explicit '0'). */
export function getsFloorFlag(env = {}) {
  const v = env?.[GETS_FLOOR_ENV];
  if (v === '0') return 'off';
  if (v === 'shadow') return 'shadow';
  return 'on';
}

/** The loud line a run carries when Nick's floor is switched off by hand. */
export const GETS_FLOOR_OFF_WARNING = `WARNING: ${GETS_FLOOR_ENV}=0 turns OFF Nick's Blue chip floor (83+): served gets are not checked.`;

/** The destination's min_get_score may only RAISE the floor (Nick's 83 is the least); anything else is the default. */
export function getFloorOf(tol) {
  const v = Number(tol?.min_get_score);
  return tol?.min_get_score != null && Number.isFinite(v) ? Math.max(DEFAULT_GET_FLOOR, v) : DEFAULT_GET_FLOOR;
}

/** How a card names the floor: "Blue chip floor (83+)", "Blue chip floor (88+)". */
export const floorName = floor => `Blue chip floor (${floor}+)`;

/** Players Nick holds at the end of a path: every get, minus what a later step gives on (all final gets). */
export function heldAtEnd(steps) {
  const held = new Set();
  for (const st of steps) { for (const id of st.give) held.delete(String(id)); for (const id of st.get) held.add(String(id)); }
  return held;
}

/** One player against the floor. scoreOf: adapter.scoreOf (id -> { score, label } | null), or null. */
export function floorRead(scoreOf, pid, floor) {
  const player = String(pid);
  if (typeof scoreOf !== 'function') return { player, score: null, label: null, passes: false, why: 'no_score_source' };
  const row = scoreOf(pid);
  const score = Number(row?.score);
  if (row == null || row.score == null || !Number.isFinite(score)) return { player, score: null, label: null, passes: false, why: 'unscored' };
  const passes = score >= floor;
  return { player, score, label: row.label ?? null, passes, why: passes ? null : 'below_floor' };
}

/**
 * The planner's floor for one league run. keep(pid): whether a player may be a final get (a target,
 * a 1-for-2 filler on the final leg, a flip's leg-2 player); always true unless the flag is on. Every
 * read is counted once per player, so `dropped` (on) and `would_drop` (shadow, which reads the same
 * candidates as on) count every candidate get the floor skipped. refuse(pid): a target Nick named.
 */
export function makeGetsFloor(adapter, { env = {}, tolerances = null } = {}) {
  const mode = getsFloorFlag(env);
  const floor = getFloorOf(tolerances);
  const scoreOf = typeof adapter?.scoreOf === 'function' ? adapter.scoreOf : null;
  const sink = { mode, floor, source: scoreOf ? 'player_score' : 'none', checked: 0, passed: 0,
    dropped: 0, would_drop: 0, below: [], refused: [], ...(mode === 'off' ? { warning: GETS_FLOOR_OFF_WARNING } : {}) };
  const seen = new Map();
  const read = pid => {
    const k = String(pid);
    if (!seen.has(k)) {
      const r = floorRead(scoreOf, pid, floor);
      seen.set(k, r);
      sink.checked++;
      if (r.passes) sink.passed++;
      else {
        if (sink.below.length < BELOW_KEPT) sink.below.push(r);
        if (mode === 'on') sink.dropped++; else sink.would_drop++;
      }
    }
    return seen.get(k);
  };
  return {
    sink,
    read,
    keep: pid => (mode === 'off' ? true : read(pid).passes || mode !== 'on'),
    refuse: pid => {
      const r = read(pid);
      if (mode === 'on' && !r.passes && !sink.refused.some(x => x.player === r.player)) sink.refused.push(r);
    },
  };
}

/**
 * FLIP-CLAIMS x FLIP-STRANDED (coordinator 2026-09-25): the ONE rule on a waiver claim held between legs.
 * A claim step (step.claim === true, partner free_agent) is a flip piece when every player it claims is
 * traded away by a later (non-claim) step of the same path. Only a flip-piece claim may be held between
 * legs under the Blue chip floor; a player Nick TRADES for and holds between legs must pass the floor
 * (FLIP-STRANDED), and nothing may be held under it at the end (GETS-FLOOR, heldAtEnd).
 * path: the steps array, or a plan carrying `steps`; `step` must be one of them (by reference, so "later"
 * is well defined). Anything else, or a step that is not a claim, is false (fails closed).
 */
export function isFlipPieceClaim(step, path) {
  const steps = Array.isArray(path) ? path : path?.steps;
  if (step?.claim !== true || !Array.isArray(steps)) return false;
  const i = steps.indexOf(step);
  if (i < 0 || !step.get?.length) return false;
  const later = steps.slice(i + 1).filter(s => s?.claim !== true);
  return step.get.every(id => later.some(s => (s.give ?? []).some(g => String(g) === String(id))));
}
