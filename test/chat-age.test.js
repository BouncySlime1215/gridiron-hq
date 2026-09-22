/**
 * ONE CLOCK FOR THE CHAT DATA.
 *
 * "How old is the chat data" had three possible answers and no ruling: the
 * newest message in the corpus, the rollup's `computed_at`, and the last local
 * pull's `finished_at`. They disagree — an uploaded corpus has no local pull at
 * all — and the surfaces picked different ones.
 *
 * The ruling: the AGE is the newest message timestamp. The rollup stamp and the
 * pull stamp are PROVENANCE shown beside it, never alternative ages. So an
 * uploaded corpus is not 'unknown'; it is dated by its newest message, with
 * "uploaded, not pulled here" as the provenance.
 *
 * And every stamp on the chat side is ISO 8601 UTC, because the manager card
 * puts chat's `as_of` next to the transactions' `as_of` and the archetype
 * build's, both of which are `new Date().toISOString()`. Two fields with the
 * same name that cannot be compared is worse than one missing field.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-chat-age-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const CORPUS = path.join(temp, 'league_chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CORPUS;

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const chatSync = await import('../server/services/league-chat-sync.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * A corpus in the shape the extractor writes. `legacy` builds it with the
 * pre-ISO stamps a corpus pulled before this change still carries, which is the
 * case a reader will actually meet.
 */
function buildCorpus({ legacy = false, messages = true, profiles = true } = {}) {
  fs.rmSync(CORPUS, { force: true });
  const c = new DatabaseSync(CORPUS);
  c.exec(`CREATE TABLE messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT,
            name TEXT, is_from_me INTEGER, ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER)`);
  c.exec(`CREATE TABLE manager_chat_profile (name TEXT, msgs INTEGER, computed_at TEXT)`);
  c.exec(`CREATE TABLE jev_chat_signals (msg_id INTEGER, question TEXT, probability REAL)`);
  c.exec(`CREATE TABLE manager_player_sentiment (name TEXT, player TEXT, computed_at TEXT)`);
  const stamp = legacy
    ? ts => ts.replace('T', ' ').replace(/(\.\d+)?Z$/, '')
    : ts => ts;
  if (messages) {
    for (const [id, ts] of [[1, '2026-09-18T11:02:00Z'], [2, '2026-09-19T14:03:22Z']]) {
      c.prepare(`INSERT INTO messages (msg_id, chat_kind, chat_name, name, is_from_me, ts_utc, text)
                 VALUES (?, 'dm', 'Alda Reyes', 'Alda Reyes', 0, ?, 'hi')`).run(id, stamp(ts));
    }
  }
  if (profiles) {
    c.prepare(`INSERT INTO manager_chat_profile (name, msgs, computed_at) VALUES ('Alda Reyes', 2, ?)`)
      .run(stamp('2026-09-19T15:00:00Z'));
  }
  c.close();
}

test('the newest message is actually read — the old query named a column the table does not have', () => {
  buildCorpus();
  const s = chatSync.corpusStats();
  assert.equal(s.messages, 2);
  assert.ok(s.newest_message,
    'messages has ts_utc, never sent_at; the old SELECT MAX(sent_at) threw into a bare catch and '
    + 'newest_message was null on every corpus that has ever existed');
  assert.equal(s.newest_message, '2026-09-19T14:03:22Z');
});

test('a corpus written before this change is still dated, and reported in ISO', () => {
  buildCorpus({ legacy: true });
  const s = chatSync.corpusStats();
  assert.match(s.newest_message, ISO,
    'a legacy stamp is normalised on the way out, or half the corpora on disk report a format '
    + 'nothing else on the card uses');
  assert.equal(s.newest_message, '2026-09-19T14:03:22Z');
});

test('the rollup stamp is provenance beside the age, not an alternative age', () => {
  buildCorpus();
  const s = chatSync.corpusStats();
  assert.equal(s.computed_at, '2026-09-19T15:00:00Z');
  assert.notEqual(s.computed_at, s.newest_message,
    'fixture sanity: the rollup ran after the last message, which is the normal case');
});

test('every stamp the chat side serves parses as ISO 8601 UTC', () => {
  buildCorpus({ legacy: true });
  const s = chatSync.status();
  for (const [field, value] of Object.entries({
    newest_message: s.corpus.newest_message, computed_at: s.corpus.computed_at,
    as_of: s.freshness.as_of,
  })) {
    assert.match(String(value), ISO, `${field} is not ISO 8601 UTC, and it sits beside two fields that are`);
    assert.ok(Number.isFinite(Date.parse(String(value))), `${field} does not parse`);
  }
});

test('an uploaded corpus is dated by its newest message, not called unknown', () => {
  buildCorpus();
  // No local pull row at all, which is exactly what an uploaded corpus looks like.
  const f = chatSync.freshness(chatSync.corpusStats(), null);
  assert.notEqual(f.state, 'unknown',
    'a corpus with messages in it has an age; "unknown" was answering the provenance question instead');
  assert.equal(f.as_of, '2026-09-19T14:03:22Z', 'the age is the newest message');
  assert.match(f.provenance ?? '', /uploaded, not pulled here/,
    'the provenance is shown beside the age, which is the whole point of separating them');
});

test('the state enum the client types is unchanged, and every upstream state maps into it', () => {
  const allowed = new Set(['fresh', 'aging', 'stale', 'absent', 'unknown']);
  buildCorpus({ messages: false, profiles: false });
  assert.ok(allowed.has(chatSync.freshness(chatSync.corpusStats(), null).state));
  fs.rmSync(CORPUS, { force: true });
  assert.equal(chatSync.freshness(chatSync.corpusStats(), null).state, 'absent',
    'no file at all is absent, and the client colours off this enum');
  assert.ok(chatSync.STATE_MAPPING && Object.keys(chatSync.STATE_MAPPING).length >= 4,
    'the four upstream states have to say which client state each becomes, or the mapping is folklore');
});

test('a present corpus with no messages is absent, not a date of null', () => {
  buildCorpus({ messages: false });
  const f = chatSync.freshness(chatSync.corpusStats(), null);
  assert.equal(f.state, 'absent');
  assert.equal(f.as_of, null, 'no messages is no age, and no age must not be an empty string or a 1970 date');
});

test('a corpus whose timestamp column is unreadable says so instead of going quiet', () => {
  // The defect this replaces was a bare catch: the query named a column that
  // does not exist, threw on every corpus, and reported null. A real older
  // corpus without the column has to be distinguishable from one with no
  // messages, or the same silence comes back by another route.
  fs.rmSync(CORPUS, { force: true });
  const c = new DatabaseSync(CORPUS);
  c.exec(`CREATE TABLE messages (msg_id INTEGER, text TEXT)`);
  c.prepare(`INSERT INTO messages (msg_id, text) VALUES (1, 'hi')`).run();
  c.close();
  const s = chatSync.corpusStats();
  assert.equal(s.messages, 1, 'fixture sanity: there are messages');
  assert.equal(s.newest_message, null);
  assert.match(s.newest_message_error ?? '', /ts_utc/,
    'a swallowed throw is how this was broken for the whole life of the corpus');
  assert.equal(chatSync.freshness(s, null).state, 'unknown',
    'messages that cannot be dated are genuinely unknown, not fresh and not absent');
});
