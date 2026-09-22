/**
 * freshness() READS THE BLOCK. IT DOES NOT GO LOOKING.
 *
 * `chatCorpusState()` in manager-signals.js is the one reader of the chat
 * corpus's state: it resolves the path, says where the path came from, opens
 * the file, and returns `{ as_of, computed_at, rows, path, path_source,
 * collected_by, reason }`. `freshness()` turns that into the badge the UI
 * shows. Two functions, one query — and the whole value of that is lost the
 * moment the second one re-derives anything for itself.
 *
 * So these tests run with NO corpus file on disk and with
 * GRIDIRON_CHAT_DB_PATH pointed at a decoy that does not exist. Every fact in
 * the output has to come out of the argument. A `freshness()` that still calls
 * `chatDbPath()`, still opens a database, or still counts rows fails here
 * without any mutation being needed: there is nothing on this machine for it
 * to find.
 *
 * ONE THING THE BLOCK DOES NOT CARRY, and why the age is not simply its
 * `as_of`. The block's `as_of` is `MAX(last_msg)` over `manager_chat_profile`
 * — the newest message that survived the rollup, as of the last time the
 * rollup ran. `rollup()` runs only under `--rollup`
 * (scripts/chat/extract_league_chat.py:369), and its `base` CTE drops messages
 * with no sender name and messages with no text. So when new messages have
 * landed and the rollup has not been re-run, the block's `as_of` is older than
 * the corpus. Serving it as the age would make "the rollup is behind" read as
 * "nobody has said anything" — the same two-states-one-sentence defect this
 * whole branch exists to remove. The age stays the newest message
 * (the 07:15Z ruling); the block's `as_of` is what it is compared against.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-chat-block-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
// A decoy. Nothing is ever written here. If any assertion below sees this
// string, freshness() resolved the path for itself instead of reading it.
const DECOY = path.join(temp, 'decoy-never-created.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = DECOY;

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const chatSync = await import('../server/services/league-chat-sync.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const REAL = '/somewhere/else/entirely/league_chat.sqlite';
const hoursAgo = h => new Date(Date.now() - h * 3.6e6).toISOString().replace(/\.\d+Z$/, 'Z');

/** The block exactly as chatCorpusState() returns it, plus the corpus's own newest message. */
function block(over = {}) {
  return {
    as_of: hoursAgo(3),
    computed_at: hoursAgo(1),
    rows: 7,
    path: REAL,
    path_source: 'GRIDIRON_CHAT_DB_PATH',
    collected_by: 'the league_chat step of scripts/refresh-live-data.mjs (off-server)',
    reason: null,
    newest_message: hoursAgo(3),
    ...over,
  };
}

/* ------------------------------------------------- nothing is re-derived */

test('the path in every sentence is the block\'s, never the one freshness could look up', () => {
  const present = chatSync.freshness(block(), null);
  const absent = chatSync.freshness(
    block({ as_of: null, computed_at: null, rows: 0, newest_message: null,
      reason: `there is no chat corpus at ${REAL} — it cannot be produced on this machine` }), null);
  for (const [which, f] of [['present', present], ['absent', absent]]) {
    const text = JSON.stringify(f);
    assert.ok(!text.includes(DECOY),
      `the ${which} state leaked ${DECOY}: freshness resolved the path itself instead of reading the block, `
      + 'and on a box where the two disagree it would name a file nobody looked at');
  }
  assert.match(absent.note, new RegExp(REAL.replace(/\//g, '\\/')),
    'the absent state is the one that most needs to say where we looked, and it looked where the block says');
});

test('the block\'s own reason is carried, not replaced with a generic sentence', () => {
  // Two absences with the same shape and completely different fixes. The block
  // is what tells them apart, via path_source; a freshness() that writes its
  // own sentence throws that away and sends a mistyped env var to the Mac.
  const typo = chatSync.freshness(block({
    as_of: null, computed_at: null, rows: 0, newest_message: null, path: '/typo/league_chat.sqlite',
    path_source: 'GRIDIRON_CHAT_DB_PATH',
    reason: 'there is no chat corpus at /typo/league_chat.sqlite — it cannot be produced on this machine '
      + '(it is extracted from Apple Messages on Nick\'s Mac) but it can be uploaded to this one '
      + 'with POST /api/league-chat/upload',
  }), null);
  assert.equal(typo.state, 'absent');
  assert.match(typo.note, /\/typo\/league_chat\.sqlite/);
  assert.match(typo.note, /GRIDIRON_CHAT_DB_PATH/,
    'path_source is the whole difference between a mistyped variable and a machine with no corpus');
});

test('a corpus that is here but has never been rolled up is not reported as absent', () => {
  // rows: 0 on the block means no manager profiles. That is NOT no chat data —
  // the messages are there and dated, the rollup simply has not run. Collapsing
  // it to "absent" tells someone to go pull on the Mac when the fix is one flag.
  const f = chatSync.freshness(block({ as_of: null, computed_at: null, rows: 0,
    newest_message: hoursAgo(2),
    reason: `the chat corpus at ${REAL} is here but has no manager profiles yet` }), null);
  assert.notEqual(f.state, 'absent', 'there are messages with dates on them; that is chat data');
  assert.equal(f.as_of, hoursAgo(2));
  assert.equal(f.rollup, 'missing');
  assert.match(f.note, /no manager profiles yet/,
    'the block already wrote the sentence that names the actual fix');
});

/* --------------------------------------------- the rollup lag, named out loud */

test('when the rollup is behind the corpus the age is still the newest message, and the lag is said', () => {
  const f = chatSync.freshness(block({ as_of: hoursAgo(72), newest_message: hoursAgo(2) }), null);
  assert.equal(f.as_of, hoursAgo(2),
    'the ruling is that the age of the chat data is the newest message; MAX(last_msg) is the newest '
    + 'ROLLED-UP message and lags it by however long since --rollup last ran');
  assert.equal(f.state, 'fresh', 'a two-hour-old conversation is fresh even when the rollup is three days behind');
  assert.equal(f.rollup, 'behind');
  // Assert the FACT, not the word. The first draft matched /rollup/i and failed
  // a sentence that says the thing in plainer English than "rollup" does; that
  // is a test asserting its own vocabulary. What has to be in the note is the
  // cutoff — the stamp a reader compares against the newest message to see the
  // gap for themselves.
  assert.match(f.note, new RegExp(hoursAgo(72)),
    'a stale rollup over a fresh corpus is a real, fixable state, and the note has to name the point '
    + 'the profiles were built up to or there is nothing to act on');
});

test('a rollup level by level: current, behind, missing', () => {
  assert.equal(chatSync.freshness(block(), null).rollup, 'current',
    'as_of equal to the newest message means the rollup has seen everything');
  assert.equal(chatSync.freshness(block({ as_of: hoursAgo(50) }), null).rollup, 'behind');
  assert.equal(chatSync.freshness(block({ as_of: null, rows: 0 }), null).rollup, 'missing');
});

/* ----------------------------------------------------- provenance, all of it */

test('computed_at and the pull stamp sit beside the age, and neither is ever the age', () => {
  const f = chatSync.freshness(block({ as_of: hoursAgo(30), newest_message: hoursAgo(30),
    computed_at: hoursAgo(1) }), { finished_at: hoursAgo(1) });
  assert.equal(f.as_of, hoursAgo(30));
  assert.equal(f.state, 'aging', 'a 30-hour-old conversation is aging no matter how recently anything ran');
  assert.match(f.note, new RegExp(hoursAgo(1)), 'the rollup stamp is shown');
  assert.match(f.provenance ?? '', /pulled on this machine/);
  assert.match(f.note, new RegExp(hoursAgo(30)), 'and the age it is shown beside');
});

test('the collector is named, because "run the rollup" is useless without saying what runs it', () => {
  const f = chatSync.freshness(block({ as_of: hoursAgo(50) }), null);
  assert.match(f.collected_by ?? '', /refresh-live-data/,
    'the block carries who collects this; dropping it makes every stale state a dead end');
});

/* -------------------------------------------------- legacy stamps still normalise */

test('a block built from a corpus that predates the ISO change is still served as ISO', () => {
  // chatCorpusState() reads the stamps straight out of the corpus. A corpus
  // uploaded before the extractor started writing ISO carries SQLite's
  // 'YYYY-MM-DD HH:MM:SS', and those do not sort against ISO. Normalising is
  // this consumer's job and stays load-bearing until every corpus is re-pulled.
  const f = chatSync.freshness(block({
    as_of: '2026-09-19 14:03:22', newest_message: '2026-09-19 14:03:22', computed_at: '2026-09-19 15:00:00',
  }), null);
  assert.match(String(f.as_of), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    'the badge puts this next to the transactions as_of and the archetype build as_of, both toISOString()');
  assert.equal(f.as_of, '2026-09-19T14:03:22Z');
  assert.ok(!f.note.includes('2026-09-19 15:00:00'),
    'the rollup stamp is shown to a person and must not be shown in a second format');
});

/* ------------------------------------------------------- the mapping is honest */

test('STATE_MAPPING names every state the block can report, including the two it added', () => {
  const m = chatSync.STATE_MAPPING;
  assert.ok(!('no_path_configured' in m),
    'chatDbPath() always returns a string, so this state was unreachable and claiming to map it was folklore');
  for (const key of ['file_not_on_this_machine', 'present_but_not_rolled_up',
    'present_but_undatable', 'present_and_dated']) {
    assert.ok(key in m, `${key} is a state the block reports and the mapping has to say what it becomes`);
  }
});

/* --------------------------------- the producer, end to end on a real file */

/**
 * Everything above hands `freshness()` a literal, which is the right way to
 * test a pure consumer and the wrong way to leave it: it means no test ever
 * runs the query that fills the block in. `MIN` for `MAX` on `last_msg`, or
 * dropping `collected_by`, would pass all nine.
 *
 * So one corpus on disk, with the rollup deliberately behind the messages,
 * read by the real producer and fed to the real consumer.
 */
test('a corpus on disk whose rollup is behind is read that way, producer through consumer', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(temp, 'real-corpus.sqlite');
  const c = new DatabaseSync(file);
  c.exec(`CREATE TABLE messages (msg_id INTEGER, name TEXT, ts_utc TEXT, text TEXT);
          CREATE TABLE jev_chat_signals (msg_id INTEGER, question TEXT);
          CREATE TABLE manager_chat_profile (name TEXT, last_msg TEXT, computed_at TEXT);
          CREATE TABLE manager_player_sentiment (name TEXT, player TEXT)`);
  // Two messages. The rollup saw the older one and has not run since the newer.
  for (const [id, ts] of [[1, '2026-09-14T08:00:00Z'], [2, '2026-09-19T21:30:00Z']]) {
    c.prepare('INSERT INTO messages VALUES (?, ?, ?, ?)').run(id, 'Alda Reyes', ts, 'hi');
  }
  // TWO profile rows with different last_msg, so MIN and MAX are not the same
  // value and the query cannot pass by accident on a single-row table.
  c.prepare('INSERT INTO manager_chat_profile VALUES (?,?,?)').run('Alda Reyes', '2026-09-14T08:00:00Z', '2026-09-14T08:05:00Z');
  c.prepare('INSERT INTO manager_chat_profile VALUES (?,?,?)').run('Bo Nakamura', '2026-09-15T09:00:00Z', '2026-09-15T09:05:00Z');
  c.close();

  const before = process.env.GRIDIRON_CHAT_DB_PATH;
  process.env.GRIDIRON_CHAT_DB_PATH = file;
  try {
    const stats = chatSync.corpusStats();
    assert.equal(stats.as_of, '2026-09-15T09:00:00Z',
      'as_of is the NEWEST message the rollup has seen; MIN would give 2026-09-14 and look like a rollup '
      + 'that is a day further behind than it is');
    assert.equal(stats.computed_at, '2026-09-15T09:05:00Z');
    assert.equal(stats.newest_message, '2026-09-19T21:30:00Z');
    assert.equal(stats.rows, 2);

    const f = chatSync.freshness(stats, null);
    assert.equal(f.as_of, '2026-09-19T21:30:00Z', 'the age is the corpus, not the rollup');
    assert.equal(f.rollup, 'behind');
    assert.match(f.note, /2026-09-15T09:00:00Z/, 'and the point the profiles reach is in the sentence');
    assert.match(f.collected_by ?? '', /refresh-live-data/,
      'the producer fills this in; a literal block in the tests above cannot prove that it does');
    assert.equal(f.path, file, 'and the path it actually read');
  } finally { process.env.GRIDIRON_CHAT_DB_PATH = before; }
});
