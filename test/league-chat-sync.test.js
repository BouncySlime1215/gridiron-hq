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

test('freshness degrades with age, and only a recent pull reads as up to date', () => {
  const stats = { messages: 250 };
  assert.equal(sync.freshness(stats, { finished_at: hoursAgo(1) }).state, 'fresh');
  assert.equal(sync.freshness(stats, { finished_at: hoursAgo(24) }).state, 'aging');
  assert.equal(sync.freshness(stats, { finished_at: hoursAgo(24 * 5) }).state, 'stale');
  // The stale label is the one a person acts on, so it says days, not hours.
  assert.match(sync.freshness(stats, { finished_at: hoursAgo(24 * 5) }).label, /5 days/);
});

test('a corpus that arrived by upload is marked as never pulled here, not as fresh', () => {
  const f = sync.freshness({ messages: 250 }, null);
  assert.equal(f.state, 'unknown');
  assert.match(f.label, /Never pulled/i);
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
