/**
 * R-07: ESPN's RSS feed labels US Eastern *daylight* wall time "EST". Read
 * literally (fixed -05:00) every stamp lands one hour late, so a story fetched
 * within the hour is stored as published after we fetched it.
 *
 * The fixtures are real values from the local copy (not production) and the
 * live feed on 2026-09-22 — see docs/tdd/2026-09-22-news-published-at-timezone.tdd.md:
 * row 11990 was fetched at 19:40:50.483Z with <pubDate>Tue, 22 Sep 2026 15:15:32 EST</pubDate>
 * and stored as 20:15:32Z, 34.7 minutes after the fetch.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { Readable, PassThrough } from 'node:stream';
import { ServerResponse } from 'node:http';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-news-tz-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
await runMigrations();
seedIfEmpty();

const { ingestRssSource } = await import('../server/news/ingest.js');
const normalize = await import('../server/news/normalize.js');
const { normalizeNewsItem } = normalize;
const { default: newsRouter } = await import('../server/routes/news.js');
const { hashSessionToken } = await import('../server/platform/auth.js');

run(`INSERT INTO users (subject) VALUES ('news:tz-caller')`);
const userId = row(`SELECT id FROM users WHERE subject='news:tz-caller'`).id;
run(`INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES (?,?,datetime('now','+1 day'))`,
  userId, hashSessionToken('news-tz-token'));

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const app = express();
app.use(express.json());
app.use('/api/news', newsRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));

async function request(url, { token } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const req = new Readable({ read() { this.push(null); } });
  req.url = `/api/news${url}`; req.method = 'GET'; req.headers = headers;
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => { if (chunk) chunks.push(Buffer.from(chunk)); const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, payload: text ? JSON.parse(text) : null }); };
    app.handle(req, res, reject);
  });
}

const FETCH_CLOCK = '2026-09-22T19:40:50.483Z';
const espnFeed = items => `<rss><channel><lastBuildDate>Tue, 22 Sep 2026 19:40:00 GMT</lastBuildDate>${items.map(item => `
  <item><title><![CDATA[${item.title}]]></title>
    <link><![CDATA[${item.link}]]></link>
    <description><![CDATA[R-07 fixture]]></description>
    <pubDate>${item.pubDate}</pubDate></item>`).join('')}
</channel></rss>`;
const raw = published_at => ({ source: 'ESPN', source_type: 'publisher', source_url: 'https://example.com/tz',
  headline: 'tz fixture', published_at });

test('an ESPN "EST" stamp in September is Eastern daylight time (the three census rows)', () => {
  // ids 11990, 11293, 8010 on the local copy: raw pubDate -> true instant.
  assert.equal(normalizeNewsItem(raw('Tue, 22 Sep 2026 15:15:32 EST')).published_at, '2026-09-22T19:15:32.000Z');
  assert.equal(normalizeNewsItem(raw('Tue, 22 Sep 2026 09:22:52 EST')).published_at, '2026-09-22T13:22:52.000Z');
  assert.equal(normalizeNewsItem(raw('Sun, 20 Sep 2026 13:17:41 EST')).published_at, '2026-09-20T17:17:41.000Z');
  // updated_at defaults to the same parse, so it moves with it.
  assert.equal(normalizeNewsItem(raw('Tue, 22 Sep 2026 15:15:32 EST')).updated_at, '2026-09-22T19:15:32.000Z');
});

test('spellings that were already right stay right (passes before and after by design)', () => {
  // Winter: EST really is -05:00, and Eastern wall time agrees.
  assert.equal(normalizeNewsItem(raw('Tue, 22 Dec 2026 15:15:32 EST')).published_at, '2026-12-22T20:15:32.000Z');
  // An honest daylight label, a numeric offset, GMT, and ISO are not reinterpreted.
  assert.equal(normalizeNewsItem(raw('Tue, 22 Sep 2026 15:15:32 EDT')).published_at, '2026-09-22T19:15:32.000Z');
  assert.equal(normalizeNewsItem(raw('Tue, 22 Sep 2026 15:15:32 -0400')).published_at, '2026-09-22T19:15:32.000Z');
  assert.equal(normalizeNewsItem(raw('Tue, 22 Sep 2026 19:15:32 GMT')).published_at, '2026-09-22T19:15:32.000Z');
  assert.equal(normalizeNewsItem(raw('2026-09-22T19:15:32Z')).published_at, '2026-09-22T19:15:32.000Z');
  // Other US zones keep JavaScript's fixed-offset reading (not measured, not changed).
  assert.equal(normalizeNewsItem(raw('Tue, 22 Sep 2026 15:15:32 PST')).published_at, '2026-09-22T23:15:32.000Z');
  // Garbage still refuses rather than storing a made-up time.
  assert.throws(() => normalizeNewsItem(raw('not a date')), RangeError);
});

test('Eastern edge cases: the repeated autumn hour resolves to the earlier instant, never a later one', () => {
  // 01:30 happens twice on 2026-11-01 (05:30Z daylight, 06:30Z standard). ESPN's
  // letter carries no information, so take the earlier: never stamp the future.
  assert.equal(normalizeNewsItem(raw('Sun, 01 Nov 2026 01:30:00 EST')).published_at, '2026-11-01T05:30:00.000Z');
  // A day with no weekday prefix and a single-digit day still parses.
  assert.equal(normalizeNewsItem(raw('2 Oct 2026 08:05:09 EST')).published_at, '2026-10-02T12:05:09.000Z');
  // An impossible date refuses instead of rolling over.
  assert.throws(() => normalizeNewsItem(raw('Wed, 31 Sep 2026 10:00:00 EST')), RangeError);
});

test('the RSS writer stores the true instant, never later than its own fetch clock', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(FETCH_CLOCK) });
  t.after(() => mock.timers.reset());
  const xml = espnFeed([{ title: 'R-07 writer fixture', link: 'https://www.espn.com/nfl/story/_/id/990001/r07-writer',
    pubDate: 'Tue, 22 Sep 2026 15:15:32 EST' }]);
  const result = await ingestRssSource({ name: 'ESPN', url: 'https://example.com/rss', sourceType: 'publisher' },
    { fetchImpl: async () => ({ ok: true, text: async () => xml }) });
  assert.equal(result.inserted, 1);
  const stored = row(`SELECT published_at, ingested_at FROM news_items WHERE headline = ?`, 'R-07 writer fixture');
  assert.equal(stored.ingested_at, FETCH_CLOCK);
  assert.equal(stored.published_at, '2026-09-22T19:15:32.000Z');
  assert.ok(Date.parse(stored.published_at) <= Date.parse(stored.ingested_at),
    `published_at ${stored.published_at} is after the fetch clock ${stored.ingested_at}`);
  assert.equal(result.future_stamped, 0);
});

test('a feed stamp still ahead of the fetch clock is counted on the ingest result, not hidden', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(FETCH_CLOCK) });
  t.after(() => mock.timers.reset());
  const xml = espnFeed([
    { title: 'R-07 honest stamp', link: 'https://www.espn.com/nfl/story/_/id/990002/r07-honest', pubDate: 'Tue, 22 Sep 2026 19:30:00 GMT' },
    // 30 minutes after the fetch in an unambiguous zone: the feed itself is ahead.
    { title: 'R-07 future stamp', link: 'https://www.espn.com/nfl/story/_/id/990003/r07-future', pubDate: 'Tue, 22 Sep 2026 20:10:50 GMT' }
  ]);
  const result = await ingestRssSource({ name: 'ESPN', url: 'https://example.com/rss', sourceType: 'publisher' },
    { fetchImpl: async () => ({ ok: true, text: async () => xml }) });
  assert.equal(result.inserted, 2);
  assert.equal(result.future_stamped, 1);
  // The row keeps the feed's own value; the fetch clock beside it is the label.
  const stored = row(`SELECT published_at, ingested_at FROM news_items WHERE headline = ?`, 'R-07 future stamp');
  assert.equal(stored.published_at, '2026-09-22T20:10:50.000Z');
  assert.equal(stored.ingested_at, FETCH_CLOCK);
});

test('consumer: the news desk ages the story from the corrected time (25 min, not a clamped 0)', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(FETCH_CLOCK) });
  t.after(() => mock.timers.reset());
  const xml = espnFeed([{ title: 'R-07 desk fixture', link: 'https://www.espn.com/nfl/story/_/id/990004/r07-desk',
    pubDate: 'Tue, 22 Sep 2026 15:15:32 EST' }]);
  await ingestRssSource({ name: 'ESPN', url: 'https://example.com/rss', sourceType: 'publisher' },
    { fetchImpl: async () => ({ ok: true, text: async () => xml }) });
  const response = await request('/desk?limit=120', { token: 'news-tz-token' });
  assert.equal(response.status, 200);
  const story = response.payload.stories.find(item => item.headline === 'R-07 desk fixture');
  assert.ok(story, 'desk did not return the fixture story');
  // routes/news.js:71 clamps negative ages to 0, which is how the defect hid.
  assert.equal(story.age_minutes, 25);
  assert.equal(story.published_at, '2026-09-22T19:15:32.000Z');
});
