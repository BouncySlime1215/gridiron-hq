export const name = '040_audit_registry_always_valid_split';

/**
 * Giant Plan Section 8.5: audit-registry.js's runAudit() collapses two
 * different numbers into one column before persisting them:
 *
 *   const alwaysValidP = alwaysValid
 *     ? (alwaysValid.p_always_valid ?? alwaysValid.p_fixed_sample_only)
 *     : null;
 *
 * `p_always_valid` (an anytime-valid mSPRT p-value, only computable when
 * sigma was declared in advance) and `p_fixed_sample_only` (a fixed-sample
 * p-value computed the same way but from a plug-in sigma estimate, which is
 * NOT anytime-valid -- see backtest-significance.js and Codex correction
 * C17) answer different questions. Reading the persisted row back could not
 * tell which one had actually been stored, or on what variance basis, once
 * they had already been null-coalesced into a single `always_valid_p`
 * column. These three columns let the sealed record keep both numbers (one
 * of the two is always NULL, since alwaysValidPValue only ever returns one
 * or the other for a given call) and the basis they were computed on,
 * exactly as the in-memory result object already exposes them.
 *
 * The existing `always_valid_p` column is left in place rather than
 * dropped: it is still populated (application code updated separately) so
 * every existing reader of it keeps working, and SQLite's ALTER TABLE DROP
 * COLUMN on a column referenced by nothing else here is a needless third
 * risk to take in the same migration.
 */
export function up(db) {
  const cols = db.prepare(`PRAGMA table_info(audit_registry)`).all().map(c => c.name);
  for (const [column, declaration] of [
    ['always_valid_p_anytime', 'REAL'],
    ['always_valid_p_fixed_sample', 'REAL'],
    ['always_valid_variance_source', 'TEXT'],
  ]) {
    if (!cols.includes(column)) db.exec(`ALTER TABLE audit_registry ADD COLUMN ${column} ${declaration}`);
  }
}

export function down(db) {
  // No-op: SQLite's ALTER TABLE DROP COLUMN would need the same table-rebuild
  // treatment as 039, and these three columns are purely additive (nothing
  // reads them before this migration exists) -- there is nothing an older
  // version of the code would break on by finding them still present.
}
