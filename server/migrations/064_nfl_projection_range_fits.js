export const name = '064_nfl_projection_range_fits';
/**
 * The persisted, servable form of docs/spec/projection-range.md's causal
 * empirical-quantile band -- server/services/projection-range.js's
 * `fitProjectionRangeTable` output, saved so `buildProjections` can attach
 * range_lo/range_hi to a player's projection without refitting on every
 * request (a fit over thousands of player-weeks is not free).
 *
 * Versioned and activatable, same shape as shrinkage_fits/shrinkage_k
 * (shrinkage-fit.js) rather than nfl_metric_reliability's upsert-in-place --
 * deliberately, because this is a periodic BATCH artifact one job produces
 * and buildProjections reads, not a many-small-independent-measurements
 * table. A re-fit is a new row, kept for accountability/rollback, and
 * exactly one is ever active.
 *
 * table_json is the whole fitted table as JSON -- {[pos]: {edges, bins}},
 * `fitProjectionRangeTable`'s own return shape verbatim. coverage_overall
 * and coverage_json are the walk-forward self-check
 * (`causalCoverageReport`'s own output) recorded ALONGSIDE the fit, not
 * asserted about it -- see saveProjectionRangeFit's own comment for why a
 * fit's own in-sample coverage is not the same claim as the out-of-sample
 * number this repo already measured once, by hand, in
 * docs/tdd/projection-range-coverage.tdd.md.
 */
export function up(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_projection_range_fits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fitted_at TEXT NOT NULL,
    through_season INTEGER NOT NULL,
    min_hist INTEGER NOT NULL,
    n_rows INTEGER NOT NULL,
    coverage_overall REAL,
    coverage_json TEXT,
    table_json TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0
  )`);
}

export function down(db) {
  db.exec('DROP TABLE IF EXISTS nfl_projection_range_fits');
}
