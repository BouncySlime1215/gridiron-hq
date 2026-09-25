export const name = '108_trade_outcomes_screenshot_source';
/**
 * trade_outcomes.source may be 'observed_screenshot' (SCREENSHOT-OFFERS): an offer read off
 * an ESPN screenshot in the league chat, with no ESPN tx id and no prediction recorded at
 * send time. See server/db/trade-outcomes-screenshot-source.js for why an existing database
 * is widened by the preflight repair instead (trade_outcomes is a foreign-key parent). This
 * file covers a fresh database, where 067 creates the table after preflight has run and no
 * child row exists yet; with child rows present it leaves the table to the next boot's
 * preflight rather than abort startup. Mirrors 105.
 */
import { childRows } from '../db/trade-outcomes-withdrawn.js';
import { allowsScreenshotSource, widenTradeOutcomesSource } from '../db/trade-outcomes-screenshot-source.js';

export function up(db) {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trade_outcomes'`).get();
  if (!exists || allowsScreenshotSource(db)) return;
  if (childRows(db) > 0) {
    console.warn('[db] 108_trade_outcomes_screenshot_source: child rows reference trade_outcomes; the preflight repair widens it on the next boot');
    return;
  }
  widenTradeOutcomesSource(db);
}

/**
 * The widened CHECK is a superset of 067's, so there is nothing to undo safely: narrowing it
 * again would need a rebuild of a foreign-key parent (and would fail on any screenshot row).
 */
export function down() {}
