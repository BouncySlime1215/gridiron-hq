export const name = '105_trade_outcomes_withdrawn';
/**
 * trade_outcomes.status may be 'withdrawn' (#409 review finding 1): a proposal the
 * proposer took back is not the other manager's silence. See
 * server/db/trade-outcomes-withdrawn.js for why an existing database is widened by
 * the preflight repair instead (trade_outcomes is a foreign-key parent). This file
 * covers a fresh database, where 067 creates the table after preflight has run and
 * no child row exists yet; with child rows present it leaves the table to the next
 * boot's preflight rather than abort startup.
 */
import { allowsWithdrawn, childRows, widenTradeOutcomesStatus } from '../db/trade-outcomes-withdrawn.js';

export function up(db) {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trade_outcomes'`).get();
  if (!exists || allowsWithdrawn(db)) return;
  if (childRows(db) > 0) {
    console.warn('[db] 105_trade_outcomes_withdrawn: child rows reference trade_outcomes; the preflight repair widens it on the next boot');
    return;
  }
  widenTradeOutcomesStatus(db);
}

/**
 * The widened CHECK is a superset of 067's, so there is nothing to undo safely: narrowing it
 * again would need a rebuild of a foreign-key parent (and would fail on any 'withdrawn' row).
 * Rolling back past 105 leaves the wider CHECK in place; 067's own down drops the table.
 */
export function down() {}
