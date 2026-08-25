import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { Readable, PassThrough } from 'node:stream';
import { ServerResponse } from 'node:http';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-news-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
await runMigrations();
seedIfEmpty();

const { parseRssItems, ingestRssSource } = await import('../server/news/ingest.js');
const { upsertNormalizedNewsItem } = await import('../server/news/store.js');
const { normalizeNewsItem } = await import('../server/news/normalize.js');
const { default: newsRouter } = await import('../server/routes/news.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const app = express();
app.use(express.json());
app.use('/api/news', newsRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));

async function request(url, { body, method = 'GET' } = {}) {
  const encoded = body === undefined ? '' : JSON.stringify(body);
  const headers = encoded ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)) } : {};
  const req = new Readable({ read() { this.push(encoded || null); if (encoded) this.push(null); } });
  req.url = `/api/news${url}`; req.method = method; req.headers = headers;
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => { if (chunk) chunks.push(Buffer.from(chunk)); const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, payload: text ? JSON.parse(text) : null }); };
    app.handle(req, res, reject);
  });
}

test('parseRssItems extracts title/link/description/pubDate and unwraps CDATA', () => {
  const xml = `<rss><channel>
    <item><title><![CDATA[Team signs veteran RB]]></title>
      <link><![CDATA[https://example.com/story?utm_source=x]]></link>
      <description><![CDATA[Details here]]></description>
      <pubDate>Mon, 24 Aug 2026 23:50:36 EST</pubDate>
      <dc:creator><![CDATA[Jane Reporter]]></dc:creator></item>
    <item><title>No link item</title></item>
  </channel></rss>`;
  const items = parseRssItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Team signs veteran RB');
  assert.equal(items[0].link, 'https://example.com/story?utm_source=x');
  assert.equal(items[0].creator, 'Jane Reporter');
});

test('ingestRssSource normalizes, attributes, and dedupes into news_items', async () => {
  const team = row(`SELECT abbr, name FROM nfl_teams LIMIT 1`);
  const xml = `<rss><channel>
    <item><title><![CDATA[${team.name} make a roster move]]></title>
      <link><![CDATA[https://example.com/a?utm_source=x]]></link>
      <description><![CDATA[Roster update]]></description>
      <pubDate>Mon, 24 Aug 2026 12:00:00 EST</pubDate></item>
  </channel></rss>`;
  const fetchImpl = async () => ({ ok: true, text: async () => xml });
  const first = await ingestRssSource({ name: 'ESPN', url: 'https://example.com/rss', sourceType: 'publisher' }, { fetchImpl });
  assert.equal(first.inserted, 1);
  assert.equal(first.updated, 0);

  const stored = row(`SELECT * FROM news_items WHERE source_url LIKE 'https://example.com/a%'`);
  assert.equal(stored.source, 'ESPN');
  assert.equal(stored.source_type, 'publisher');
  assert.notEqual(stored.source, 'AI analysis');
  assert.ok(stored.duplicate_group_id);
  assert.equal(stored.attribution_required, 1);

  // Re-ingesting the same story updates the existing row instead of duplicating it.
  const second = await ingestRssSource({ name: 'ESPN', url: 'https://example.com/rss', sourceType: 'publisher' }, { fetchImpl });
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 1);
  assert.equal(row(`SELECT COUNT(*) AS n FROM news_items WHERE source_url LIKE 'https://example.com/a%'`).n, 1);
});

test('normalize.js rejects "AI analysis" as a source before it ever reaches storage', () => {
  assert.throws(() => normalizeNewsItem({
    source: 'AI analysis', source_url: 'https://example.com/b', headline: 'x', published_at: '2026-08-01T00:00:00Z'
  }), /not a valid reporting source/);
});

test('manual news POST rejects the literal "AI analysis" as a source', async () => {
  const rejected = await request('/', { method: 'POST', body: { date: '2026-08-25', headline: 'Manual note', source: 'AI Analysis' } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.payload.error, /not a valid reporting source/);

  const accepted = await request('/', { method: 'POST', body: { date: '2026-08-25', headline: 'Manual note', source: 'Beat writer' } });
  assert.equal(accepted.status, 200);
  assert.equal(row(`SELECT source FROM news_items WHERE headline='Manual note'`).source, 'Beat writer');
});

test('upsertNormalizedNewsItem is idempotent on duplicate_group_id', () => {
  const normalized = normalizeNewsItem({
    source: 'Wire', source_url: 'https://example.com/c', headline: 'Depth chart shakeup',
    published_at: '2026-08-02T00:00:00Z'
  });
  const a = upsertNormalizedNewsItem(normalized);
  const b = upsertNormalizedNewsItem({ ...normalized, summary: 'updated summary' });
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, false);
  assert.equal(a.id, b.id);
  assert.equal(row('SELECT body FROM news_items WHERE id=?', a.id).body, 'updated summary');
});
