process.env.SCHEDULER_DISABLED='1';
const R='/Users/nick_matta/Documents/GitHub/gridiron-hq/server/services/';
const { replaySeasonWeekly } = await import(R+'weekly-backtest.js');
const { activeKVector } = await import(R+'shrinkage-fit.js');
const { WEEKLY_ROLE_RECENCY, weeklyEnsemblePrediction } = await import(R+'weekly-ensemble.js');
const { activeWeeklyWeightSet } = await import(R+'weekly-weight-store.js');
const { pairedBootstrapDiff } = await import(R+'backtest-significance.js');
const w = activeWeeklyWeightSet({season:2026,week:3}).weights;
const common = { startWeek:5, endWeek:18, distributions:false, kOverride: undefined /* cutoff-safe default: shrinkage-fit.js cutoffSafeKVector */, roleRecency: WEEKLY_ROLE_RECENCY,
  predictionHead: ctx => weeklyEnsemblePrediction(ctx, w) };
for (const season of [2024, 2025]) {
  const t0=Date.now();
  const r = replaySeasonWeekly(season, common);
  console.log(season, 'MAE', r.point.model.mae, '| spearman', r.point.model.spearman, '| n', r.point.model.n, '|', ((Date.now()-t0)/1000).toFixed(0)+'s');
}
process.exit(0);
