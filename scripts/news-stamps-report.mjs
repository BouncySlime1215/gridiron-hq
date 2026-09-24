#!/usr/bin/env node
/**
 * BROKEN-Q (FIX-286-2): news timing per source, and how many rows each as-of read
 * treats as knowable now. Run on a DB copy: it applies pending migrations (087 adds
 * news_items.edited_at) and otherwise only reads (--spine, below, writes).
 *
 *   GRIDIRON_NEWS_STAMPS_ENABLED=1 node scripts/news-stamps-report.mjs
 *   GRIDIRON_NEWS_STAMPS_ENABLED=1 GRIDIRON_PROCESS_ROLE=script node scripts/news-stamps-report.mjs --spine
 *
 * --spine (FIX-286-3, writes engine_events: a DB copy only) runs the news adapter once and
 * reports the news.ingested / news.edited events and how many rows' spine knowledge time
 * (their latest such event) differs from newsKnownAtSql's clock. It should be 0.
 *
 * Per source:
 *   no_ingest            rows with no ingested_at
 *   late3d               ingested more than 3 days after published_at
 *   late3d_by_revision   of those, ingested_at at least 1 h after the insert clock
 *                        (created_at): the old store moved it on a revision
 *   moved_after_insert   every row whose ingested_at is at least 1 h after created_at
 *   edited               rows with an edited_at (only rows revised with the flag on)
 *   old_knowable_now     the old as-of clause, ingested_at <= now
 *   new_knowable_now     newsKnownAtSql (edited_at ?? ingested_at ?? created_at) <= now
 */
import { runMigrations } from '../server/db/migrate.js';

await runMigrations();
const { rows } = await import('../server/db/index.js');
const { newsKnownAtSql, newsStampsFlag } = await import('../server/news/stamps.js');

const now = new Date().toISOString();
const bySource = rows(`SELECT COALESCE(source, '(null)') AS source, COUNT(*) AS n,
    SUM(ingested_at IS NULL) AS no_ingest,
    SUM(ingested_at IS NOT NULL AND julianday(ingested_at) - julianday(published_at) > 3) AS late3d,
    SUM(ingested_at IS NOT NULL AND julianday(ingested_at) - julianday(published_at) > 3
        AND julianday(ingested_at) - julianday(created_at) >= 1.0 / 24) AS late3d_by_revision,
    SUM(ingested_at IS NOT NULL AND julianday(ingested_at) - julianday(created_at) >= 1.0 / 24) AS moved_after_insert,
    SUM(edited_at IS NOT NULL) AS edited,
    SUM(ingested_at IS NOT NULL AND julianday(ingested_at) <= julianday(?)) AS old_knowable_now,
    SUM(${newsKnownAtSql()}) AS new_knowable_now
  FROM news_items GROUP BY 1 ORDER BY n DESC`, now, now);

let spine = null;
if (process.argv.includes('--spine')) {
  const { backfillStream } = await import('../server/services/engine/backfill.js');
  const run = backfillStream('news');
  const events = rows(`SELECT event_type, as_of, json_extract(payload, '$.news_id') AS news_id FROM engine_events
    WHERE source = 'news_items' AND event_type IN ('news.ingested', 'news.edited')`);
  const latest = new Map();
  for (const e of events) if (!latest.has(e.news_id) || e.as_of > latest.get(e.news_id)) latest.set(e.news_id, e.as_of);
  const clock = rows(`SELECT id, COALESCE(edited_at, ingested_at, created_at) AS t FROM news_items`);
  const norm = t => new Date(/^\d{4}-\d{2}-\d{2} /.test(t) ? `${t.replace(' ', 'T')}Z` : t).toISOString();
  const mismatched = clock.filter(r => r.t != null && latest.get(r.id) !== norm(r.t)).map(r => r.id);
  spine = {
    run: { inserted: run.inserted, skipped: run.skipped, source_rows: run.source_rows },
    news_ingested: events.filter(e => e.event_type === 'news.ingested').length,
    news_edited: events.filter(e => e.event_type === 'news.edited').length,
    rows_with_knowledge_event: latest.size,
    clock_mismatch: mismatched.length, clock_mismatch_ids: mismatched.slice(0, 10)
  };
}

const total = key => bySource.reduce((s, r) => s + Number(r[key] ?? 0), 0);
const keys = ['n', 'no_ingest', 'late3d', 'late3d_by_revision', 'moved_after_insert', 'edited',
  'old_knowable_now', 'new_knowable_now'];
console.log(JSON.stringify({
  now, flag: newsStampsFlag(),
  by_source: bySource,
  total: Object.fromEntries(keys.map(k => [k, total(k)])),
  ...(spine ? { spine } : {})
}, null, 2));
