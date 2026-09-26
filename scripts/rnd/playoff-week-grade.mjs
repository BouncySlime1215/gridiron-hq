#!/usr/bin/env node
// PLAYOFF-WEEK VALUE grade (batch D item 28). Read-only.
// Usage: SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<local copy> node scripts/rnd/playoff-week-grade.mjs [--seasons 2023,2024,2025] [--as-of 13]
// Prints the grade against the pre-registered pass bar (docs/tdd/PLAYOFF-WEEK-VALUE-PREREG.md).
// Counts and MAEs only; no player ids or names.
import { rows, row } from '../../server/db/index.js';
import { gradePlayoffWeek, PLAYOFF_WEEK_PASS_BAR, PLAYOFF_WEEK_RULE } from '../../server/services/campaign/playoff-week.js';
import { readPlayoffWeekLines } from '../../server/services/campaign/playoff-week-inputs.js';
import { PPR } from '../../server/services/scoring.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const seasons = arg('seasons', '2023,2024,2025').split(',').map(Number);
const asOf = Number(arg('as-of', String(PLAYOFF_WEEK_PASS_BAR.as_of_week)));
// Another as-of week is an exploratory read, not the pre-registered grade.
const bar = { ...PLAYOFF_WEEK_PASS_BAR, as_of_week: asOf };

const db = { rows, row };
const bySeason = new Map();
const sources = {};
for (const s of seasons) {
  const r = readPlayoffWeekLines(db, { season: s, scoring: PPR });
  sources[s] = r.sources.usage;
  bySeason.set(s, r.lines);
}
const g = gradePlayoffWeek(bySeason, bar);
console.log(JSON.stringify({ rule: PLAYOFF_WEEK_RULE, pre_registered: asOf === PLAYOFF_WEEK_PASS_BAR.as_of_week,
  seasons, sources, ...g }, null, 2));
