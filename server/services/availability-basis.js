/**
 * The one vocabulary for "what priced this player's chance to play".
 *
 * Defined here, in a file of its own, because three classifiers had grown for
 * the same question and none of them read a field:
 *
 *   - lineup-brain.js#playerAvailabilityBasis matched prose prefixes of the
 *     `source` sentence contingency.js builds for display.
 *   - the fantasy plan's accessor matched the same sentence into different
 *     words.
 *   - availabilityBasis() reports a third thing under the same name.
 *
 * A reworded sentence would have silently reclassified every fitted number as a
 * prior, in two consumers, with nothing failing. So contingency.js now states
 * the basis on the row, from this list, and consumers read it instead of
 * guessing. Nobody defines these strings again: import them.
 *
 * TWO DIFFERENT QUANTITIES SHARE THE NAME "basis", AND THEY ARE NOT THE SAME:
 *
 *   - `availability_basis` on a row (this list) is what priced THAT player in
 *     THAT week. It is a bare string.
 *   - `availabilityBasis()` returns { basis, missing, stamp } and reports which
 *     fit tables are loaded in this PROCESS. That is not a property of any
 *     player: with role rates on file the process basis reads 'role' while a
 *     given player still falls through to his durability prior, because the fit
 *     covers QB/RB/WR/TE and only weeks with a usable role cell. Six client
 *     surfaces read it as an object, which is what keeps the two apart at a
 *     call site. Its values are AVAILABILITY_FIT_BASIS below, deliberately a
 *     separate list.
 *
 * Stamping the process basis onto each row is the bug this replaces, not a
 * shortcut to keep: lineup-brain.js:640 on main does exactly that, so a row
 * reads 'role' whenever the tables are loaded, whoever the player is.
 */

/**
 * Every value a reader may see on a row's `availability_basis`, or may have to
 * produce for a row it could not find. Order is most to least informative.
 */
export const AVAILABILITY_BASIS = Object.freeze([
  // Fitted role layer priced this row: position, snap-share tier and games-gap
  // cell, from nfl_availability_role_rates.
  'role',
  // Fitted pooled/team injury-report rates priced it, from
  // nfl_availability_rates. No usable role cell for this player and week.
  'pooled',
  // Neither fit applied. The published report-status curve ran over the
  // player's own MEASURED career durability prior.
  'durability_prior',
  // Neither fit applied AND the player has no games on file, so the prior
  // itself was the standing constant. A default wearing a measurement's
  // clothes is what this value exists to stop.
  'default_durability',
  // CONSUMER ARM, never served on a row: there is no availability row for this
  // player at all. weeklyAvailability covers QB, RB, WR and TE, so a kicker or
  // a defence is outside the fit entirely. Distinct from default_durability,
  // which is a row that exists and carries a substituted prior.
  'unfitted_position',
  // CONSUMER ARM, never served on a row: a row arrived without the field.
  // Reachable only from a payload built before the field existed.
  'unrecognised'
]);

/** The subset weeklyAvailability can put on a row it is building. */
export const SERVABLE_AVAILABILITY_BASIS = Object.freeze([
  'role', 'pooled', 'durability_prior', 'default_durability'
]);

/**
 * Which availability model is loaded in this process — see the header. Not a
 * per-player value and deliberately not merged into the list above.
 */
export const AVAILABILITY_FIT_BASIS = Object.freeze(['role', 'pooled', 'constants']);

/** True when `value` is a member of the canonical row vocabulary. */
export function isAvailabilityBasis(value) {
  return AVAILABILITY_BASIS.includes(value);
}
