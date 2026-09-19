export const name = '054_audit_registry_corrected_alpha';

/**
 * FINAL ORDER #4 (2026-09-16, RUNBOOK §10.4, item c).
 *
 * `runAudit()` has always corrected its significance threshold for how many
 * audits were sealed before this one -- a Sidak step,
 * `1 - (1 - 0.05)^(1/(priorTests + 1))` -- and then thrown both inputs away.
 * The sealed row records `significant`, but not the alpha it was judged
 * against nor how many prior tests produced that alpha.
 *
 * That makes the correction unauditable in exactly the way the registry
 * exists to prevent. A reader six months later cannot tell whether a sealed
 * "significant" was cleared at 0.05 or at 0.002, and cannot reproduce the
 * decision without replaying the whole registry's history to recount the
 * prior tests. Worse, the count is time-dependent: the same audit sealed
 * later faces a stricter bar, which is correct behaviour and completely
 * invisible after the fact.
 *
 * Both are additive and nullable: rows sealed before this migration keep
 * NULL, which honestly says "not recorded" rather than inventing a number
 * for them retroactively.
 */
export function up(db) {
  const columns = new Set(db.prepare(`PRAGMA table_info(audit_registry)`).all().map(c => c.name));
  if (!columns.has('corrected_alpha_at_seal')) {
    db.exec(`ALTER TABLE audit_registry ADD COLUMN corrected_alpha_at_seal REAL`);
  }
  if (!columns.has('prior_tests_at_seal')) {
    db.exec(`ALTER TABLE audit_registry ADD COLUMN prior_tests_at_seal INTEGER`);
  }
}

export function down(db) {
  // Same posture as 052: a recorded correction is evidence about how a sealed
  // audit was judged, and dropping it would silently turn "cleared a bar of
  // 0.002 against 25 prior tests" back into an unqualified "significant".
  // A downgrade that would destroy that is refused rather than performed.
  const observed = db.prepare(
    `SELECT COUNT(*) n FROM audit_registry WHERE corrected_alpha_at_seal IS NOT NULL`).get()?.n ?? 0;
  if (observed) {
    throw new Error(`054_audit_registry_corrected_alpha: refusing to downgrade — ${observed} sealed audit(s) `
      + 'record the corrected alpha they were judged against, which the earlier schema cannot represent.');
  }
  db.exec(`ALTER TABLE audit_registry DROP COLUMN corrected_alpha_at_seal`);
  db.exec(`ALTER TABLE audit_registry DROP COLUMN prior_tests_at_seal`);
}
