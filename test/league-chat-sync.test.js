/**
 * league-chat-sync — the one piece of the system that cannot run in the cloud,
 * and the reporting that makes that visible instead of silent.
 *
 * The corpus behind the Trade Brain's counterparty read is extracted from
 * Messages on a Mac. When the app runs anywhere else the engine still works, it
 * just prices every ladder on our own numbers — which is a correct fallback and
 * a terrible surprise. These tests pin the two things that keep it from being a
 * surprise: the capability check tells the truth about the machine it is on,
 * and the freshness read never calls a corpus current when it isn't.
 *
 * Offline and deterministic: a temp DB, a hand-built corpus, no Messages access.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-chat-sync-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'league_chat.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const sync = await import('../server/services/league-chat-sync.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** A corpus with the tables manager-signals actually opens. */
function buildCorpus(file, { messages = 100, classified = 80 } = {}) {
  const c = new DatabaseSync(file);
  c.exec(`CREATE TABLE messages (msg_id INTEGER PRIMARY KEY, sent_at TEXT, sender TEXT, text TEXT);
          CREATE TABLE jev_chat_signals (message_id TEXT, speaker TEXT, signal TEXT);
          CREATE TABLE manager_chat_profile (name TEXT PRIMARY KEY, messages INTEGER);
          CREATE TABLE manager_player_sentiment (name TEXT, player TEXT, sentiment REAL);`);
  const m = c.prepare('INSERT INTO messages VALUES (?,?,?,?)');
  for (let i = 1; i <= messages; i++) m.run(i, `2026-09-${String((i % 28) + 1).padStart(2, '0')} 12:00:00`, 'A', 'x');
  const j = c.prepare('INSERT INTO jev_chat_signals VALUES (?,?,?)');
  for (let i = 1; i <= classified; i++) j.run(String(i), 'A', 'loves');
  c.prepare('INSERT INTO manager_chat_profile VALUES (?,?)').run('Alpha One', messages);
  c.prepare('INSERT INTO manager_player_sentiment VALUES (?,?,?)').run('Alpha One', 'Someone', 3.5);
  c.close();
}

/* ------------------------------------------------- capability, honestly told */

test('on a machine with no Messages database the capability says so, and says where to pull instead', () => {
  // This suite's own box is the cloud case: there is no ~/Library/Messages here.
  process.env.LEAGUE_CHAT_SRC = path.join(temp, 'definitely-not-here.db');
  const cap = sync.extractionCapability();
  assert.equal(cap.can, false);
  assert.equal(cap.reason, 'no_messages_db');
  assert.match(cap.detail, /cloud box|laptop/i, 'the reason must point at the machine that can do it');
});

test('a Messages database that exists but cannot be opened is reported as access, not absence', () => {
  // The confusing Mac case: the file is there, every read throws. Simulated with
  // a file that is not a database at all, which fails the same way at open time.
  const bogus = path.join(temp, 'not-a-db.db');
  fs.writeFileSync(bogus, 'this is not sqlite');
  process.env.LEAGUE_CHAT_SRC = bogus;
  const cap = sync.extractionCapability();
  assert.equal(cap.can, false);
  assert.equal(cap.reason, 'no_disk_access');
  assert.match(cap.detail, /Full Disk Access/);
});

/* --------------------------------------------------------- what is installed */

test('corpusStats reports null when there is no corpus, and real counts when there is', () => {
  assert.equal(sync.corpusStats(), null, 'no corpus yet');
  buildCorpus(process.env.GRIDIRON_CHAT_DB_PATH, { messages: 250, classified: 200 });
  const stats = sync.corpusStats();
  assert.equal(stats.messages, 250);
  assert.equal(stats.classified, 200);
  assert.equal(stats.managers, 1);
  assert.ok(stats.size_bytes > 0);
});

/* ------------------------------------------------------------- freshness read */

const hoursAgo = h => new Date(Date.now() - h * 3.6e6).toISOString();

test('a corpus that is absent or empty is never called anything but absent', () => {
  for (const stats of [null, { messages: 0 }]) {
    const f = sync.freshness(stats, { finished_at: new Date().toISOString() });
    assert.equal(f.state, 'absent', 'a just-now pull cannot make a missing corpus fresh');
    assert.match(f.note, /our numbers only/);
  }
});

/*
 * These two tests asserted the OLD contract, in which the pull stamp WAS the
 * age. That contract was overturned deliberately (2026-09-20): the age of the
 * chat data is the newest message in the corpus, and the pull stamp and the
 * rollup stamp are provenance shown beside it, never alternative ages. The
 * tests are rewritten to the new rule rather than the code being bent back to
 * pass them — see docs/tdd/archetype-as-of.tdd.md, Part 5, for why.
 */

test('freshness degrades with the age of the conversation, not with the age of the pull', () => {
  const recentPull = { finished_at: hoursAgo(1) };
  assert.equal(sync.freshness({ messages: 250, newest_message: hoursAgo(1) }, recentPull).state, 'fresh');
  assert.equal(sync.freshness({ messages: 250, newest_message: hoursAgo(24) }, recentPull).state, 'aging');
  assert.equal(sync.freshness({ messages: 250, newest_message: hoursAgo(24 * 5) }, recentPull).state, 'stale');
  // The stale label is the one a person acts on, so it says days, not hours.
  assert.match(sync.freshness({ messages: 250, newest_message: hoursAgo(24 * 5) }, recentPull).label, /5 days/);
  // The point of the rule: pulling a week-old conversation five minutes ago
  // does not make the conversation recent, and the old code said it did.
  assert.equal(sync.freshness({ messages: 250, newest_message: hoursAgo(24 * 7) }, recentPull).state, 'stale');
});

test('a corpus that arrived by upload is dated by its messages, with the upload as provenance', () => {
  const f = sync.freshness({ messages: 250, newest_message: hoursAgo(2) }, null);
  assert.equal(f.state, 'fresh', 'it has messages, so it has an age; no local pull is not no age');
  assert.match(f.provenance ?? '', /uploaded, not pulled here/);
});

test('messages that carry no readable date are the only unknown left', () => {
  const f = sync.freshness({ messages: 250 }, null);
  assert.equal(f.state, 'unknown');
  assert.equal(f.as_of, null);
});

/* ------------------------------------------------------------- the whole card */

test('status() answers from any machine and carries capability, corpus and freshness together', () => {
  process.env.LEAGUE_CHAT_SRC = path.join(temp, 'definitely-not-here.db');
  const s = sync.status();
  assert.equal(s.capability.can, false, 'this box cannot extract, and says so');
  assert.equal(s.corpus.messages, 250, 'but it can still report what it is pricing on');
  assert.ok(s.freshness.state, 'and how old that is');
});

test('pull() refuses rather than half-running where extraction is impossible', async () => {
  process.env.LEAGUE_CHAT_SRC = path.join(temp, 'definitely-not-here.db');
  const r = await sync.pull();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_messages_db');
  // Nothing was recorded as a pull, so the freshness read is not reset by a
  // refusal — a button press that could not run must not age the corpus forward.
  assert.equal(sync.lastPull(), null);
});

/* ------------------------------------------------------- the upload receiver */

/**
 * The cloud box's receiving end. What matters here is not the happy path but
 * the two refusals: a corpus that is not a corpus, and one that is empty. Both
 * would install cleanly and then read downstream exactly like having no chat
 * data at all — the engine would price every ladder "on our numbers only" and
 * nothing would look broken. So they are rejected, and whatever was already
 * installed is left alone.
 *
 * `express.json()` is mounted here the way server/index.js mounts it globally,
 * so this also pins that the raw body still arrives through it.
 */
const express = (await import('express')).default;
const { default: leagueChatRouter } = await import('../server/routes/league-chat.js');

const app = express();
app.use(express.json());
app.use('/api/league-chat', leagueChatRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/league-chat`;
test.after(() => server.close());

const post = (path, body, type = 'application/octet-stream') =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': type }, body });

test('status is answerable over HTTP from a machine that cannot extract', async () => {
  process.env.LEAGUE_CHAT_SRC = path.join(temp, 'definitely-not-here.db');
  const res = await fetch(`${base}/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.capability.can, false);
  assert.ok(body.freshness.state);
});

test('a file that is not the corpus is refused, and the installed one is untouched', async () => {
  const before = sync.corpusStats().messages;
  const res = await post('/upload', Buffer.from('this is not sqlite'));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'not_the_corpus');
  assert.equal(sync.corpusStats().messages, before, 'the existing corpus must survive a bad upload');
});

test('an empty corpus is refused rather than installed as "no chat data"', async () => {
  const before = sync.corpusStats().messages;
  const empty = path.join(temp, 'empty-corpus.sqlite');
  buildCorpus(empty, { messages: 0, classified: 0 });
  const res = await post('/upload', fs.readFileSync(empty));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'empty_corpus');
  assert.equal(sync.corpusStats().messages, before);
});

test('an empty body is refused with a usable message rather than a stack trace', async () => {
  const res = await post('/upload', Buffer.alloc(0));
  assert.equal(res.status, 400);
  assert.match((await res.json()).detail, /--data-binary/);
});

test('a real corpus installs, and the previous one is kept beside it', async () => {
  const fresh = path.join(temp, 'fresh-corpus.sqlite');
  buildCorpus(fresh, { messages: 900, classified: 700 });
  const res = await post('/upload', fs.readFileSync(fresh));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.messages, 900);
  assert.equal(sync.corpusStats().messages, 900, 'the engine now reads the new corpus');
  const kept = fs.readdirSync(temp).filter(f => f.includes('league_chat.sqlite.replaced-'));
  assert.equal(kept.length, 1, 'the replaced corpus is one rename away, not gone');
});

test('pull over HTTP is refused from a non-loopback caller, and says where it does work', async () => {
  const res = await fetch(`${base}/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'not_local');
  assert.match(body.detail, /Mac/);
});
