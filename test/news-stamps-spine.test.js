/**
 * FIX-286-3: the engine spine reads news at the same knowledge time as newsKnownAtSql.
 *
 * `news.item` (backfill.js news adapter) dates a story at its valid time, published_at.
 * An as-of read of text needs knowledge time, the clock newsKnownAtSql applies to
 * news_items: COALESCE(edited_at, ingested_at, created_at). With
 * GRIDIRON_NEWS_STAMPS_ENABLED on, the news adapter also appends `news.ingested` (at the
 * first receipt) and `news.edited` (at each revision), with published_at / ingested_at /
 * edited_at in the payload, so a spine as-of read excludes an edit made after the cut.
 * With the flag off the adapter is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-news-stamps-spine-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_PROCESS_ROLE = 'test';
process.env.SCHEDULER_DISABLED = '1';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_NEWS_STAMPS_ENABLED;

const { db, run, row, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { ADAPTERS, backfillStream } = await import('../server/services/engine/backfill.js');
const { getEvents } = await import('../server/services/engine/events.js');
const { newsKnownAtSql } = await import('../server/news/stamps.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const withFlag = (value, fn) => {
  const before = process.env.GRIDIRON_NEWS_STAMPS_ENABLED;
  if (value == null) delete process.env.GRIDIRON_NEWS_STAMPS_ENABLED; else process.env.GRIDIRON_NEWS_STAMPS_ENABLED = value;
  try { return fn(); } finally {
    if (before == null) delete process.env.GRIDIRON_NEWS_STAMPS_ENABLED; else process.env.GRIDIRON_NEWS_STAMPS_ENABLED = before;
  }
};
const news = (headline, publishedAt, ingestedAt, editedAt = null) => {
  run(`INSERT INTO news_items (date, headline, importance, source, published_at, ingested_at, edited_at, entities_json)
       VALUES (?, ?, 2, 'fixture', ?, ?, ?, '{"players":[],"teams":[]}')`,
  publishedAt.slice(0, 10), headline, publishedAt, ingestedAt, editedAt);
  return row('SELECT id FROM news_items WHERE headline = ?', headline).id;
};

// On time, then edited two days later: the edit lands after the cut.
const EDITED = news('Fixture edited later', '2026-09-10T12:00:00.000Z', '2026-09-10T12:05:00.000Z', '2026-09-12T09:00:00.000Z');
// Published before the cut, received four days late (still before the cut).
const LATE = news('Fixture ingested late', '2026-09-01T12:00:00.000Z', '2026-09-05T12:00:00.000Z');
// Published and received after the cut.
const AFTER = news('Fixture after cut', '2026-09-11T06:00:00.000Z', '2026-09-11T06:01:00.000Z');
const CUT = '2026-09-11T00:00:00.000Z';

const knowledge = (asOf, type) => getEvents({ asOf, types: [type] }).map(e => e.payload.news_id);

test('flag off: the news adapter is unchanged (no edited_at read, no knowledge events)', () => {
  const adapter = ADAPTERS.find(a => a.stream === 'news');
  withFlag(null, () => {
    assert.doesNotMatch(adapter.sql('news_items'), /edited_at/);
    backfillStream('news');
  });
  assert.equal(row(`SELECT COUNT(*) n FROM engine_events WHERE event_type IN ('news.ingested', 'news.edited')`).n, 0);
  assert.equal(row(`SELECT COUNT(*) n FROM engine_events WHERE event_type = 'news.item'`).n, 3);
});

test('flag on: every row gets news.ingested, an edited row gets news.edited, with the stamps in the payload', () => {
  withFlag('1', () => backfillStream('news'));
  const ingested = rows(`SELECT * FROM engine_events WHERE event_type = 'news.ingested' ORDER BY id`);
  assert.equal(ingested.length, 3);
  const edit = row(`SELECT * FROM engine_events WHERE event_type = 'news.edited'`);
  const p = JSON.parse(edit.payload);
  assert.equal(p.news_id, EDITED);
  assert.deepEqual([p.published_at, p.edited_at], ['2026-09-10T12:00:00.000Z', '2026-09-12T09:00:00.000Z']);
  assert.equal(edit.as_of, '2026-09-12T09:00:00.000Z');
  const late = ingested.find(e => JSON.parse(e.payload).news_id === LATE);
  assert.equal(late.as_of, '2026-09-05T12:00:00.000Z', 'a late receipt is known when received, not when published');
  assert.equal(late.as_of_quality, 'first_seen');
  assert.equal(JSON.parse(late.payload).published_at, '2026-09-01T12:00:00.000Z');
});

test('an edit after the cut is not visible as of the cut through the spine', () => {
  assert.ok(!knowledge(CUT, 'news.edited').includes(EDITED), 'the spine served an edit made after the cut');
  assert.ok(knowledge('2026-09-13T00:00:00.000Z', 'news.edited').includes(EDITED), 'control: visible once made');
  assert.ok(knowledge(CUT, 'news.ingested').includes(EDITED), 'the first receipt, before the cut, is visible');
});

test('a late receipt is invisible between publish and receipt (news.item, valid time, is not)', () => {
  const between = '2026-09-03T00:00:00.000Z';
  assert.ok(!knowledge(between, 'news.ingested').includes(LATE));
  assert.ok(knowledge(between, 'news.item').includes(LATE), 'control: news.item keeps valid time');
});

test('the spine and newsKnownAtSql agree on the knowledge time of every row\'s current content', () => {
  const sqlKnown = cut => rows(`SELECT id FROM news_items WHERE ${newsKnownAtSql()} ORDER BY id`, cut).map(r => r.id);
  // A row's current content is known when its LAST knowledge event is (the edit, else the receipt).
  const spineKnown = cut => {
    const latest = new Map();
    for (const type of ['news.ingested', 'news.edited']) {
      for (const e of rows(`SELECT as_of, payload FROM engine_events WHERE event_type = ?`, type)) {
        const id = JSON.parse(e.payload).news_id;
        if (!latest.has(id) || e.as_of > latest.get(id)) latest.set(id, e.as_of);
      }
    }
    return [...latest].filter(([, at]) => at <= cut).map(([id]) => id).sort((a, b) => a - b);
  };
  for (const cut of ['2026-09-03T00:00:00.000Z', '2026-09-06T00:00:00.000Z', CUT, '2026-09-11T12:00:00.000Z',
    '2026-09-13T00:00:00.000Z']) {
    assert.deepEqual(spineKnown(cut), sqlKnown(cut), `cut ${cut}`);
  }
  assert.deepEqual(sqlKnown(CUT), [LATE], 'control: the cut separates the three rows');
  assert.ok(AFTER > 0);
});

test('a re-run appends nothing; a second edit appends one news.edited and no news.ingested', () => {
  const count = type => row('SELECT COUNT(*) n FROM engine_events WHERE event_type = ?', type).n;
  withFlag('1', () => backfillStream('news'));
  assert.deepEqual([count('news.ingested'), count('news.edited')], [3, 1]);
  run(`UPDATE news_items SET edited_at = '2026-09-14T08:00:00.000Z', headline = 'Fixture edited twice' WHERE id = ?`, EDITED);
  withFlag('1', () => backfillStream('news'));
  assert.deepEqual([count('news.ingested'), count('news.edited')], [3, 2]);
  assert.equal(knowledge('2026-09-13T00:00:00.000Z', 'news.edited').length, 1,
    'the second edit is not visible before it was made');
});
