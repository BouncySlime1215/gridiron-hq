#!/usr/bin/env node
// SELL-HIGH FILTER weekly grade (batch D item 12). Read-only.
// Usage: SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<local copy> node scripts/rnd/sell-high-grade.mjs [--seasons 2021,2022,2023,2024,2025] [--weeks 5-14]
// Prints the pooled grade against the pre-registered pass bar, then the per-week rows. No names:
// flags are listed by player id only.
import { rows, row } from '../../server/db/index.js';
import { gradeSellHigh, SELL_HIGH_RULE } from '../../server/services/campaign/sell-high.js';
import { readTdWeeks } from '../../server/services/campaign/sell-high-inputs.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const seasons = arg('seasons', '2021,2022,2023,2024,2025').split(',').map(Number);
const [w0, w1] = arg('weeks', '5-14').split('-').map(Number);
const asOfWeeks = Array.from({ length: w1 - w0 + 1 }, (_, i) => w0 + i);

const db = { rows, row };
const bySeason = new Map();
const sources = {};
for (const s of seasons) {
  const r = readTdWeeks(db, { season: s });
  sources[s] = r.sources;
  bySeason.set(s, r.players);
}
const g = gradeSellHigh(bySeason, { asOfWeeks });
const { flags, ...summary } = g;
console.log(JSON.stringify({ rule: SELL_HIGH_RULE, seasons, as_of_weeks: asOfWeeks, sources, ...summary,
  flag_ids: flags.map(f => `${f.season}:${f.player}@W${f.week}`) }, null, 2));
