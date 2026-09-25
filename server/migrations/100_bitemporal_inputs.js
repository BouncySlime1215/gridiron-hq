export const name = '100_bitemporal_inputs';
/**
 * BITEMPORAL (ONE-PLAN 4d night 7, 4b row 12). Additive only: one column.
 *
 * `nfl_injuries.available_at` — the availability clock: when this machine first
 * held the row's current value. `modified_at` stays the event clock, the source's
 * own `date_modified`, and is NULL where upstream sent none (every 2025-26 row);
 * it is never back-filled with our capture time, because that would make an
 * unknown source stamp look like a known one.
 *
 * Written by nfl-advanced.js#syncInjuries only. Numbered 100: the lowest number
 * not listed in docs/handoff MIGRATIONS.md (row to add there on merge).
 */
const cols = db => db.prepare('PRAGMA table_info(nfl_injuries)').all().map(c => c.name);

export function up(db) {
  const have = cols(db);
  if (!have.length) return; // the schema creates the table; nothing to extend without it
  if (!have.includes('available_at')) db.exec('ALTER TABLE nfl_injuries ADD COLUMN available_at TEXT');
}

export function down(db) {
  if (cols(db).includes('available_at')) db.exec('ALTER TABLE nfl_injuries DROP COLUMN available_at');
}
