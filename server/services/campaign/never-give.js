/**
 * NEVER-GIVE: Nick's players no plan may offer, pinned by id so the rule holds even when his
 * 'untouchable:' notes are missing or unread (the notes-derived set fails open). Nick 9/24 (ONE-PLAN
 * 10b.3): Nico Collins (160) and Chase Brown (80) stay untouchable in every mode. A.J. Brown (277)
 * may move only for a Blue chip who is a consistent weekly scorer now; nothing measures "consistent"
 * yet, so until AJ-HEALTHY prices him (ONE-PLAN night 5: "until coded 277 stays untouchable") he is
 * pinned here too. Applies to Nick's own roster only: these ids are never a give, walk-away or flip leg.
 */
export const PINNED_NEVER_GIVE = Object.freeze(['160', '80', '277']);

/**
 * NEVER-GET (integration-7): players no plan may bring back, pinned by id so the rule holds even when
 * the season trade ledger is missing. Chris Olave (290), whom Nick sold this season (no buy-backs, no
 * exceptions). Added to adapter.untouchable, which the planner already reads as never a target, a get,
 * a filler, a flip leg, a ladder row or a catch-up move.
 */
export const PINNED_NEVER_GET = Object.freeze(['290']);

/**
 * The adapter with the pinned never-give ids on Nick's roster and the pinned never-get ids on anyone
 * else's roster added to adapter.untouchable (nothing else changes).
 */
export function withNeverGive(adapter) {
  const mine = new Set((adapter.rosters?.get(adapter.league?.me) ?? []).map(String));
  const theirs = new Set([...(adapter.rosters ?? new Map())].filter(([t]) => String(t) !== String(adapter.league?.me)).flatMap(([, ids]) => ids.map(String)));
  const pinned = [...PINNED_NEVER_GIVE.filter(id => mine.has(id)), ...PINNED_NEVER_GET.filter(id => theirs.has(id))];
  if (!pinned.length) return adapter;
  return { ...adapter, untouchable: new Set([...[...(adapter.untouchable ?? [])].map(String), ...pinned]) };
}
