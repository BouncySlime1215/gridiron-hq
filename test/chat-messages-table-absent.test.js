/**
 * WHERE THE messages TABLE ITSELF IS NOT THERE, SAY SO — DO NOT REPORT IT THE
 * SAME WAY AS A COLUMN READ FAILING.
 *
 * `test/chat-age.test.js` already covers a `messages` table that exists but is
 * missing `ts_utc` (an old corpus, or a hand-built one) — that case throws,
 * gets caught, and reports `newest_message_error` matching `ts_utc`. Nobody
 * had tested the table being absent entirely: a corpus sqlite file that
 * exists (so `corpusStats()` does not return `null` for "no corpus at all")
 * but was never run through `scripts/chat/extract_league_chat.py`, the only
 * thing in this repo that creates `messages`. Before this, `count('messages')`
 * and the `newest_message` read both throw "no such table: messages", and
 * both catches swallow it into the same shape a column-read failure produces
 * — a caller cannot tell "this corpus was never extracted" from "this corpus
 * has a broken column" from the fields alone, only by string-matching an
 * error message that happens to name the table.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-chat-messages-absent-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const CORPUS = path.join(temp, 'league_chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CORPUS;

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const chatSync = await import('../server/services/league-chat-sync.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** A corpus file that exists but was never run through the extractor: no
 *  `messages` table at all, only the tables a later stage might have written
 *  against a stale schema. */
function buildCorpusWithoutMessagesTable() {
  fs.rmSync(CORPUS, { force: true });
  const c = new DatabaseSync(CORPUS);
  c.exec(`CREATE TABLE manager_chat_profile (name TEXT, msgs INTEGER, computed_at TEXT)`);
  c.close();
}

test('a corpus file with no messages table says so by name, not by a generic read error', () => {
  buildCorpusWithoutMessagesTable();
  const s = chatSync.corpusStats();
  assert.notEqual(s, null, 'fixture sanity: the corpus file exists, so this is not the no-corpus-at-all case');
  assert.equal(s.newest_message, null, 'no table means no age to report');
  assert.equal(s.newest_message_state, 'table_absent',
    'a caller needs a field to branch on, not a string it has to pattern-match');
  assert.match(s.newest_message_reason ?? '', /messages/,
    'names the table that is missing');
  assert.match(s.newest_message_reason ?? '', /extract_league_chat\.py/,
    'names the one thing in this repo that creates it, so a reader does not go looking elsewhere');
  assert.equal(s.newest_message_error, undefined,
    'table_absent is a different state from read_failed, and must not carry that state\'s field');
});

test('a table that exists but cannot be read is still read_failed, unchanged by this fix', () => {
  fs.rmSync(CORPUS, { force: true });
  const c = new DatabaseSync(CORPUS);
  c.exec(`CREATE TABLE messages (msg_id INTEGER, text TEXT)`);
  c.prepare(`INSERT INTO messages (msg_id, text) VALUES (1, 'hi')`).run();
  c.close();
  const s = chatSync.corpusStats();
  assert.equal(s.newest_message, null);
  assert.equal(s.newest_message_state, 'read_failed');
  assert.match(s.newest_message_error ?? '', /ts_utc/);
});

test('a normal corpus is state present, unchanged by this fix', () => {
  fs.rmSync(CORPUS, { force: true });
  const c = new DatabaseSync(CORPUS);
  c.exec(`CREATE TABLE messages (msg_id INTEGER, ts_utc TEXT, text TEXT)`);
  c.prepare(`INSERT INTO messages (msg_id, ts_utc, text) VALUES (1, '2026-09-19T14:03:22Z', 'hi')`).run();
  c.close();
  const s = chatSync.corpusStats();
  assert.equal(s.newest_message, '2026-09-19T14:03:22Z');
  assert.equal(s.newest_message_state, 'present');
  assert.equal(s.newest_message_error, undefined);
  assert.equal(s.newest_message_reason, undefined);
});
