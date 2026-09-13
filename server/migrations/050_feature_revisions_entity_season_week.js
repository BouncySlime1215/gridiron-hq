export const name = '050_feature_revisions_entity_season_week';

/**
 * nfl-t60-packet.js's injury-revision read filters nfl_feature_revisions by
 * season/week the only way it could: `entity LIKE '%' || ':' || season || ':'
 * || week`, matching entities of the form `player:<gsisId>:<season>:<week>`
 * (nfl-advanced.js's injury sync is the table's only writer). A leading-
 * wildcard LIKE can't use a btree index -- EXPLAIN QUERY PLAN confirms a
 * `SCAN fr` -- and that scan sits on the live tier's synchronous path via
 * nfl_t60_runner -> t60-runner.js -> freezeT60Packet. It costs nothing today
 * only because the table holds 0 rows in production (nfl-bitemporal.js's own
 * 2026-09-13 note); it becomes a real per-request table scan the moment
 * revisions start accumulating.
 *
 * These two columns let the query become an indexed equality match instead.
 * They are populated going forward by nfl-bitemporal.js's recordRevision()
 * (an explicit, optional entitySeason/entityWeek pair -- not parsed back out
 * of the entity string, since the bitemporal store treats entity as an
 * opaque key for every other feature that isn't week-scoped). Nothing
 * backfills existing rows: the table is append-only (see the two triggers
 * below, from 000_legacy_schema.js) and there are zero rows to backfill.
 */
export function up(db) {
  const cols = db.prepare(`PRAGMA table_info(nfl_feature_revisions)`).all().map(c => c.name);
  for (const [column, declaration] of [
    ['entity_season', 'INTEGER'],
    ['entity_week', 'INTEGER'],
  ]) {
    if (!cols.includes(column)) db.exec(`ALTER TABLE nfl_feature_revisions ADD COLUMN ${column} ${declaration}`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_feature_revisions_feature_season_week
      ON nfl_feature_revisions(feature, entity_season, entity_week);
  `);
}

export function down(db) {
  // The index is the only part of this that could ever be wrong, so that's
  // the only part undone -- same reasoning as migration 046's down(): SQLite's
  // DROP COLUMN needs a full table rebuild, these two columns are purely
  // additive and nullable, and nothing that predates this migration reads them.
  db.exec(`DROP INDEX IF EXISTS idx_feature_revisions_feature_season_week;`);
}
