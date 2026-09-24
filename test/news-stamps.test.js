/**
 * BROKEN-Q: news timing. Collector stamps (ingested_at on every insert,
 * edited_at on a revision, ingested_at never overwritten) and the as-of news
 * reads, behind GRIDIRON_NEWS_STAMPS_ENABLED / preview mode. With the flag off
 * every writer and reader behaves exactly as before (the last block).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { Readable, PassThrough } from 'node:stream';
import { ServerResponse } from 'node:http';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-news-stamps-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_NEWS_STAMPS_ENABLED;

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { upsertNormalizedNewsItem } = await import('../server/news/store.js');
const { normalizeNewsItem } = await import('../server/news/normalize.js');
const { newsStampsFlag } = await import('../server/news/stamps.js');
const { syncRosterEventsFromNews } = await import('../server/services/nfl-player-state.js');
const { __test: council } = await import('../server/services/nfl-expert-council.js');
const espn = await import('../server/routes/espn.js');
const { default: newsRouter } = await import('../server/routes/news.js');
const { hashSessionToken } = await import('../server/platform/auth.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function withFlag(value, fn) {
  const before = process.env.GRIDIRON_NEWS_STAMPS_ENABLED;
  if (value == null) delete process.env.GRIDIRON_NEWS_STAMPS_ENABLED;
  else process.env.GRIDIRON_NEWS_STAMPS_ENABLED = value;
  try { return fn(); } finally {
    if (before == null) delete process.env.GRIDIRON_NEWS_STAMPS_ENABLED;
    else process.env.GRIDIRON_NEWS_STAMPS_ENABLED = before;
  }
}
async function withFlagAsync(value, fn) {
  process.env.GRIDIRON_NEWS_STAMPS_ENABLED = value;
  try { return await fn(); } finally { delete process.env.GRIDIRON_NEWS_STAMPS_ENABLED; }
}

run(`INSERT INTO users (subject) VALUES ('news:stamps-caller')`);
const userId = row(`SELECT id FROM users WHERE subject='news:stamps-caller'`).id;
run(`INSERT INTO auth_sessions (user_id,token_hash,expires_at) VALUES (?,?,datetime('now','+1 day'))`,
  userId, hashSessionToken('news-stamps-token'));
const app = express();
app.use(express.json());
app.use('/api/news', newsRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));
function post(url, body) {
  const encoded = JSON.stringify(body);
  const req = new Readable({ read() { this.push(encoded); this.push(null); } });
  req.url = `/api/news${url}`; req.method = 'POST';
  req.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)),
    authorization: 'Bearer news-stamps-token' };
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: res.statusCode, payload: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }); };
    app.handle(req, res, reject);
  });
}

const base = {
  source: 'Wire', headline: 'Practice report filed', published_at: '2026-08-04T00:00:00Z'
};

test('flag: 1 on, 0 off, unset follows preview mode', () => {
  assert.deepEqual(withFlag('1', newsStampsFlag), { on: true, preview: false });
  assert.deepEqual(withFlag('0', newsStampsFlag), { on: false, preview: false });
  assert.deepEqual(withFlag(null, newsStampsFlag), { on: false, preview: false });
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    assert.deepEqual(withFlag(null, newsStampsFlag), { on: true, preview: true });
    assert.deepEqual(withFlag('0', newsStampsFlag), { on: false, preview: false }, '0 vetoes preview');
  } finally { delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; }
});

test('migration 087 adds a nullable edited_at to news_items', () => {
  const col = rows(`PRAGMA table_info(news_items)`).find(c => c.name === 'edited_at');
  assert.ok(col, 'edited_at column exists');
  assert.equal(col.notnull, 0);
});

test('flag on: a revision stamps edited_at and never overwrites ingested_at', () => withFlag('1', () => {
  const url = 'https://example.com/stamps-revision';
  const a = upsertNormalizedNewsItem(normalizeNewsItem({ ...base, source_url: url }, { ingestedAt: '2026-08-06T12:00:00.000Z' }));
  let stored = row('SELECT ingested_at, edited_at FROM news_items WHERE id=?', a.id);
  assert.deepEqual({ ...stored }, { ingested_at: '2026-08-06T12:00:00.000Z', edited_at: null });

  const b = upsertNormalizedNewsItem(normalizeNewsItem({ ...base, source_url: url, summary: 'Added to injury report Friday' },
    { ingestedAt: '2026-08-08T09:30:00.000Z' }));
  assert.equal(b.id, a.id);
  stored = row('SELECT body, ingested_at, edited_at FROM news_items WHERE id=?', a.id);
  assert.equal(stored.body, 'Added to injury report Friday');
  assert.equal(stored.ingested_at, '2026-08-06T12:00:00.000Z', 'first receipt is kept');
  assert.equal(stored.edited_at, '2026-08-08T09:30:00.000Z', 'the revision is recorded as an edit');

  // A pure resend leaves both stamps alone.
  upsertNormalizedNewsItem(normalizeNewsItem({ ...base, source_url: url, summary: 'Added to injury report Friday' },
    { ingestedAt: '2026-08-10T00:00:00.000Z' }));
  stored = row('SELECT ingested_at, edited_at FROM news_items WHERE id=?', a.id);
  assert.deepEqual({ ...stored }, { ingested_at: '2026-08-06T12:00:00.000Z', edited_at: '2026-08-08T09:30:00.000Z' });
}));

test('flag on: the ESPN pull stamps ingested_at on insert', () => withFlag('1', () => {
  const before = Date.now();
  const added = espn.__test.insertArticles([{ headline: 'Stamps ESPN story', description: 'x', published: '2026-09-01T10:00:00Z' }], []);
  assert.equal(added, 1);
  const stored = row(`SELECT ingested_at FROM news_items WHERE headline='Stamps ESPN story'`);
  assert.ok(stored.ingested_at, 'ESPN rows carry ingested_at');
  assert.ok(Date.parse(stored.ingested_at) >= before - 1000);
}));

test('flag on: manual POST /api/news stamps ingested_at on insert', async () => withFlagAsync('1', async () => {
  const res = await post('/', { date: '2026-09-01', headline: 'Stamps manual story', source: 'Beat writer' });
  assert.equal(res.status, 200);
  assert.ok(row(`SELECT ingested_at FROM news_items WHERE headline='Stamps manual story'`).ingested_at);
}));

run(`INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES (961,'ZSA','Zed Stamps A','AFC','East'),
  (962,'ZSB','Zed Stamps B','AFC','East')`);
const CUTOFF = '2026-11-02T00:00:00.000Z';
let nextNewsId = 96001;
function seedStory({ team_id = 961, published_at, ingested_at = null, edited_at = null, created_at, source = 'test', extra = {} }) {
  const id = nextNewsId++;
  run(`INSERT INTO news_items (id,date,team_id,headline,source,source_url,published_at,ingested_at,edited_at,created_at,entities_json,reliability_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, published_at.slice(0, 10), team_id, extra.headline ?? `Depth chart note ${id}`, source,
    'https://espn.com/x', published_at, ingested_at, edited_at, created_at, extra.entities ?? null, extra.reliability ?? null);
  return id;
}

test('flag on: newsFor counts a story with no ingested_at by its created_at, and drops one edited after the cut', () => {
  // Three rows with no ingested_at, inserted (created_at) before the cut: the
  // old read dropped all three (NULL <= cut is not true).
  for (let i = 0; i < 3; i++) seedStory({ published_at: '2026-11-01T10:00:00.000Z', created_at: '2026-11-01 10:05:00' });
  // Ingested on time but edited after the cut: its stored content is not what existed at the cut.
  seedStory({ team_id: 962, published_at: '2026-11-01T10:00:00.000Z', ingested_at: '2026-11-01T10:05:00.000Z',
    edited_at: '2026-11-03T00:00:00.000Z', created_at: '2026-11-01 10:05:00' });
  // No ingested_at and inserted after the cut (same calendar day as the cut: a TEXT compare would get this wrong).
  seedStory({ team_id: 962, published_at: '2026-11-01T10:00:00.000Z', created_at: '2026-11-02 08:00:00' });

  const off = withFlag('0', () => council.newsFor({ home: 'ZSA', away: 'ZSB' }, CUTOFF));
  assert.equal(off.feed_stories, 1, 'flag off: old read sees only the ingested row (edited or not)');
  const on = withFlag('1', () => council.newsFor({ home: 'ZSA', away: 'ZSB' }, CUTOFF));
  assert.equal(on.feed_stories, 3, 'flag on: the three created-before-cut rows count; edited-after and created-after do not');
});

test('flag on: syncRosterEventsFromNews excludes a wire edited after the cut and keeps an unstamped one inserted before it', () => {
  const seedWire = (stamps, name) => {
    const playerId = nextNewsId + 5000;
    run(`INSERT INTO players (id,name,position) VALUES (?,?,'WR')`, playerId, name);
    return seedStory({ source: 'ESPN Transactions', published_at: '2026-11-01T10:00:00.000Z', ...stamps, extra: {
      headline: `Waived WR ${name}.`,
      entities: JSON.stringify({ players: [{ id: playerId, name, confidence: 0.99 }] }),
      reliability: JSON.stringify({ tier: 'official_wire', score: 0.95 }) } });
  };
  const unstamped = seedWire({ created_at: '2026-11-01 10:05:00' }, 'Stamps Unstamped');
  const edited = seedWire({ ingested_at: '2026-11-01T10:05:00.000Z', edited_at: '2026-11-04T00:00:00.000Z',
    created_at: '2026-11-01 10:05:00' }, 'Stamps Edited');
  withFlag('1', () => syncRosterEventsFromNews({ before: CUTOFF }));
  const events = id => rows(`SELECT 1 FROM nfl_player_roster_events WHERE news_id=?`, id).length;
  assert.equal(events(unstamped), 1, 'a wire inserted before the cut is knowable at it');
  assert.equal(events(edited), 0, 'a wire edited after the cut is not');
});

test('flag off: store keeps the old behaviour (a revision advances ingested_at, edited_at untouched)', () => withFlag('0', () => {
  const url = 'https://example.com/stamps-off-revision';
  const a = upsertNormalizedNewsItem(normalizeNewsItem({ ...base, source_url: url }, { ingestedAt: '2026-08-06T12:00:00.000Z' }));
  upsertNormalizedNewsItem(normalizeNewsItem({ ...base, source_url: url, summary: 'changed' }, { ingestedAt: '2026-08-08T09:30:00.000Z' }));
  const stored = row('SELECT ingested_at, edited_at FROM news_items WHERE id=?', a.id);
  assert.deepEqual({ ...stored }, { ingested_at: '2026-08-08T09:30:00.000Z', edited_at: null });
}));

test('flag off: the ESPN pull and manual entry still leave ingested_at NULL', async () => {
  withFlag('0', () => espn.__test.insertArticles([{ headline: 'Stamps ESPN off', published: '2026-09-01T10:00:00Z' }], []));
  assert.equal(row(`SELECT ingested_at FROM news_items WHERE headline='Stamps ESPN off'`).ingested_at, null);
  await withFlagAsync('0', () => post('/', { date: '2026-09-01', headline: 'Stamps manual off' }));
  assert.equal(row(`SELECT ingested_at FROM news_items WHERE headline='Stamps manual off'`).ingested_at, null);
});
