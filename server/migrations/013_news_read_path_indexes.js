export const name = '013_news_read_path_indexes';

/** Bound the ranked News desk's two hottest reads: freshness and archive filters. */
export function up(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_news_items_published_priority
      ON news_items(published_at DESC, importance DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_news_items_team_date
      ON news_items(team_id, date DESC, importance DESC);
    CREATE INDEX IF NOT EXISTS idx_news_items_ingested
      ON news_items(ingested_at DESC);
  `);
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_news_items_ingested;
    DROP INDEX IF EXISTS idx_news_items_team_date;
    DROP INDEX IF EXISTS idx_news_items_published_priority;
  `);
}
