/**
 * NEVER-GIVE: Nick's players no plan may offer, pinned by id so the rule holds even when his
 * 'untouchable:' notes are missing or unread (the notes-derived set fails open). Nick 9/24 (ONE-PLAN
 * 10b.3): Nico Collins (160) and Chase Brown (80) stay untouchable in every mode. A.J. Brown (277)
 * may move only for a Blue chip who is a consistent weekly scorer now; nothing measures "consistent"
 * yet, so until AJ-HEALTHY prices him (ONE-PLAN night 5: "until coded 277 stays untouchable") he is
 * pinned here too. Applies to Nick's own roster only: these ids are never a give, walk-away or flip leg.
 */
export const PINNED_NEVER_GIVE = Object.freeze(['160', '80', '277']);

/** The adapter with the pinned ids on Nick's roster added to adapter.untouchable (nothing else changes). */
export function withNeverGive(adapter) {
  const mine = new Set((adapter.rosters?.get(adapter.league?.me) ?? []).map(String));
  const pinned = PINNED_NEVER_GIVE.filter(id => mine.has(id));
  if (!pinned.length) return adapter;
  return { ...adapter, untouchable: new Set([...[...(adapter.untouchable ?? [])].map(String), ...pinned]) };
}
