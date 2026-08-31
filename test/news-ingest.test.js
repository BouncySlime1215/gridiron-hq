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
const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
await runMigrations();
seedIfEmpty();

const { RSS_SOURCES, parseRssItems, ingestRssSource } = await import('../server/news/ingest.js');
const { upsertNormalizedNewsItem } = await import('../server/news/store.js');
const { normalizeNewsItem } = await import('../server/news/normalize.js');
const { default: newsRouter } = await import('../server/routes/news.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { playerNewsSignal, syncStructuredNewsSignals } = await import('../server/services/nfl-news-signal.js');
const { NATIONAL_INSIDER_HANDLES, TEAM_HANDLES, BEAT_REPORTER_HANDLES,
  TWITTER_SWEEP_HANDLES, twitterSweepHandles } = await import('../server/news/twitter-ingest.js');
const { JOBS } = await import('../server/services/scheduler.js');

run(`INSERT INTO users (subject) VALUES ('news:ingest-caller')`);
const ingestUserId = row(`SELECT id FROM users WHERE subject='news:ingest-caller'`).id;
run(`INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES (?,?,datetime('now','+1 day'))`,
  ingestUserId, hashSessionToken('news-ingest-token'));

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const app = express();
app.use(express.json());
app.use('/api/news', newsRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));

async function request(url, { body, method = 'GET', token } = {}) {
  const encoded = body === undefined ? '' : JSON.stringify(body);
  const headers = encoded ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)) } : {};
  if (token) headers.authorization = `Bearer ${token}`;
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

test('news scheduler ingests publisher feeds and rotates ESPN team coverage', () => {
  assert.equal(JOBS.rss_news.tier, 'live');
  assert.equal(JOBS.rss_news.maxAgeMinutes, 15);
  assert.equal(JOBS.espn_news.tier, 'live');
  assert.equal(JOBS.espn_news.maxAgeMinutes, 30);
});

test('Twitter news sweep rotates through national, official, and beat sources', () => {
  const first = twitterSweepHandles(0, 5);
  const second = twitterSweepHandles(5, 5);
  assert.notDeepEqual(first, second);
  assert.ok(TWITTER_SWEEP_HANDLES.length > NATIONAL_INSIDER_HANDLES.length);
  assert.ok(TWITTER_SWEEP_HANDLES.includes(Object.values(TEAM_HANDLES)[0]));
  assert.ok(TWITTER_SWEEP_HANDLES.includes(Object.values(BEAT_REPORTER_HANDLES).flat()[0]));
  const covered = new Set();
  for (let cursor = 0; cursor < TWITTER_SWEEP_HANDLES.length; cursor += 5) {
    for (const handle of twitterSweepHandles(cursor, 5)) covered.add(handle);
  }
  assert.equal(covered.size, TWITTER_SWEEP_HANDLES.length);
});

test('parseRssItems decodes ordinary XML entities in non-CDATA fields', () => {
  const xml = `<rss><channel>
    <item><title>Smith &amp; Jones: WR1 &lt;questionable&gt;</title>
      <link>https://example.com/entities</link>
      <description>Listed at 90% &amp; trending down</description>
      <pubDate>Mon, 24 Aug 2026 23:50:36 EST</pubDate></item>
  </channel></rss>`;
  const items = parseRssItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Smith & Jones: WR1 <questionable>');
  assert.equal(items[0].description, 'Listed at 90% & trending down');
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

test('configured live RSS source is normalized and returned by GET /api/news with provenance', async () => {
  const source = RSS_SOURCES[0];
  const xml = `<rss><channel><item>
    <title><![CDATA[Configured feed provenance check]]></title>
    <link><![CDATA[https://www.espn.com/nfl/story/_/id/12345/provenance-check?utm_source=rss]]></link>
    <description><![CDATA[An item delivered by the configured publisher feed.]]></description>
    <pubDate>Tue, 25 Aug 2026 12:00:00 GMT</pubDate>
  </item></channel></rss>`;
  const result = await ingestRssSource(source, { fetchImpl: async url => {
    assert.equal(url, source.url);
    return { ok: true, text: async () => xml };
  } });
  assert.equal(result.inserted, 1);

  const response = await request('/');
  assert.equal(response.status, 200);
  const article = response.payload.find(item => item.headline === 'Configured feed provenance check');
  assert.ok(article);
  assert.equal(article.source, source.name);
  assert.equal(article.canonical_url, 'https://www.espn.com/nfl/story/_/id/12345/provenance-check');
  assert.ok(Number.isFinite(Date.parse(article.ingested_at)));
  assert.notEqual(article.source, 'AI analysis');
  assert.equal(row(`SELECT COUNT(*) AS n FROM news_items WHERE source='AI analysis'`).n, 0);
});

test('normalize.js rejects "AI analysis" as a source before it ever reaches storage', () => {
  assert.throws(() => normalizeNewsItem({
    source: 'AI analysis', source_url: 'https://example.com/b', headline: 'x', published_at: '2026-08-01T00:00:00Z'
  }), /not a valid reporting source/);
});

test('typed fake news is quarantined while verified publisher evidence reaches player context', () => {
  const player = row(`SELECT p.id,p.name,t.abbr,t.id team_id FROM players p
    JOIN nfl_teams t ON t.id=p.team_id WHERE p.name IS NOT NULL LIMIT 1`);
  const now = new Date().toISOString();
  const identity = { players: [{ id: player.id, name: player.name }], teams: [] };
  const fake = normalizeNewsItem({ source: 'NFL Truth Wire', source_type: 'publisher',
    source_url: 'https://fake-gridiron-news.example/injury-1', published_at: now,
    headline: `${player.name} ruled out for Sunday` }, { identity });
  const trusted = normalizeNewsItem({ source: 'ESPN', source_type: 'publisher',
    source_url: 'https://www.espn.com/nfl/story/_/id/999999/injury-verified', published_at: now,
    headline: `${player.name} limited in practice` }, { identity });
  upsertNormalizedNewsItem(fake, { teamId: player.team_id });
  upsertNormalizedNewsItem(trusted, { teamId: player.team_id });
  syncStructuredNewsSignals({ sinceDays: 1 });
  const states = rows(`SELECT source,verification_state FROM nfl_news_signals
    WHERE player_key IS NOT NULL AND source IN ('NFL Truth Wire','ESPN') ORDER BY source`);
  assert.deepEqual(states.map(item => [item.source, item.verification_state]),
    [['ESPN', 'verified'], ['NFL Truth Wire', 'quarantined']]);
  const signal = playerNewsSignal(player.name, { team: player.abbr, maxAgeDays: 1 });
  assert.ok(signal);
  assert.ok(signal.claims.every(claim => claim.verification_state === 'verified'));
  assert.ok(signal.claims.every(claim => claim.source !== 'NFL Truth Wire'));
});

test('manual news POST rejects the literal "AI analysis" as a source', async () => {
  const rejected = await request('/', { method: 'POST', token: 'news-ingest-token', body: { date: '2026-08-25', headline: 'Manual note', source: 'AI Analysis' } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.payload.error, /not a valid reporting source/);

  const accepted = await request('/', { method: 'POST', token: 'news-ingest-token', body: { date: '2026-08-25', headline: 'Manual note', source: 'Beat writer' } });
  assert.equal(accepted.status, 200);
  assert.equal(row(`SELECT source FROM news_items WHERE headline='Manual note'`).source, 'Beat writer');
});

test('POST /ingest requires authentication', async () => {
  const anonymous = await request('/ingest', { method: 'POST' });
  assert.equal(anonymous.status, 401);
});

test('ranked news desk requires authentication and returns a bounded freshness summary', async () => {
  assert.equal((await request('/desk')).status, 401);
  const desk = await request('/desk?limit=20', { token: 'news-ingest-token' });
  assert.equal(desk.status, 200);
  assert.ok(Array.isArray(desk.payload.stories));
  assert.ok(desk.payload.stories.length <= 20);
  assert.ok(Number.isInteger(desk.payload.stats.stories));
  assert.ok('latest_ingest_age_minutes' in desk.payload.stats);
});

test('news mutation and API-spending routes reject anonymous callers', async () => {
  assert.equal((await request('/', { method: 'POST', body: { date: '2026-08-25', headline: 'x' } })).status, 401);
  assert.equal((await request('/1', { method: 'DELETE' })).status, 401);
  assert.equal((await request('/analyze', { method: 'POST', body: { date: '2026-08-25', items: [] } })).status, 401);
  assert.equal((await request('/1/explain', { method: 'POST' })).status, 401);
  assert.equal((await request('/roundup', { method: 'POST', body: {} })).status, 401);
});

test('POST /ingest runs the pipeline for an authenticated caller', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '<rss><channel></channel></rss>' });
  try {
    const authenticated = await request('/ingest', { method: 'POST', token: 'news-ingest-token' });
    assert.equal(authenticated.status, 200, JSON.stringify(authenticated.payload));
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('a corrected headline updates the existing row instead of forking a duplicate', () => {
  const original = normalizeNewsItem({
    source: 'Wire', source_url: 'https://example.com/corrected-story', headline: 'Player questionable for Sunday',
    published_at: '2026-08-03T00:00:00Z'
  });
  const corrected = normalizeNewsItem({
    source: 'Wire', source_url: 'https://example.com/corrected-story', headline: 'Player ruled out for Sunday',
    published_at: '2026-08-03T00:00:00Z'
  });
  const a = upsertNormalizedNewsItem(original);
  const b = upsertNormalizedNewsItem(corrected);
  assert.equal(a.id, b.id);
  assert.equal(row('SELECT COUNT(*) AS n FROM news_items WHERE canonical_url=?', original.canonical_url).n, 1);
  assert.equal(row('SELECT headline FROM news_items WHERE id=?', a.id).headline, 'Player ruled out for Sunday');
});
