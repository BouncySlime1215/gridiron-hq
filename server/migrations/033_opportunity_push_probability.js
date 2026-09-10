export const name = '033_opportunity_push_probability';

/**
 * Codex correction C15: "The board does not supply the push probability
 * expected by the EV calculation, which defaults to zero."
 *
 * `nfl-policy.js` computed expected return as
 *
 *     EV = p_win * profit_multiple - p_loss
 *
 * with `candidate.push_probability ?? 0`. Nothing in the decision board ever
 * set that field, so every integer handicap was priced as though a push were
 * impossible. It is not: a -3 spread pushes on roughly one NFL game in ten,
 * and counting that mass as decided overstates the win and the loss branch
 * together.
 *
 * Migration 026 froze `model_line`, `model_probability` and
 * `market_line_at_decision` onto the opportunity so the acceptance gates could
 * check real evidence rather than trust a request body. The push treatment
 * belongs in the same place and for the same reason: correction C15 requires
 * eligibility to be RE-CHECKED at the refreshed offered price, and that
 * recomputation needs to know what push mass the original decision assumed --
 * not re-derive one at acceptance time, which would be a different forecast
 * wearing the frozen one's name.
 *
 * NULL is meaningful here and is not backfilled to zero. A null push
 * probability on an integer handicap means "unknown", and the refreshed gate
 * refuses to authorize rather than assuming none. Backfilling zero would write
 * exactly the defect this migration exists to remove into the data, where it
 * would be permanent and invisible.
 */
export function up(db) {
  const columns = db.prepare(`PRAGMA table_info(nfl_execution_opportunities)`).all().map(c => c.name);
  if (!columns.length) return;
  if (!columns.includes('push_probability')) {
    db.exec(`ALTER TABLE nfl_execution_opportunities ADD COLUMN push_probability REAL`);
  }
  if (!columns.includes('push_treatment')) {
    // 'zero_by_arithmetic_half_point' | 'supplied_estimate' | 'unknown_on_integer_line'.
    // Stored alongside the number so a null can be read as "unknown" rather
    // than as "nobody wrote anything here".
    db.exec(`ALTER TABLE nfl_execution_opportunities ADD COLUMN push_treatment TEXT`);
  }
}

export function down(db) {
  // Additive and nullable: there is nothing to undo that would not also throw
  // away the recorded push treatment of every decision made since. The columns
  // cost nothing when unused, and a destroyed distinction cannot be recovered.
  const recorded = db.prepare(`SELECT COUNT(*) n FROM nfl_execution_opportunities
    WHERE push_treatment IS NOT NULL`).get()?.n ?? 0;
  if (recorded) {
    throw new Error(
      `033_opportunity_push_probability: refusing to downgrade — ${recorded} opportunity row(s) record a ` +
      'push treatment the earlier schema cannot hold. Dropping it would leave their expected returns ' +
      'unreproducible.');
  }
}
