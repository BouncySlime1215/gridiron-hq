export const name = '060_trade_proposal_cache';
/**
 * `trade_proposal_cache` — the AI pass's answer for one slate, kept across
 * restarts.
 *
 * `trade_proposals` is a budgeted feature ($0.50/day/league, `llm-budget.js`),
 * so the in-memory `compute-cache.js` is the wrong store for it: a restart
 * would re-spend real money on a slate we already paid to write up. The news
 * extractor already solved this shape (`nfl_news_event_extraction_cache`,
 * migration 019) and this follows it.
 *
 * Keyed on a content hash of the slate, NOT on a day. An unchanged slate reuses
 * the answer however long it sits, and a changed slate misses on the same day,
 * which is the behaviour a day key gets wrong in both directions. The hash
 * includes the prompt version, so changing how we ask invalidates every row by
 * construction rather than by someone remembering to clear the table.
 *
 * Only verified proposals are ever written here. A refusal — budget spent, no
 * key, malformed response, everything rejected — is deliberately NOT cached, so
 * one bad night cannot leave a league with a permanently empty Trade Lab.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_proposal_cache (
      cache_key   TEXT PRIMARY KEY,
      league_id   TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trade_proposal_cache_league
      ON trade_proposal_cache(league_id, created_at);
  `);
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_trade_proposal_cache_league;
    DROP TABLE IF EXISTS trade_proposal_cache;
  `);
}
