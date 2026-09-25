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

/* ------------------------------------------------------------------ FLIP-STRANDED */

/**
 * FLIP-STRANDED (Nick 2026-09-25, Batch D item 1): the floor above reads only what Nick holds at a
 * path's END. A chained path (a chip picked up in leg 1 and spent in leg 2) or a flip (buy from A, sell
 * to B) leaves him holding the leg-1 player when leg 2 is turned down. So every holding after each leg
 * but the last must pass the same floor (floorRead, the same 83+ or the destination's higher
 * min_get_score; unscored fails closed). Each leg's own never-give, overpay and buy-back checks were
 * already per step (search.js#nickOverpays per step, trade-memory.js#stepMemory per step, flip legs
 * both checked), so this adds only the floor on what he holds in between.
 *
 * A waiver claim traded away later in the same path is exempt (isFlipPieceClaim, flip claims).
 *
 * Flag GRIDIRON_FLIP_STRANDED: ON BY DEFAULT (a hard rule, as GRIDIRON_GETS_FLOOR). Unset or '1'
 * drops the path or flip; 'shadow' only counts; only an explicit '0' turns it off, with a loud warning.
 */
export const FLIP_STRANDED_ENV = 'GRIDIRON_FLIP_STRANDED';
export const FLIP_STRANDED_OFF_WARNING = `WARNING: ${FLIP_STRANDED_ENV}=0 turns OFF the floor on what Nick holds between legs: a path or flip can strand him with a player under the Blue chip floor.`;
/** How many stranded holds the run keeps as examples (the counts cover all of them). */
const STRANDED_KEPT = 10;

/** 'on' (default) | 'shadow' | 'off' (only an explicit '0'). */
export function flipStrandedFlag(env = {}) {
  const v = env?.[FLIP_STRANDED_ENV];
  if (v === '0') return 'off';
  if (v === 'shadow') return 'shadow';
  return 'on';
}

/** What Nick holds after each leg (gets minus later gives, as heldAtEnd): one Set per step; the last is heldAtEnd. */
export function heldAfterEachLeg(steps) {
  const held = new Set();
  return (steps ?? []).map(st => {
    for (const id of st.give) held.delete(String(id));
    for (const id of st.get) held.add(String(id));
    return new Set(held);
  });
}

/**
 * Flip claims (Nick 2026-09-25): a free agent got by a waiver claim (step.claim) may be held between legs
 * only as a flip piece, i.e. every player the claim brings in is traded away in a later leg of the same
 * path and so is never held at its end. The ONE rule for it: the claim side (SEARCH-WIDE claim steps)
 * reads this too. A player got by trade is never a flip piece. Claims still obey every other rule
 * (never-get, sold, protected drops, beats doing nothing); this only exempts them from the floor between legs.
 */
export function isFlipPieceClaim(step, path) {
  if (step?.claim !== true || !step.get?.length) return false;
  const i = (path ?? []).indexOf(step);
  if (i < 0) return false;
  const laterGives = new Set(path.slice(i + 1).flatMap(st => st.give.map(String)));
  return step.get.every(id => laterGives.has(String(id)));
}

/** Holdings after each leg but the last that fail `passes(id)`, flip-piece claims exempt: [{ leg (0-based), player }]. */
export function strandedHolds(steps, passes) {
  const after = heldAfterEachLeg(steps);
  const exempt = new Set((steps ?? []).filter(st => isFlipPieceClaim(st, steps)).flatMap(st => st.get.map(String)));
  const out = [];
  for (const [i, held] of after.slice(0, -1).entries()) for (const id of held) if (!exempt.has(id) && !passes(id)) out.push({ leg: i, player: id });
  return out;
}

/** A flip as two legs: leg 1 buys the player from A, leg 2 sells him to B (a flip idea without legs: the player alone). */
export const flipSteps = f => {
  const ids = xs => (xs ?? []).filter(x => x != null);
  return [{ give: ids(f.legs?.give_a_ids ?? [f.legs?.give_a]), get: [f.player] }, { give: [f.player], get: ids(f.legs?.get_b_ids ?? [f.legs?.get_b]) }];
};

/**
 * The planner's strand check for one league run. Reads the floor itself (floorRead, its own cache) so
 * GETS-FLOOR's counts keep meaning "candidate final gets". pathStrands(p) / flipStrands(f): whether it
 * leaves a hold under the floor between legs (always false when off); each call counts once into the
 * sink (flips: every entry of flip.top and flip.realised).
 */
export function makeStranded(adapter, { env = {}, tolerances = null } = {}) {
  const mode = flipStrandedFlag(env);
  const floor = getFloorOf(tolerances);
  const scoreOf = typeof adapter?.scoreOf === 'function' ? adapter.scoreOf : null;
  const drop = mode === 'on' ? 'dropped' : 'would_drop';
  const sink = { mode, floor, [`paths_${drop}`]: 0, [`flips_${drop}`]: 0, examples: [],
    ...(mode === 'off' ? { warning: FLIP_STRANDED_OFF_WARNING } : {}) };
  const reads = new Map();
  const read = id => { if (!reads.has(id)) reads.set(id, floorRead(scoreOf, id, floor)); return reads.get(id); };
  const check = (steps, kind) => {
    if (mode === 'off') return false;
    const bad = strandedHolds(steps, id => read(id).passes);
    if (!bad.length) return false;
    sink[`${kind}_${drop}`]++;
    for (const b of bad) {
      if (sink.examples.length >= STRANDED_KEPT) break;
      const r = read(b.player);
      sink.examples.push({ kind, leg: b.leg + 1, player: b.player, score: r.score, why: r.why });
    }
    return true;
  };
  return { sink, on: mode === 'on', pathStrands: p => check(p.steps, 'paths'), flipStrands: f => check(flipSteps(f), 'flips') };
}
