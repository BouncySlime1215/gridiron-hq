#!/usr/bin/env node
/**
 * Populates nfl_metric_reliability (migration 063) for the six volume
 * (metric, position) pairs that scripts/fit-shrinkage-weekly.mjs already
 * fits and grades — this script adds no new statistics, it persists the
 * same fitK() output that produced the active shrinkage_fits row (id=1,
 * through=2024) into the reliability table so ICC/k for these metrics are
 * queryable without re-deriving them.
 *
 * population = 'player_week_usage': names the actual source table
 * buildFitSpecs reads (server/services/shrinkage-fit.js:179), not R&D's
 * raw-nflverse "pbp"/"ngs" pulls — deliberately a different population key
 * so these rows are never compared against R&D's as if they were the same
 * data.
 *
 * weighting_scheme = 'weekly_role_recency': names the actual accumulator
 * weighting these six specs are trained under (WEEKLY_ROLE_RECENCY,
 * weekHalfLife 5, seasonDecay 0.05 — see buildFitSpecs's default and
 * shrinkage-fit.js:isWeeklyRoleRecency). This is migration 063's own
 * warning made concrete: target_share's ICC is NOT one number, it depends
 * on how the observations were weighted, so the scheme is recorded rather
 * than assumed.
 *
 * Usage: node scripts/persist-volume-metric-reliability.mjs [throughSeason]
 *   default throughSeason=2024, matching the active shrinkage fit.
 */
import { volumeKFits, saveMetricReliability } from '../server/services/shrinkage-fit.js';

const through = Number(process.argv[2]) || 2024;
const POPULATION = 'player_week_usage';
const WEIGHTING_SCHEME = 'weekly_role_recency';

const fits = volumeKFits(through);
if (!fits.length) {
  console.error(`No volume fits returned for through=${through} — nothing to persist.`);
  process.exit(1);
}

// nfl_metric_reliability has no position column (UNIQUE is population+metric+
// weighting_scheme only), but carry_share is fit separately for RB and OTHER
// (VOLUME_METRICS in shrinkage-fit.js) — two genuinely different variance
// decompositions under the same metric name. Suffixing the metric with the
// position for anything not fit as ALL/QB-only keeps both rows instead of
// the second silently overwriting the first via the upsert.
const metricKey = f => (f.position === 'ALL' || f.position === 'QB') ? f.metric : `${f.metric}_${f.position.toLowerCase()}`;

for (const f of fits) {
  const metric = metricKey(f);
  saveMetricReliability({
    population: POPULATION,
    metric,
    weightingScheme: WEIGHTING_SCHEME,
    fit: { icc: f.icc, k: f.k, sigma2_within: f.sigma2_within, sigma2_between: f.sigma2_between, n_obs: f.n_obs },
    nPlayers: f.n_groups,
    seasons: `<=${through}`
  });
  console.log(`${metric} (fit position ${f.position}): icc=${f.icc} k=${f.k} n_groups=${f.n_groups} n_obs=${f.n_obs}`);
}

console.log(`\nPersisted ${fits.length} rows to nfl_metric_reliability (population=${POPULATION}, weighting_scheme=${WEIGHTING_SCHEME}).`);
