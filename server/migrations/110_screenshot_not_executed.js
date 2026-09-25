export const name = '110_screenshot_not_executed';
/**
 * Nick (9/25): "screenshots that are trades that don't get done = confirmed nos." A screenshot offer
 * (source 'observed_screenshot') with no ESPN answer paired and no executed trade (same two teams,
 * >= 60% of the players) within 7 days of being posted is a DECLINE, and counts as a no in the grader,
 * LIVE-BLEND and E1. trade-outcomes.js#screenshotOutcomeOf settles new rows that way; this relabels the
 * rows an earlier build settled 'expired' (no ESPN id behind them) to match. 'declined' is already in
 * the status CHECK, so no rebuild.
 */
export const RELABEL_WHERE = `source = 'observed_screenshot' AND status = 'expired' AND matched_tx_id IS NULL`;
export const NOT_EXECUTED = 'screenshot_not_executed';

export function up(db) {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trade_outcomes'`).get();
  if (!exists) return;
  const cols = db.prepare('PRAGMA table_info(trade_outcomes)').all().map(c => c.name);
  if (!cols.includes('settle_reason')) return;
  db.prepare(`UPDATE trade_outcomes SET status = 'declined', settle_reason = ?
    WHERE ${RELABEL_WHERE}`).run(`${NOT_EXECUTED}: no ESPN answer paired and no executed trade with these players within 7 days of the post (relabelled from expired by 110)`);
}

/** Back to 'expired' for the rows this relabelled. */
export function down(db) {
  db.prepare(`UPDATE trade_outcomes SET status = 'expired'
    WHERE source = 'observed_screenshot' AND status = 'declined' AND matched_tx_id IS NULL AND settle_reason LIKE ?`).run('%relabelled from expired by 110%');
}
