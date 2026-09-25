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
 * Flag GRIDIRON_GETS_FLOOR: '1' enforces (targets under the floor are dropped before the top-N
 * slice, so the next Blue chip takes the slot); 'shadow' reads every searched target and counts it
 * as would-drop while nothing served moves; unset or '0' is off (the producer's entry stays byte for
 * byte the incumbent's, the committed contract fixture). Pure: the env arrives as planner settings.
 */

export const GETS_FLOOR_ENV = 'GRIDIRON_GETS_FLOOR';
/** Nick's floor for the final get: Blue chip, 83+ (10b.2). */
export const DEFAULT_GET_FLOOR = 83;
/** How many under-floor reads the run keeps by name (the counts cover all of them). */
const BELOW_KEPT = 20;

/** 'on' | 'shadow' | 'off'. */
export function getsFloorFlag(env = {}) {
  const v = env?.[GETS_FLOOR_ENV];
  if (v === '1') return 'on';
  if (v === 'shadow') return 'shadow';
  return 'off';
}

/** The destination's min_get_score may only RAISE the floor (Nick's 83 is the least); anything else is the default. */
export function getFloorOf(tol) {
  const v = Number(tol?.min_get_score);
  return tol?.min_get_score != null && Number.isFinite(v) ? Math.max(DEFAULT_GET_FLOOR, v) : DEFAULT_GET_FLOOR;
}

/** How a card names the floor: "Blue chip floor (83+)", "Blue chip floor (88+)". */
export const floorName = floor => `Blue chip floor (${floor}+)`;

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
    dropped: 0, would_drop: 0, below: [], refused: [] };
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
