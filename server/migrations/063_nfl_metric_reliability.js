export const name = '063_nfl_metric_reliability';
/**
 * How much of a weekly metric's variance is the player, versus noise --
 * measured, not asserted. Data & techniques R&D's RELIABILITY-SPEC.md
 * (2026-09-22): fitK (server/services/shrinkage-fit.js) already fits the
 * variance decomposition every shrink() call site needs; this table is where
 * that measurement is persisted for metrics beyond the ones production
 * currently shrinks, and for the ICC reading of the same fit (0-1, "how real
 * is this metric") alongside k ("how many observations before you trust the
 * player's own number over the prior").
 *
 * weighting_scheme is NOT optional. R&D's own retracted first pass sorted one
 * ICC column across rows fitted under different weightings and produced an
 * invalid headline -- the same metric, target share, over the same rows,
 * reads ICC 0.611 at flat weight and 0.041 weighted by team pass attempts.
 * icc is not invariant to how the observations were weighted, so a row
 * without its weighting scheme recorded is a number nobody could safely
 * compare against another.
 *
 * UNIQUE(population, metric, weighting_scheme) makes this the CURRENT
 * measurement per combination, not a version history -- unlike
 * shrinkage_fits/shrinkage_k (the production k-vector's own immutable,
 * versioned fit log), which this table does not replace. A re-fit here
 * overwrites the prior row for the same key via upsert, in
 * saveMetricReliability().
 *
 * There is deliberately NO position column, but a metric can be fit
 * separately per position (e.g. carry_share for RB vs OTHER -- two real,
 * different variance decompositions under one metric name in
 * shrinkage-fit.js's VOLUME_METRICS). Convention, not enforced by the
 * schema: a position split is encoded as a metric-name suffix
 * (`carry_share_rb`, `carry_share_other`), not a second row under the
 * bare metric name -- the UNIQUE constraint would let the second upsert
 * silently overwrite the first otherwise. See
 * scripts/persist-volume-metric-reliability.mjs's `metricKey()` for the
 * one place this convention is applied.
 */
export function up(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_metric_reliability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    population TEXT NOT NULL,
    metric TEXT NOT NULL,
    weighting_scheme TEXT NOT NULL,
    icc REAL NOT NULL,
    k REAL NOT NULL,
    sigma2_within REAL,
    sigma2_between REAL,
    n_players INTEGER,
    n_obs INTEGER,
    seasons TEXT,
    fitted_at TEXT NOT NULL,
    UNIQUE(population, metric, weighting_scheme)
  )`);
}

export function down(db) {
  db.exec('DROP TABLE IF EXISTS nfl_metric_reliability');
}
