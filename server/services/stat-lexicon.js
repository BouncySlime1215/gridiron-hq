/**
 * This app's one catalogue of what its numbers mean, reached from outside the
 * Coach namespace.
 *
 * It is a wrapper and nothing else. Every string lives in
 * `server/services/coach/stat-names.js`, which is the single source of truth,
 * and none of them is copied here. That rule is not stylistic: a stat's display
 * name has to be the same on every screen, so a second copy is a second name
 * waiting to drift.
 *
 * **Why this imports the module rather than reading `docs/stat-lexicon.json`.**
 * The JSON is a printout of the module, emitted by `scripts/emit-stat-lexicon.mjs`
 * for anything that cannot import it — the client build. A server module can
 * import the module in the same process, with no file, no staleness window and
 * no absent-file branch. A server-side reader of the emitted file would be a
 * second source of truth whose freshness is guaranteed only by a check gate, so
 * between an edit to the module and the next emit it would serve yesterday's
 * explanations beside a catalogue serving today's.
 *
 * The dynamic import is a sequencing accommodation, not a design: the Coach
 * namespace has not merged yet. When it has, the fallback below becomes dead
 * code rather than a permanently live branch, which is the right direction for
 * a fallback to move in.
 */

// Loaded once, at import. A failure here means the Coach namespace is not on
// this branch yet, which is a known state and not an error to swallow silently
// — every accessor below reports it rather than returning a shape that looks
// like an answer.
const coach = await import('./coach/stat-names.js').catch(() => null);

/** Whether the catalogue is reachable at all, and why not when it is not. */
export function lexiconStatus() {
  return coach
    ? { available: true, reason: null }
    : { available: false, reason: 'catalogue_not_on_this_branch' };
}

/**
 * The whole catalogue, or a stated absence.
 *
 * Callers get `{ available, reason, concepts, fields, not_stored }` either way,
 * so the absent case cannot be mistaken for an empty one: `available` is false
 * and `reason` says which. A surface that renders numbers with no explanations
 * must say the explanations are not loaded, rather than showing bare numbers as
 * if none were owed.
 */
export function statLexicon() {
  if (!coach) return { ...lexiconStatus(), concepts: {}, fields: {}, not_stored: [] };
  return { ...lexiconStatus(), ...coach.statLexicon() };
}

/** Everything needed to label one `table.column`, or null. Null when absent, too. */
export function describeField(field) {
  return coach ? coach.describeField(field) : null;
}

/** The concept behind a `table.column`, with its id, or null. */
export function conceptFor(field) {
  return coach ? coach.conceptFor(field) : null;
}

/**
 * One concept by its id, in the same shape `conceptFor` returns.
 *
 * `STAT_CONCEPTS` is exported and frozen, so indexing it is the lookup rather
 * than a second way of doing it — but a bare index returns a concept with no
 * `id` on it, and `conceptFor` returns one with. A caller handling both would
 * carry two shapes for one thing, so this normalises to the shape with the id.
 */
export function conceptById(id) {
  if (!coach) return null;
  const found = Object.hasOwn(coach.STAT_CONCEPTS, id) ? coach.STAT_CONCEPTS[id] : null;
  return found ? { id, ...found } : null;
}
