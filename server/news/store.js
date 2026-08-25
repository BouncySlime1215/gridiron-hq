import { db, row, run } from '../db/index.js';

/**
 * news_items began as a flat manual-entry table (see server/db/index.js) and never
 * had the provenance/dedup columns normalize.js's contract requires. server/db/**
 * and server/migrations/** belong to a different owner in this build, so this
 * extends the table the same way server/db/index.js already extends other
 * tables — an idempotent ALTER TABLE guarded by PRAGMA table_info — rather than
 * editing an excluded file. The proper home for this is a numbered migration.
 */
const existingColumns = new Set(db.prepare(`PRAGMA table_info(news_items)`).all().map(c => c.name));
const NEW_COLUMNS = {
  source_url: 'TEXT', source_type: 'TEXT', author: 'TEXT',
  published_at: 'TEXT', ingested_at: 'TEXT', updated_at: 'TEXT',
  canonical_url: 'TEXT', entities_json: 'TEXT', injury_entities_json: 'TEXT',
  transaction_type: 'TEXT', reliability_json: 'TEXT', duplicate_group_id: 'TEXT',
  user_relevance_json: 'TEXT', confidence: 'REAL', classification_version: 'TEXT',
  attribution_required: 'INTEGER'
};
for (const [name, type] of Object.entries(NEW_COLUMNS)) {
  if (!existingColumns.has(name)) db.exec(`ALTER TABLE news_items ADD COLUMN ${name} ${type}`);
}

/**
 * Insert a normalized item, or update it in place if its duplicate group already
 * exists — so re-ingesting the same feed doesn't fork one story into N rows, and
 * a corrected/updated story overwrites the prior version instead of duplicating it.
 */
export function upsertNormalizedNewsItem(normalized, { teamId = null, date } = {}) {
  const day = date ?? normalized.published_at.slice(0, 10);
  const existing = normalized.duplicate_group_id
    ? row('SELECT id FROM news_items WHERE duplicate_group_id = ?', normalized.duplicate_group_id)
    : null;
  const fields = [
    day, teamId, normalized.headline, normalized.summary ?? null, normalized.importance ?? 2,
    normalized.source, normalized.source_url, normalized.source_type, normalized.author ?? null,
    normalized.published_at, normalized.ingested_at, normalized.updated_at, normalized.canonical_url,
    JSON.stringify(normalized.entities ?? {}), JSON.stringify(normalized.injury_entities ?? []),
    normalized.transaction_type ?? null, JSON.stringify(normalized.reliability ?? {}), normalized.duplicate_group_id,
    normalized.user_relevance != null ? JSON.stringify(normalized.user_relevance) : null,
    normalized.confidence ?? null, normalized.classification_version ?? null, normalized.attribution_required ? 1 : 0
  ];
  if (existing) {
    run(`UPDATE news_items SET date=?, team_id=?, headline=?, body=?, importance=?,
      source=?, source_url=?, source_type=?, author=?, published_at=?, ingested_at=?, updated_at=?,
      canonical_url=?, entities_json=?, injury_entities_json=?, transaction_type=?, reliability_json=?,
      duplicate_group_id=?, user_relevance_json=?, confidence=?, classification_version=?, attribution_required=?
      WHERE id=?`, ...fields, existing.id);
    return { id: existing.id, inserted: false };
  }
  const result = run(`INSERT INTO news_items (date, team_id, headline, body, importance,
    source, source_url, source_type, author, published_at, ingested_at, updated_at,
    canonical_url, entities_json, injury_entities_json, transaction_type, reliability_json,
    duplicate_group_id, user_relevance_json, confidence, classification_version, attribution_required)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...fields);
  return { id: Number(result.lastInsertRowid), inserted: true };
}
