#!/usr/bin/env node
/**
 * AUTOPSY-01: build `weekly_autopsy` (migration 087) for one league, every completed
 * scoring period, every team. The producer is server/services/weekly-autopsy.js;
 * EVAL E7 reads the table.
 *
 * Default off: runs only with GRIDIRON_WEEKLY_AUTOPSY=1 or preview mode on
 * (server/services/preview-mode.js); otherwise it prints why and writes nothing.
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/build-weekly-autopsy.mjs [--league 4] [--season 2026] [--rows]
 * --rows prints the stored rows after the run. Exit 1 when the league is missing.
 */
process.env.SCHEDULER_DISABLED = '1';
const { rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { runWeeklyAutopsy, AUTOPSY_DEFAULT_LEAGUE } = await import('../server/services/weekly-autopsy.js');

const arg = name => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};
const leagueId = Number(arg('--league') ?? AUTOPSY_DEFAULT_LEAGUE);
const season = arg('--season') == null ? null : Number(arg('--season'));

await runMigrations();
const result = runWeeklyAutopsy({ leagueId, season });
console.log(JSON.stringify(result, null, 2));
if (process.argv.includes('--rows') && !result.off) {
  const got = rows(`SELECT season, week, team_id, actual_points, expected_points, optimal_expected_points,
      decision_points, luck_points, bench_points_lost, missing_projections, status, line
    FROM weekly_autopsy WHERE league_id = ? ORDER BY season, week, team_id`, leagueId);
  console.table(got);
}
process.exit(result.ok ? 0 : 1);
