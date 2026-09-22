export const name = '070_play_formations_participation_columns';
/**
 * The four charted columns nflverse participation carries and `ingestFormations`
 * was reading past: pressure, time to throw, and the man/zone and coverage-shell
 * labels. Nothing in the repo had an equivalent for coverage shell or pressure.
 *
 * Mirrors migration 059, which did the same widening for the sibling table
 * `nfl_play_charting`, including its reason for going through a migration at all:
 * the table itself is created ad hoc at import by server/db/schema/nfl-a-to-m.js,
 * so a fresh build makes the narrow table and this widens it, while an existing
 * database gets the columns without a rebuild.
 *
 * `was_pressure` is INTEGER and nullable, and the null carries meaning: on a play
 * that was never a dropback the file still writes FALSE, and 51.2% of the 2024
 * rows are exactly that. Storing those as 0 halves the pressure rate. See
 * docs/evidence/participation-dropback-contamination.mjs and
 * docs/tdd/participation-columns.tdd.md.
 */
const COLUMNS = [
  ['time_to_throw', 'REAL'], ['was_pressure', 'INTEGER'],
  ['defense_man_zone_type', 'TEXT'], ['defense_coverage_type', 'TEXT'],
];
const cols = db => db.prepare('PRAGMA table_info(nfl_play_formations)').all().map(c => c.name);

export function up(db) {
  const have = cols(db);
  if (!have.length) return; // table is created by the NFL schema; nothing to extend yet
  for (const [c, t] of COLUMNS) if (!have.includes(c)) db.exec(`ALTER TABLE nfl_play_formations ADD COLUMN ${c} ${t}`);
}

export function down(db) {
  const have = cols(db);
  for (const [c] of COLUMNS) if (have.includes(c)) db.exec(`ALTER TABLE nfl_play_formations DROP COLUMN ${c}`);
}
