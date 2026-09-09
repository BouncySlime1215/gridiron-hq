export const name = '025_candidate_finding_discovery_note';

/**
 * `resolution_note` (024_candidate_findings.js) is documented as explaining
 * a TERMINAL resolution (why a finding was promoted/rejected) — using it to
 * also explain HOW a finding was discovered (registerManuallyObservedFinding,
 * nfl-candidate-findings.js) overloads that meaning. A dedicated,
 * always-nullable column keeps the two honest and separate: a manually
 * observed finding is transparent about it from the moment it's registered,
 * not just at the end.
 */
export function up(db) {
  const cols = db.prepare('PRAGMA table_info(nfl_candidate_findings)').all().map(c => c.name);
  if (!cols.includes('discovery_note')) {
    db.exec('ALTER TABLE nfl_candidate_findings ADD COLUMN discovery_note TEXT');
  }
}

export function down(db) {
  const cols = db.prepare('PRAGMA table_info(nfl_candidate_findings)').all().map(c => c.name);
  if (cols.includes('discovery_note')) db.exec('ALTER TABLE nfl_candidate_findings DROP COLUMN discovery_note');
}
