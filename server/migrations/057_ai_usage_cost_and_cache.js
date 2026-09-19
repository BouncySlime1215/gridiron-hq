export const name = '057_ai_usage_cost_and_cache';
/**
 * `ai_usage.cost_usd` plus the prompt-cache token counts, per call.
 *
 * Until 2026-09-18 the table held only input/output tokens and every report
 * priced them from claude.js's PRICING, which knew only Haiku 4.5 — so the 35
 * Sonnet 5 negotiation-profile calls read at Haiku rates (about half their true
 * cost). Cache reads and writes are billed at different rates from plain input
 * (0.1x and 1.25x/2x), so they are logged separately; `cost_usd` is the price at
 * the time of the call, written by claude.js#recordUsage. Rows written before
 * this column existed are priced by model on read (llm-budget.js#rowCostUsd)
 * and were corrected in place by llm-budget.js#recomputeUsageCosts, after a
 * backup to `ai_usage_backup_20260918`.
 */
const COLUMNS = [
  ['cost_usd', 'REAL'],
  ['cache_read_input_tokens', 'INTEGER DEFAULT 0'],
  ['cache_creation_input_tokens', 'INTEGER DEFAULT 0']
];

export function up(db) {
  const cols = db.prepare('PRAGMA table_info(ai_usage)').all().map(c => c.name);
  for (const [col, type] of COLUMNS) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE ai_usage ADD COLUMN ${col} ${type}`);
  }
  // Daily budgets sum today's rows per feature on every budgeted call.
  db.exec('CREATE INDEX IF NOT EXISTS idx_ai_usage_created_feature ON ai_usage(created_at, feature)');
}

export function down(db) {
  // Additive columns and one index; dropping them returns the table to its 056 shape.
  db.exec('DROP INDEX IF EXISTS idx_ai_usage_created_feature');
  const cols = db.prepare('PRAGMA table_info(ai_usage)').all().map(c => c.name);
  for (const [col] of [...COLUMNS].reverse()) {
    if (cols.includes(col)) db.exec(`ALTER TABLE ai_usage DROP COLUMN ${col}`);
  }
}
