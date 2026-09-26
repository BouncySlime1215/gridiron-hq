export const name = '117_ai_usage_source';
/**
 * SPEND-SERVER: where each AI call came from, and a key to ingest calls made elsewhere.
 *
 *   source   'app' (the server), 'offline' (refresh.sh and the jobs), 'test' (test harnesses,
 *            judges and builders on DB copies). Rows written before this migration are null
 *            and are read as 'app'.
 *   call_id  a unique id per call. Calls made against a DB copy are appended to a shared
 *            JSONL ledger (claude.js) and ingested into the live DB by call_id, so a line is
 *            counted once however often the file is read.
 */
export function up(db) {
  const cols = db.prepare('PRAGMA table_info(ai_usage)').all().map(c => c.name);
  if (!cols.length) return; // no ai_usage on this database: nothing to add to
  if (!cols.includes('source')) db.exec('ALTER TABLE ai_usage ADD COLUMN source TEXT');
  if (!cols.includes('call_id')) db.exec('ALTER TABLE ai_usage ADD COLUMN call_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_call_id ON ai_usage(call_id) WHERE call_id IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ai_usage_created_source ON ai_usage(created_at, source)');
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_ai_usage_created_source; DROP INDEX IF EXISTS idx_ai_usage_call_id;');
  const cols = db.prepare('PRAGMA table_info(ai_usage)').all().map(c => c.name);
  if (cols.includes('call_id')) db.exec('ALTER TABLE ai_usage DROP COLUMN call_id');
  if (cols.includes('source')) db.exec('ALTER TABLE ai_usage DROP COLUMN source');
}
