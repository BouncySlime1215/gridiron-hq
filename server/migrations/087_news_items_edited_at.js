export const name = '087_news_items_edited_at';

/**
 * BROKEN-Q. Additive only: one nullable column. Nothing existing is altered.
 *
 * `news_items.edited_at`: when this system received a revision of a story it
 * already had. ingested_at stays the first receipt and is never overwritten;
 * edited_at moves instead. NULL means "never revised since first receipt" (and
 * for every row written before this migration, "not recorded").
 *
 * Writer: upsertNormalizedNewsItem, server/news/store.js (flag
 * GRIDIRON_NEWS_STAMPS_ENABLED or preview mode, server/news/stamps.js).
 * Readers: newsKnownAtSql (server/news/stamps.js), used by
 * syncRosterEventsFromNews (nfl-player-state.js) and newsFor (nfl-expert-council.js).
 */
export function up(db) {
  const existing = new Set(db.prepare(`PRAGMA table_info(news_items)`).all().map(c => c.name));
  if (!existing.has('edited_at')) db.exec(`ALTER TABLE news_items ADD COLUMN edited_at TEXT`);
}

export function down(db) {
  db.exec(`ALTER TABLE news_items DROP COLUMN edited_at`);
}
