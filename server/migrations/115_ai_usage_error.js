export const name = '115_ai_usage_error';
/**
 * COACH-V2 (2026-09-26): a failed AI call leaves a trace. `ai_usage.error` is null for a
 * paid call and a short code for one the API refused before any work was done
 * (`credit`: the Anthropic account is out of credits). Such a row costs 0, so the spend
 * tracker's totals are unchanged, and the hourly check can see the outage.
 */
export function up(db) {
  const cols = db.prepare('PRAGMA table_info(ai_usage)').all().map(c => c.name);
  if (!cols.length) return; // no ai_usage on this database: nothing to add to
  if (!cols.includes('error')) db.exec('ALTER TABLE ai_usage ADD COLUMN error TEXT');
}

export function down(db) {
  const cols = db.prepare('PRAGMA table_info(ai_usage)').all().map(c => c.name);
  if (cols.includes('error')) db.exec('ALTER TABLE ai_usage DROP COLUMN error');
}
