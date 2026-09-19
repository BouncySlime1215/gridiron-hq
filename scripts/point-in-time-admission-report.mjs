/**
 * FINAL ORDER #3 (RUNBOOK §10.3): report how much of each raw input table
 * survives a real point-in-time admission check, per season.
 *
 * This is the reporting half of the guard in `server/modeling/contracts.js`.
 * It is deliberately READ-ONLY and enforces nothing: the measured answer
 * (below) is that turning strict admission on for the current season would
 * refuse four of the five input tables outright, which is a product decision
 * about what the model may serve, not a decision a script should make.
 *
 * MEASURED 2026-09-16 against /tmp/gridiron-extract/real.sqlite, using a
 * Week 5 Sunday kickoff as each season's cutoff and asking only for rows a
 * Week 5 prediction would legitimately want (that season, weeks 1-4):
 *
 *   2021-2024:  0 rows refused, every table, every season.
 *   2025:       nfl_injuries           1,024 / 1,024 refused (100%)
 *               nfl_team_week_features   132 /   132 refused (100%)
 *               nfl_snaps              5,971 / 5,971 refused (100%)
 *               nfl_pfr_adv            2,953 / 2,953 refused (100%)
 *               nfl_depth             11,004 admitted, 0 refused
 *
 * Two separate causes, and it matters which is which:
 *   - `nfl_injuries` HAS a clock column and nflverse stopped populating it.
 *     0% of 2025 and 2026 rows carry `modified_at` (100% of 2021-2022 did).
 *     That is a real upstream regression, not a policy choice.
 *   - `nfl_team_week_features`, `nfl_snaps` and `nfl_pfr_adv` never had a
 *     clock at all. They are grandfathered before 2025-01-01 because the
 *     historical research in this repository was built on them; refusing
 *     them after it is the policy choice.
 *
 * The honest reading: for the CURRENT season, only depth charts carry
 * evidence this codebase can defend as point-in-time. Everything else is
 * being read as "whatever the table says today".
 *
 * Usage:
 *   GRIDIRON_DB_PATH=/tmp/gridiron-extract/real.sqlite SCHEDULER_DISABLED=1 \
 *     node scripts/point-in-time-admission-report.mjs [--week 5] [--seasons 2021,2022,2023,2024,2025]
 */
import { rows } from '../server/db/index.js';
import { admitPointInTimeRows, NFL_OBSERVATION_CLOCKS } from '../server/modeling/contracts.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const week = Number(arg('--week', '5'));
const seasons = arg('--seasons', '2021,2022,2023,2024,2025').split(',').map(Number);

// A cutoff that is a real moment: the Sunday of the requested week. Approximated
// as the first Sunday on/after Sept 8 plus (week-1) weeks, 17:00Z kickoff --
// close enough that a row modified days earlier or later lands on the right
// side, which is what this measures.
function kickoffFor(season, wk) {
  const d = new Date(Date.UTC(season, 8, 8, 17, 0, 0));
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + (wk - 1) * 7);
  return d.toISOString();
}

const out = {};
for (const season of seasons) {
  const cutoffAt = kickoffFor(season, week);
  out[season] = { cutoff_at: cutoffAt, tables: {} };
  for (const table of Object.keys(NFL_OBSERVATION_CLOCKS)) {
    const clock = NFL_OBSERVATION_CLOCKS[table].column;
    const cols = ['season', 'week'].concat(clock ? [clock] : []).join(', ');
    let r;
    try {
      r = rows(`SELECT ${cols} FROM ${table} WHERE season = ? AND week < ?`, season, week);
    } catch (exc) {
      out[season].tables[table] = { error: exc.message };
      continue;
    }
    const verdict = admitPointInTimeRows(r, { table, cutoffAt });
    out[season].tables[table] = {
      regime: NFL_OBSERVATION_CLOCKS[table].regime,
      rows: r.length, admitted: verdict.admitted.length,
      refused: verdict.refused,
      refused_pct: r.length ? +(100 * verdict.refused / r.length).toFixed(1) : 0,
      refused_by: verdict.refused_by
    };
  }
}

console.log(JSON.stringify(out, null, 1));
const anyRefused = Object.values(out).some(s =>
  Object.values(s.tables).some(t => t.refused > 0));
console.error(anyRefused
  ? 'Rows were refused. This script enforces nothing — see LATEST-PLAN for what to do about it.'
  : 'No rows refused at this cutoff.');
