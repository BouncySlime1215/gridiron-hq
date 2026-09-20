#!/usr/bin/env node
/**
 * One-time backfill: fill in `entities_json` and `published_at` on the
 * news_items rows that were inserted without them.
 *
 * Context: ESPN's news pull — the most-used ingestion path, behind the
 * default "Pull ESPN news" button — never called extractEntities, unlike the
 * RSS and Twitter pipelines which always did. Every story it inserted landed
 * with entities_json = NULL, and a story with no resolved player entity
 * produces no typed claim no matter how good the extraction rules are. The
 * ingest side of that was fixed in server/routes/espn.js; the backlog
 * already in the table was not, and cannot be, by a fix to the writer.
 *
 * backfillNewsEntities() in server/routes/espn.js is that repair, and until
 * this script existed it had no caller anywhere in the repository — an
 * exported function nothing could run, which is the same as not having the
 * repair at all. A caller-graph sweep reported it as a producer with no
 * consumer, correctly.
 *
 * This is deliberately a script rather than a scheduler step or a route. It
 * is a repair for rows written before a fix, so it converges: once the
 * backlog is clean, a second run reports checked: 0. Do not wire it into the
 * scheduler — routine ingestion already populates both columns.
 *
 * It only UPDATEs news_items.entities_json and news_items.published_at on
 * rows where one of them is still NULL. No schema change, no INSERT, no
 * DELETE, no migration. published_at is backdated to the story's own `date`
 * rather than to now, so a three-week-old story does not suddenly read as
 * having just published everywhere that sorts on recency.
 *
 * Usage:
 *   node scripts/backfill-news-entities.mjs
 *   GRIDIRON_DB_PATH=/tmp/copy.sqlite node scripts/backfill-news-entities.mjs   # against a copy first
 */
process.env.SCHEDULER_DISABLED ??= '1';

const { backfillNewsEntities } = await import('../server/routes/espn.js');
const { row } = await import('../server/db/index.js');

const dbPathNote = process.env.GRIDIRON_DB_PATH || '(default server/data.sqlite)';
const before = row(`SELECT COUNT(*) AS total,
  SUM(CASE WHEN entities_json IS NULL THEN 1 ELSE 0 END) AS no_entities,
  SUM(CASE WHEN published_at IS NULL THEN 1 ELSE 0 END) AS no_published_at
  FROM news_items`);

console.log(`\nnews entity backfill — one-time, converges`);
console.log(`database: ${dbPathNote}`);
console.log(`\nbefore: ${before.total} stories, ${before.no_entities} without entities, ${before.no_published_at} without a publish time`);

const start = Date.now();
const result = backfillNewsEntities();
const ms = Date.now() - start;

console.log(`\nchecked:          ${result.checked}`);
console.log(`updated:          ${result.updated}`);
console.log(`resolved a player: ${result.resolved_a_player}`);
console.log(`took:             ${ms}ms`);

const after = row(`SELECT COUNT(*) AS total,
  SUM(CASE WHEN entities_json IS NULL THEN 1 ELSE 0 END) AS no_entities,
  SUM(CASE WHEN published_at IS NULL THEN 1 ELSE 0 END) AS no_published_at
  FROM news_items`);
console.log(`\nafter:  ${after.total} stories, ${after.no_entities} without entities, ${after.no_published_at} without a publish time`);

// A story can be given an entities_json of {"players":[],"teams":[]} — that is
// a real answer ("this story names nobody we track"), not a failure, so the
// gap that should close to zero is the NULL count, not the unresolved one.
if (after.no_entities > 0 || after.no_published_at > 0) {
  console.log(`\nstill NULL after the run — investigate, this should converge to 0`);
} else {
  console.log(`\nbacklog clear; a second run will report checked: 0\n`);
}
