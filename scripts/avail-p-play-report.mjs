#!/usr/bin/env node
/**
 * BROKEN-E: how many players this week are served a chance to play the engine
 * never measured, and what the fitted prior for them is. Read-only.
 *
 *   node scripts/avail-p-play-report.mjs [season] [week]
 *
 * Defaults to trade-engine.js#tradeWeekContext (the week the trade engine prices).
 */
import { availPPlayWeek } from '../server/services/avail-p-play.js';
import { tradeWeekContext } from '../server/services/trade-engine.js';

const ctx = tradeWeekContext();
const season = Number(process.argv[2]) || ctx.season;
const week = Number(process.argv[3]) || ctx.week;
const w = availPPlayWeek(season, week);

const byReason = {};
const byPos = {};
let old092 = 0;
for (const [id, row] of w.rows) {
  const out = w.of(id, row.position);
  const key = out.status === 'ok' ? 'ok' : out.reason;
  byReason[key] = (byReason[key] ?? 0) + 1;
  if (out.status === 'unknown') {
    byPos[row.position] ??= out.prior;
    if (row.active_probability === 0.92) old092++;
  }
}
console.log(JSON.stringify({
  season, week, rows: w.rows.size, by_status: byReason,
  unknown_served_092_on_old_path: old092,
  prior_by_position: byPos,
  kicker_prior: w.of(-1, 'K').prior
}, null, 2));
