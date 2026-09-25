export const name = '109_chat_trade_interest';
/**
 * SCREENSHOT-OFFERS follow-up: `chat_trade_interest`, what a league-mate's own trade screenshots
 * reveal about him. A manager who shows a finalize/draft screen or a trade-analyzer comparison he
 * built shows whom he would give (`would_give_ids`) and whom he wants (`wants_ids`). Read by the
 * his-side lens (campaign/his-side.js) as a SHADOW signal: logged in `_run.inputs.his_side`, never
 * served, never weighted.
 *
 * Ids only: players.id arrays as JSON, a roster id, the screen kind and when it was posted. No text,
 * no names. `source_key` is the attachment's opaque guid, the writer's idempotency key (one screen,
 * one row). Written only by people/chat-trade-interest.js#recordChatTradeInterest.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_trade_interest (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id       INTEGER NOT NULL,
      season          INTEGER NOT NULL,
      roster_id       INTEGER NOT NULL,
      wants_ids       TEXT NOT NULL DEFAULT '[]',
      would_give_ids  TEXT NOT NULL DEFAULT '[]',
      kind            TEXT NOT NULL CHECK (kind IN ('finalize', 'hypothetical')),
      seen_at         TEXT NOT NULL,
      confidence      REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      source_key      TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_trade_interest_source ON chat_trade_interest(source_key);
    CREATE INDEX IF NOT EXISTS idx_chat_trade_interest_team ON chat_trade_interest(league_id, season, roster_id, seen_at);
  `);
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_chat_trade_interest_team;
           DROP INDEX IF EXISTS idx_chat_trade_interest_source;
           DROP TABLE IF EXISTS chat_trade_interest;`);
}
