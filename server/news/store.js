import { row } from '../db/index.js';
import { newsStampsFlag } from './stamps.js';

// Every column the update branch writes other than the provenance timestamps
// themselves (ingested_at/updated_at). Comparing the incoming values against
// what's already stored on these columns is how the update branch tells a
// genuine revision (a Friday edit to a Wednesday article) apart from a pure
// duplicate resend of unchanged content -- there's no separate content-hash
// column in the schema, so the columns that already carry the content are
// the mechanism.
const CONTENT_COLUMNS = ['date', 'team_id', 'headline', 'body', 'importance', 'source', 'source_url',
  'source_type', 'author', 'published_at', 'canonical_url', 'entities_json', 'injury_entities_json',
  'transaction_type', 'reliability_json', 'user_relevance_json', 'confidence', 'classification_version',
  'attribution_required'];

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
  const values = {
    date: day, team_id: teamId, headline: normalized.headline, body: normalized.summary ?? null,
    importance: normalized.importance ?? 2, source: normalized.source, source_url: normalized.source_url,
    source_type: normalized.source_type, author: normalized.author ?? null, published_at: normalized.published_at,
    canonical_url: normalized.canonical_url, entities_json: JSON.stringify(normalized.entities ?? {}),
    injury_entities_json: JSON.stringify(normalized.injury_entities ?? []),
    transaction_type: normalized.transaction_type ?? null, reliability_json: JSON.stringify(normalized.reliability ?? {}),
    user_relevance_json: normalized.user_relevance != null ? JSON.stringify(normalized.user_relevance) : null,
    confidence: normalized.confidence ?? null, classification_version: normalized.classification_version ?? null,
    attribution_required: normalized.attribution_required ? 1 : 0
  };

  const inserted = row(`INSERT INTO news_items (date, team_id, headline, body, importance,
      source, source_url, source_type, author, published_at, ingested_at, updated_at,
      canonical_url, entities_json, injury_entities_json, transaction_type, reliability_json,
      duplicate_group_id, user_relevance_json, confidence, classification_version, attribution_required)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(duplicate_group_id) WHERE duplicate_group_id IS NOT NULL DO NOTHING
    RETURNING id`,
    values.date, values.team_id, values.headline, values.body, values.importance,
    values.source, values.source_url, values.source_type, values.author,
    values.published_at, normalized.ingested_at, normalized.updated_at, values.canonical_url,
    values.entities_json, values.injury_entities_json,
    values.transaction_type, values.reliability_json, normalized.duplicate_group_id,
    values.user_relevance_json,
    values.confidence, values.classification_version, values.attribution_required);
  if (inserted) return { id: Number(inserted.id), inserted: true };

  // A pure resend of already-stored content must not bump ingested_at -- it stays
  // idempotent. But when the incoming values actually differ from what's on the
  // row (a real revision), ingested_at needs to move to normalized.ingested_at:
  // that's when THIS version of the content was actually received, and freezing
  // it at the original receipt time is a look-ahead risk for anything downstream
  // that treats ingested_at as "when we knew this."
  //
  // BROKEN-Q, flag on (server/news/stamps.js): ingested_at is the first receipt
  // and is never overwritten; the revision's receipt goes to edited_at instead
  // (migration 087), and the as-of read (newsKnownAtSql) reads edited_at for
  // the same look-ahead guard. Flag off: the behaviour above, unchanged.
  const stamps = newsStampsFlag().on;
  const existing = row(`SELECT ${CONTENT_COLUMNS.join(', ')}, ingested_at FROM news_items
    WHERE duplicate_group_id = ?`, normalized.duplicate_group_id);
  const contentChanged = !existing || CONTENT_COLUMNS.some(column => existing[column] != values[column]);
  // NULL leaves edited_at as it is (COALESCE below): the flag-off path and a pure resend.
  const editedAt = stamps && contentChanged ? normalized.ingested_at : null;
  const ingestedAt = stamps && existing ? existing.ingested_at
    : contentChanged ? normalized.ingested_at : existing.ingested_at;

  const updated = row(`UPDATE news_items SET
      date=?, team_id=?, headline=?, body=?, importance=?, source=?, source_url=?, source_type=?,
      author=?, published_at=?, ingested_at=?, edited_at=COALESCE(?, edited_at), updated_at=?, canonical_url=?, entities_json=?, injury_entities_json=?,
      transaction_type=?, reliability_json=?, user_relevance_json=?, confidence=?, classification_version=?,
      attribution_required=?
    WHERE duplicate_group_id = ?
    RETURNING id`,
    values.date, values.team_id, values.headline, values.body, values.importance,
    values.source, values.source_url, values.source_type, values.author,
    values.published_at, ingestedAt, editedAt, normalized.updated_at, values.canonical_url,
    values.entities_json, values.injury_entities_json,
    values.transaction_type, values.reliability_json,
    values.user_relevance_json,
    values.confidence, values.classification_version,
    values.attribution_required, normalized.duplicate_group_id);
  return { id: Number(updated.id), inserted: false };
}
