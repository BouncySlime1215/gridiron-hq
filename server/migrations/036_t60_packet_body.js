export const name = '036_t60_packet_body';

/**
 * Giant Plan section 8.10/8.1, audit-consolidation stage 1.
 *
 * `nfl_t60_observations.packet_hash` (migration 034) records that a packet was
 * frozen and lets a caller notice a re-freeze producing the same content. It
 * does not let anyone read WHAT was frozen. Section 4.1's own line applies
 * here as much as it does to the forecast-packet contract: "A hash without
 * retained content cannot reconstruct a decision." A missed capture, a
 * quarantined source, or a late-arrival exclusion are all facts an evaluation
 * needs to see later, and today they exist only for as long as the process
 * that computed them keeps them in memory.
 *
 * `packet_json` is additive and nullable, exactly like migration 033's
 * `push_probability`/`push_treatment`: rows written before this column existed
 * simply have nothing here, which is the honest state ("we did not retain the
 * body then"), not a value to backfill or fake.
 *
 * No guard/trigger handling is needed here the way 027 needed one for
 * `nfl_execution_lifecycle_events` and 034 needed one for
 * `nfl_capacity_events`: `nfl_t60_observations` carries no append-only
 * trigger (its whole point is a mutable state machine —
 * scheduled -> collected -> frozen -> decided -> settled, or missed/failed —
 * see migration 034), and SQLite can add a nullable column without rebuilding
 * the table. There is nothing to rebuild and nothing to guard.
 */
export function up(db) {
  const columns = db.prepare(`PRAGMA table_info(nfl_t60_observations)`).all().map(c => c.name);
  if (!columns.length) return;
  if (!columns.includes('packet_json')) {
    db.exec(`ALTER TABLE nfl_t60_observations ADD COLUMN packet_json TEXT`);
  }
}

export function down(db) {
  // Additive and nullable: there is nothing to undo that would not also throw
  // away the retained body of every packet frozen since. The column costs
  // nothing when unused, and a destroyed packet body cannot be recomputed —
  // it is exactly the evidence a re-run at a later wall-clock time cannot
  // reproduce (received_at, snapshot_at and cutoff eligibility are all facts
  // about a specific moment already past).
  const recorded = db.prepare(`SELECT COUNT(*) n FROM nfl_t60_observations
    WHERE packet_json IS NOT NULL`).get()?.n ?? 0;
  if (recorded) {
    throw new Error(
      `036_t60_packet_body: refusing to downgrade — ${recorded} observation row(s) retain a packet body the ` +
      'earlier schema cannot hold. Dropping it would make their frozen evidence unreconstructible.');
  }
}
