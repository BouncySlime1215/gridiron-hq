import { previewUnconfirmed, previewFields } from '../services/preview-mode.js';

/**
 * BROKEN-Q: news timing stamps and the one as-of read for news_items.
 *
 * Measured on the local DB (BROKEN-NUMBERS row Q): 1,014 of 1,582 news_items
 * have no ingested_at, 412 were ingested > 3 days after publish, 159 were
 * updated after ingest. Causes in the writers:
 *   - three insert paths never stamped ingested_at at all (ESPN pull
 *     routes/espn.js insertArticles, manual POST /api/news, POST /api/news/analyze);
 *   - store.js moved ingested_at forward on every content revision, so a
 *     re-classification days later turned an on-time story into a "late" one
 *     and there was no record of the edit apart from the lost receipt time.
 *
 * With the flag on: every insert stamps ingested_at (first receipt, never
 * overwritten); a revision stamps edited_at (migration 087) instead. The as-of
 * read treats a story as known at max(published_at, edited_at ?? ingested_at ??
 * created_at): a row edited after the cut is excluded, because the stored
 * content is the edited version, not the one that existed at the cut.
 *
 * GRIDIRON_NEWS_STAMPS_ENABLED: '1' on, '0' off, unset = off unless preview mode.
 */
export const NEWS_STAMPS_ENV = 'GRIDIRON_NEWS_STAMPS_ENABLED';
export const NEWS_STAMPS_PREVIEW_REASON =
  'News receipt stamps (ingested_at on insert, edited_at on change) and as-of news reads (BROKEN-Q); default off until checked on the local DB';

/** { on, preview }: read per call, so a test or a run can flip it. */
export function newsStampsFlag() {
  const v = process.env[NEWS_STAMPS_ENV];
  if (v === '1') return { on: true, preview: false };
  if (v === '0') return { on: false, preview: false };
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

/** The fields a response carries when the stamps are on only because of preview mode. */
export const newsStampsPreviewFields = flag => (flag.preview ? previewFields(NEWS_STAMPS_PREVIEW_REASON) : {});

/** ingested_at for a new row: now when the flag is on, NULL (the old behaviour) when off. */
export const insertIngestedAt = (now = new Date().toISOString()) => (newsStampsFlag().on ? now : null);

/**
 * SQL for "this row's current content was knowable at the cut (one `?`)".
 * created_at is SQLite's 'YYYY-MM-DD HH:MM:SS' and the others are ISO with a
 * 'T' and 'Z', so both sides go through julianday() rather than a TEXT compare.
 * Rows with no ingested_at fall back to created_at, the insert clock every row has.
 */
export function newsKnownAtSql(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `julianday(COALESCE(${p}edited_at, ${p}ingested_at, ${p}created_at)) <= julianday(?)`;
}
