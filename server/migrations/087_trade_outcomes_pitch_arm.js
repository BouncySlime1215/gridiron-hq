export const name = '087_trade_outcomes_pitch_arm';
/**
 * BANDIT-01 (IDEA-037): one column on `trade_outcomes`, additive only.
 *
 *   pitch_json  which message framing a sent offer used, as
 *               { v: 1, arm, chosen_by }. NULL = no arm recorded; such a row
 *               still grades P(accept), it just teaches the pitch bandit nothing.
 *
 * ENGINE-SPECS puts `trade_outcomes.pitch_json` in the CLONE-01b b2 migration
 * (077 there). That migration is not written yet. This one adds the column
 * behind a PRAGMA check, and b2 must do the same (or drop its copy): an
 * unguarded `ADD COLUMN pitch_json` after this one fails with "duplicate column".
 *
 * No-op when 067 has not created the table: nothing to extend.
 */
const cols = db => db.prepare('PRAGMA table_info(trade_outcomes)').all().map(c => c.name);

export function up(db) {
  const have = cols(db);
  if (!have.length) return;
  if (!have.includes('pitch_json')) db.exec('ALTER TABLE trade_outcomes ADD COLUMN pitch_json TEXT');
}

export function down(db) {
  if (cols(db).includes('pitch_json')) db.exec('ALTER TABLE trade_outcomes DROP COLUMN pitch_json');
}
