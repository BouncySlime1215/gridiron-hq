// Records that a large body of ad-hoc CREATE TABLE IF NOT EXISTS / ALTER TABLE
// statements (nfl_teams, players, drafts, draft_picks, leagues, news_items,
// and dozens more) already existed in server/db/index.js and various
// server/services/*.js and server/routes/*.js files before this migration
// system was introduced. This migration intentionally performs no DDL — it
// only marks the cutover point in schema_migrations so it's possible to tell,
// from the table's contents, which schema changes were made through the
// versioned system and which predate it.
export const name = '001_baseline_marker';
export function up() { /* no-op: documents the cutover, does not touch schema */ }
export function down() { /* no-op: only the schema_migrations marker is removed */ }
