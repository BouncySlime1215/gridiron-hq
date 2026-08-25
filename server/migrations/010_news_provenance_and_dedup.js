export const name = '010_news_provenance_and_dedup';

const NEWS_COLUMNS = [
  ['source_url', 'TEXT'], ['source_type', 'TEXT'], ['author', 'TEXT'],
  ['published_at', 'TEXT'], ['ingested_at', 'TEXT'], ['updated_at', 'TEXT'],
  ['canonical_url', 'TEXT'], ['entities_json', 'TEXT'], ['injury_entities_json', 'TEXT'],
  ['transaction_type', 'TEXT'], ['reliability_json', 'TEXT'], ['duplicate_group_id', 'TEXT'],
  ['user_relevance_json', 'TEXT'], ['confidence', 'REAL'], ['classification_version', 'TEXT'],
  ['attribution_required', 'INTEGER']
];

// news_items began as a flat manual-entry table. This adds the provenance,
// entity, and dedup columns the RSS ingestion pipeline (server/news/ingest.js,
// server/news/normalize.js) requires, plus a partial unique index so a
// duplicate_group_id collision resolves through a single atomic
// INSERT ... ON CONFLICT statement (server/news/store.js) instead of a
// read-then-write race between concurrent ingestion runs.
export function up(db) {
  const existing = new Set(db.prepare(`PRAGMA table_info(news_items)`).all().map(c => c.name));
  for (const [column, type] of NEWS_COLUMNS) {
    if (!existing.has(column)) db.exec(`ALTER TABLE news_items ADD COLUMN ${column} ${type}`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_news_items_duplicate_group
    ON news_items(duplicate_group_id) WHERE duplicate_group_id IS NOT NULL`);
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_news_items_duplicate_group`);
  for (const [column] of NEWS_COLUMNS) {
    db.exec(`ALTER TABLE news_items DROP COLUMN ${column}`);
  }
}
