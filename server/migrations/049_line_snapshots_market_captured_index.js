export const name = '049_line_snapshots_market_captured_index';

/**
 * An index on nfl_line_snapshots(market, captured_at).
 *
 * signal-latency.js's bookLagDistribution() and sharp-lag.js's sharpLag()
 * both filter this table by an exact `market` plus a `captured_at` range,
 * then sort by captured_at. The table's only index besides the primary key
 * is (event_id, market) -- useless for either query, since neither knows an
 * event_id up front. Both fell back to the table's own PRIMARY KEY autoindex
 * (captured_at, event_id, book, market, side), which leads with captured_at
 * but not market: SQLite can seek the captured_at range, but must then read
 * and discard every row outside the wanted market one at a time instead of
 * skipping them.
 *
 * Measured against the live database on 2026-09-13 (2,108,975 rows in the
 * table, 712,341 of them market='spreads', spanning 2022-05-05 through the
 * live instant -- see the note on bookLagDistribution's bound fix for why
 * that range is so much bigger than it looks): bookLagDistribution's default
 * 60-day window took 7,406ms and pulled 667,284 rows / ~522MB of heap;
 * sharpLag's default 14-day window took 7,374ms and pulled 656,034 rows /
 * ~582MB. Re-run on an isolated copy of the exact same rows with this index
 * added and the SAME windows: 2,715ms and 3,331ms respectively -- a ~2.2-2.7x
 * reduction in query time, with the plan changing from
 * "SEARCH ... USING INDEX sqlite_autoindex_nfl_line_snapshots_1
 * (captured_at>? [AND captured_at<?])" to
 * "SEARCH ... USING INDEX idx_line_snapshots_market_captured
 * (market=? AND captured_at>? [AND captured_at<?])".
 *
 * The row count (and therefore the memory both queries pull into the
 * process, since both load their whole result set to filter/group in JS)
 * does not move with an index alone -- see the accompanying code change to
 * signal-latency.js, which adds the upper bound bookLagDistribution's query
 * was missing entirely.
 *
 * Index-only, additive, and reversible. It changes no row and no behavior.
 */
export function up(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_line_snapshots_market_captured ON nfl_line_snapshots(market, captured_at);`);
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_line_snapshots_market_captured;`);
}
