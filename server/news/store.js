import { row } from '../db/index.js';

/**
 * Insert a normalized item, or update it in place if its duplicate group already
 * exists — so re-ingesting the same feed doesn't fork one story into N rows, and
 * a corrected/updated story overwrites the prior version instead of duplicating it.
 *
 * Uses the partial unique index on duplicate_group_id (migration
 * 010_news_provenance_and_dedup) rather than a separate lookup followed by an
 * insert/update: the INSERT either succeeds and returns the new id, or no-ops
 * on conflict, in which case an UPDATE keyed on the same unique column applies
 * the data. Either way at most one row can ever exist per duplicate_group_id,
 * so concurrent ingestion of the same story can never race into two rows.
 */
export function upsertNormalizedNewsItem(normalized, { teamId = null, date } = {}) {
  const day = date ?? normalized.published_at.slice(0, 10);
  const inserted = row(`INSERT INTO news_items (date, team_id, headline, body, importance,
      source, source_url, source_type, author, published_at, ingested_at, updated_at,
      canonical_url, entities_json, injury_entities_json, transaction_type, reliability_json,
      duplicate_group_id, user_relevance_json, confidence, classification_version, attribution_required)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(duplicate_group_id) WHERE duplicate_group_id IS NOT NULL DO NOTHING
    RETURNING id`,
    day, teamId, normalized.headline, normalized.summary ?? null, normalized.importance ?? 2,
    normalized.source, normalized.source_url, normalized.source_type, normalized.author ?? null,
    normalized.published_at, normalized.ingested_at, normalized.updated_at, normalized.canonical_url,
    JSON.stringify(normalized.entities ?? {}), JSON.stringify(normalized.injury_entities ?? []),
    normalized.transaction_type ?? null, JSON.stringify(normalized.reliability ?? {}), normalized.duplicate_group_id,
    normalized.user_relevance != null ? JSON.stringify(normalized.user_relevance) : null,
    normalized.confidence ?? null, normalized.classification_version ?? null, normalized.attribution_required ? 1 : 0);
  if (inserted) return { id: Number(inserted.id), inserted: true };

  const updated = row(`UPDATE news_items SET
      date=?, team_id=?, headline=?, body=?, importance=?, source=?, source_url=?, source_type=?,
      author=?, published_at=?, updated_at=?, canonical_url=?, entities_json=?, injury_entities_json=?,
      transaction_type=?, reliability_json=?, user_relevance_json=?, confidence=?, classification_version=?,
      attribution_required=?
    WHERE duplicate_group_id = ?
    RETURNING id`,
    day, teamId, normalized.headline, normalized.summary ?? null, normalized.importance ?? 2,
    normalized.source, normalized.source_url, normalized.source_type, normalized.author ?? null,
    normalized.published_at, normalized.updated_at, normalized.canonical_url,
    JSON.stringify(normalized.entities ?? {}), JSON.stringify(normalized.injury_entities ?? []),
    normalized.transaction_type ?? null, JSON.stringify(normalized.reliability ?? {}),
    normalized.user_relevance != null ? JSON.stringify(normalized.user_relevance) : null,
    normalized.confidence ?? null, normalized.classification_version ?? null,
    normalized.attribution_required ? 1 : 0, normalized.duplicate_group_id);
  return { id: Number(updated.id), inserted: false };
}
