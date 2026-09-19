export const name = '059_play_charting_ftn_columns';
/**
 * FTN charting columns the opportunity model needs (plan section 00, C: O1).
 *
 * Man/zone participation data stops at 2025; FTN charting is published weekly for 2026
 * and carries the pressure and target-quality signals that exist live: blitzers and pass
 * rushers per play, and whether a target was catchable, contested, created or dropped.
 * The original ingest kept only formation fields. `drop_` because DROP is an SQL keyword.
 */
const COLUMNS = [
  ['n_blitzers', 'INTEGER'], ['n_pass_rushers', 'INTEGER'], ['catchable', 'INTEGER'],
  ['created_reception', 'INTEGER'], ['drop_', 'INTEGER'], ['read_thrown', 'INTEGER'],
  ['interception_worthy', 'INTEGER'], ['qb_fault_sack', 'INTEGER'],
];
const cols = db => db.prepare('PRAGMA table_info(nfl_play_charting)').all().map(c => c.name);

export function up(db) {
  const have = cols(db);
  if (!have.length) return; // table is created by the NFL schema; nothing to extend yet
  for (const [c, t] of COLUMNS) if (!have.includes(c)) db.exec(`ALTER TABLE nfl_play_charting ADD COLUMN ${c} ${t}`);
}

export function down(db) {
  const have = cols(db);
  for (const [c] of COLUMNS) if (have.includes(c)) db.exec(`ALTER TABLE nfl_play_charting DROP COLUMN ${c}`);
}
