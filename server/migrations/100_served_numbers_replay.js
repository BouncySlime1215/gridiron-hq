export const name = '100_served_numbers_replay';
/**
 * IDEA-001 / RL-20-1 spec (e): every served_numbers row carries what it takes to
 * replay it. Additive only: two nullable columns on the table 079 created.
 *
 * `seed` — the rng seed the number was simulated under. /simulate used to serve
 * title odds under a fresh random seed that was never kept, so a served number
 * could not be reproduced. The route now generates one when the caller gives
 * none, serves it, and it lands here. NULL for a producer that draws nothing
 * (the finder's cards, the lineup range).
 *
 * `input_hash` — sha256 (hex) of the league snapshot (`leagues.payload`) the
 * number was computed from. With `as_of` it says which input a replay must load.
 *
 * Numbered 100: 079 is merged (#243), so its columns cannot go into it, and the
 * registry (MIGRATIONS.md) assigns through 099; 100 is the lowest unlisted.
 */
export function up(db) {
  const cols = db.prepare('PRAGMA table_info(served_numbers)').all().map(c => c.name);
  if (!cols.includes('seed')) db.exec('ALTER TABLE served_numbers ADD COLUMN seed INTEGER');
  if (!cols.includes('input_hash')) db.exec('ALTER TABLE served_numbers ADD COLUMN input_hash TEXT');
}

export function down(db) {
  const cols = db.prepare('PRAGMA table_info(served_numbers)').all().map(c => c.name);
  if (cols.includes('input_hash')) db.exec('ALTER TABLE served_numbers DROP COLUMN input_hash');
  if (cols.includes('seed')) db.exec('ALTER TABLE served_numbers DROP COLUMN seed');
}
