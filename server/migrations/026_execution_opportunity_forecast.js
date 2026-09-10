export const name = '026_execution_opportunity_forecast';

/**
 * Codex audit finding E4 (2026-09-10): `attemptAcceptance` (the one gated
 * entry point for recording an ACCEPTED position, nfl-execution-decision.js)
 * runs its market-line-corridor and suspect-price checks against
 * `modelLine`/`marketLine`/`fairProbability` -- but those arrived as plain
 * caller-supplied request-body fields, and the actual UI never sent them at
 * all, silently reporting both checks `not_evaluated` on every real
 * acceptance. The fix the audit specifies is to derive these values
 * SERVER-SIDE from the frozen decision, the same way `event_key`/
 * `participant` already are (see nfl-execution-decision.js's own header) --
 * but there was nowhere to derive them FROM, because the opportunity ledger
 * never recorded what the model actually said at decision time.
 *
 * These three columns are that missing record: the model's own projected
 * line, its calibrated win probability, and the market's line AT THE MOMENT
 * the opportunity was opened (frozen, so a later market move cannot quietly
 * change what the corridor check is comparing against). All three are
 * nullable -- an opportunity opened before this migration, or one whose
 * caller genuinely has no calibrated probability (an uncalibrated market
 * abstains everywhere else in this codebase; the same honesty applies here),
 * carries NULL rather than a fabricated number, and the two safety gates
 * that read them already treat a missing input as `not_evaluated`, never as
 * a passing check.
 */
export function up(db) {
  const cols = db.prepare(`PRAGMA table_info(nfl_execution_opportunities)`).all().map(c => c.name);
  if (!cols.includes('model_line')) db.exec(`ALTER TABLE nfl_execution_opportunities ADD COLUMN model_line REAL`);
  if (!cols.includes('model_probability')) db.exec(`ALTER TABLE nfl_execution_opportunities ADD COLUMN model_probability REAL`);
  if (!cols.includes('market_line_at_decision')) db.exec(`ALTER TABLE nfl_execution_opportunities ADD COLUMN market_line_at_decision REAL`);
}

export function down(db) {
  // SQLite's DROP COLUMN requires no dependent generated columns/indexes on
  // these -- there are none, so the plain form is safe. Nullable additive
  // columns; nothing else in this migration to reverse.
  const cols = db.prepare(`PRAGMA table_info(nfl_execution_opportunities)`).all().map(c => c.name);
  if (cols.includes('market_line_at_decision')) db.exec(`ALTER TABLE nfl_execution_opportunities DROP COLUMN market_line_at_decision`);
  if (cols.includes('model_probability')) db.exec(`ALTER TABLE nfl_execution_opportunities DROP COLUMN model_probability`);
  if (cols.includes('model_line')) db.exec(`ALTER TABLE nfl_execution_opportunities DROP COLUMN model_line`);
}
