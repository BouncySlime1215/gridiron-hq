#!/usr/bin/env node
// One-off re-check of ONLY the correlation/variance section after fixing the
// clamp-bias bug in teamBottomUpDistribution — does not need ensembleLine, so
// it is fast (buildPlayerWeekEngine only) and reuses the exact TEST_POINTS
// and calibration/sigmas the full walk-forward run used.
const dbPath = process.env.GRIDIRON_DB_PATH;
if (!dbPath || dbPath.includes('fantasy-football-dashboard/server/data.sqlite')) {
  throw new Error('Refusing: GRIDIRON_DB_PATH must point at the /tmp validation snapshot.');
}
const { rows } = await import('../server/db/index.js');
const { buildPlayerWeekEngine, clearPlayerWeekEngineCache } = await import('../server/services/player-week-engine.js');
const { fitTeamTotalCalibration, positionStatSigma, teamBottomUpScenarios, teamBottomUpDistribution } =
  await import('../server/services/bottom-up-team-total.js');

const FIT_MAX_SEASON = 2022;
const TEST_POINTS = [
  { season: 2023, week: 3 }, { season: 2023, week: 9 }, { season: 2023, week: 15 },
  { season: 2024, week: 3 }, { season: 2024, week: 9 }, { season: 2024, week: 15 },
  { season: 2025, week: 3 }, { season: 2025, week: 9 }, { season: 2025, week: 15 }
];
const calibration = fitTeamTotalCalibration({ maxSeason: FIT_MAX_SEASON });
const sigmas = positionStatSigma({ maxSeason: FIT_MAX_SEASON });
const leagueAvg = { QB: {}, RB: {}, WR: {}, TE: {} };

const varianceRows = [];
let gapCheck = [];
for (const { season, week } of TEST_POINTS) {
  let engine;
  try { engine = buildPlayerWeekEngine({ season, week }); } catch { continue; }
  const teams = [...new Set([...engine.values()].map(p => p.team))];
  for (const team of teams) {
    const scenarios = teamBottomUpScenarios(engine, team, { calibration, leagueAvg });
    if (!scenarios.participants) continue;
    const dist = teamBottomUpDistribution(engine, team, { calibration, sigmas, trials: 3000, seed: 517 });
    if (!dist) continue;
    varianceRows.push({ season, week, team, ...dist });
    gapCheck.push(Math.abs(dist.mean_points - scenarios.full.points));
  }
  clearPlayerWeekEngineCache();
}

console.log(`n=${varianceRows.length} team-weeks`);
console.log(`mean |MC mean - deterministic full points|: ${(gapCheck.reduce((s, x) => s + x, 0) / gapCheck.length).toFixed(4)} (consistency check, should be near 0)`);
const ratios = varianceRows.map(r => r.variance_ratio_naive_over_correlated).filter(x => x != null);
const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
const sorted = [...ratios].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
console.log(`variance ratio (naive-independent / correlated): mean=${mean.toFixed(4)} median=${median.toFixed(4)} min=${sorted[0].toFixed(3)} max=${sorted.at(-1).toFixed(3)}`);
const below1 = ratios.filter(r => r < 1).length, above1 = ratios.filter(r => r > 1).length;
console.log(`ratio < 1 (naive OVERSTATES variance): ${below1}/${ratios.length}   ratio > 1 (naive UNDERSTATES variance): ${above1}/${ratios.length}`);
console.log('\nsample:');
for (const r of varianceRows.slice(0, 10)) {
  console.log(`  ${r.season} wk${r.week} ${r.team}: mean=${r.mean_points} sd_corr=${r.sd_points_correlated} sd_naive=${r.sd_points_naive_independent} ratio=${r.variance_ratio_naive_over_correlated} legs=${r.legs} baseline=${r.baseline_points_untouched}`);
}
