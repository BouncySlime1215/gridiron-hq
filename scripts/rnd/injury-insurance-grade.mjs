#!/usr/bin/env node
// INJURY INSURANCE grade (batch D item 27). Read-only.
// Usage: SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<local copy> node scripts/rnd/injury-insurance-grade.mjs [--seasons 2023,2024,2025]
// For each held-out season S the handoff is fit through S-1 (contingency.js#handcuffValue) and judged on
// S's games where the starter missed: the backup's predicted points_without vs what he scored. Prints the
// pooled grade against the pre-registered pass bar and per-season counts. Ids only, no names.
import { rows } from '../../server/db/index.js';
import { handcuffValue } from '../../server/services/contingency.js';
import { gradeInsurance, INSURANCE_PASS_BAR } from '../../server/services/campaign/injury-insurance.js';
import { readGradeGames } from '../../server/services/campaign/injury-insurance-inputs.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const seasons = arg('seasons', '2023,2024,2025').split(',').map(Number);

const games = [];
const per = {};
for (const s of seasons) {
  const g = readGradeGames({ rows }, { season: s, entries: handcuffValue({ through: s - 1 }) });
  per[s] = { games: g.length, passers: g.filter(x => x.passes).length };
  games.push(...g);
}
console.log(JSON.stringify({ bar: INSURANCE_PASS_BAR, seasons, per_season: per, ...gradeInsurance(games) }, null, 2));
