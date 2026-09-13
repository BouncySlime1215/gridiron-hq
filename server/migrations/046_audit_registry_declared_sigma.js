export const name = '046_audit_registry_declared_sigma';

/**
 * u5-clv-endpoints (2026 pre-registration, Step 0 item 5).
 *
 * `always_valid_p` sits NULL on every one of the 15 rows this registry has
 * ever sealed (verified directly against server/data.sqlite, read-only, while
 * building this migration). Reading runAudit() explains why: the mSPRT it
 * calls is only ever fed a sigma by the PRODUCER, at RUN time -- and a
 * producer computing sigma from the very sequence it is about to test is
 * exactly the "estimated from the data under test" case backtest-
 * significance.js's alwaysValidPValue() already refuses to call anytime-valid
 * (Codex correction C17). Nothing in this file ever gave a producer a
 * legitimate, pre-committed sigma to reach for instead, so no caller ever
 * declared one, and the always-valid gate has silently never fired.
 *
 * The plan's own standing rule is that a variance used for sequential testing
 * must be "fixed in advance ... estimated from a hold-out sample, not the
 * sequence under test" (backtest-significance.js's own header comment on
 * alwaysValidPValue, and scripts/governed-reevaluation.mjs's
 * calibration-season sigma, which is discarded before later seasons are
 * scored). The only point at which a value is unambiguously "before looking
 * at the current data" is PREREGISTRATION -- before the audit has run even
 * once, let alone been re-run against a growing sequence. These three columns
 * let a caller commit to that number right there, on the same row that
 * freezes everything else about the hypothesis (code_hash, data_signature,
 * threshold), so it survives to run time without living in a script's local
 * constant that a future edit could silently change.
 *
 * Purely additive, exactly like migration 040's own ALTER pattern: nullable,
 * guarded by an existence check, nothing here is enforced or read by any
 * caller that predates this file.
 */
export function up(db) {
  const cols = db.prepare(`PRAGMA table_info(audit_registry)`).all().map(c => c.name);
  for (const [column, declaration] of [
    ['declared_sigma', 'REAL'],
    ['declared_tau', 'REAL'],
    ['declared_sigma_source', 'TEXT'],
  ]) {
    if (!cols.includes(column)) db.exec(`ALTER TABLE audit_registry ADD COLUMN ${column} ${declaration}`);
  }
}

export function down(db) {
  // No-op, for the same reason as migration 040's down(): SQLite's DROP
  // COLUMN needs a full table rebuild, these three columns are purely
  // additive, and nothing that predates this migration reads them.
}
