/**
 * A message the chat classifier could not label must be retried, and giving up must be
 * loud.
 *
 * review-fixes-2, finding 3 (silent-failure-hunter): scripts/news-line/jev_league_chat.mts
 * wrote jev_chat_done with ok = 0 for a failed row and exited 0. The backlog query only
 * counts rows MISSING from jev_chat_done, so a parked row never came back — during a
 * gateway outage every row attempted in that 15-minute tick would be parked for good.
 * 18 rows sit parked in the live chat DB (2026-09-17). Infra-essentials made the count
 * visible (sync_log 'partial'); this makes the rows recoverable:
 *   - a failed row carries `attempts` and is re-sent while attempts < MAX_ATTEMPTS;
 *   - a row that exhausts its attempts is given up ONCE, loudly, with a non-zero exit;
 *   - scripts/chat/extract_league_chat.py counts the same rows as backlog.
 *
 * The classifier runs for real here (node runs the .mts directly); only `evaluate` is
 * stubbed, through the NODE_ENV=test seam, so no message leaves this machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const SCRIPT = path.join(REPO, 'scripts/news-line/jev_league_chat.mts');
const source = fs.readFileSync(SCRIPT, 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-chat-retry-'));
const chatDb = path.join(temp, 'league_chat.sqlite');
const appDb = path.join(temp, 'app.sqlite');
const stub = path.join(temp, 'evaluate-stub.mjs');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

function seed() {
  fs.rmSync(chatDb, { force: true });
  const chat = new DatabaseSync(chatDb);
  chat.exec(`CREATE TABLE messages (msg_id INTEGER PRIMARY KEY, chat_kind TEXT, chat_name TEXT, handle TEXT,
    name TEXT, is_from_me INTEGER, ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER)`);
  chat.exec(`INSERT INTO messages VALUES (1, 'group', 'League', 'h1', 'Alice', 0, '2026-09-17T18:00:00Z', 'want to trade?', 0, 0)`);
  chat.close();
  fs.rmSync(appDb, { force: true });
  const app = new DatabaseSync(appDb);
  app.exec(`CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, position TEXT);
            CREATE TABLE player_week_usage (player_id INTEGER, season INTEGER, week INTEGER);
            INSERT INTO players VALUES (1, 'Bijan Robinson', 'RB');
            INSERT INTO player_week_usage VALUES (1, 2026, 1);`);
  app.close();
}

/** @returns {{ status: number, out: string }} */
function runClassifier(mode) {
  // Hard precondition, checked before every spawn: without the fixture seam the script
  // opens the real private chat database and sends real messages to the gateway.
  for (const seam of [/LEAGUE_CHAT_OUT/, /GRIDIRON_DB_PATH/, /JEV_EVALUATE_MODULE/, /NODE_ENV/]) {
    assert.match(source, seam, 'refusing to run the classifier without its fixture seam');
  }
  fs.writeFileSync(stub, mode === 'throw'
    ? 'export const evaluate = async () => { throw new Error("gateway 503"); };\n'
    : `export const evaluate = async () => ({
         answers: { topic: { type: 'choice', choice: 'trade_talk', probabilities: { trade_talk: 1 } } },
         usage: { inputTokens: 10 } });\n`);
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test', NODE_OPTIONS: '', LEAGUE_CHAT_OUT: chatDb, GRIDIRON_DB_PATH: appDb, JEV_EVALUATE_MODULE: stub }
    });
    return { status: 0, out };
  } catch (error) {
    return { status: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const doneRow = () => {
  const chat = new DatabaseSync(chatDb, { readOnly: true });
  try { return chat.prepare('SELECT * FROM jev_chat_done WHERE msg_id = 1').get() ?? null; }
  finally { chat.close(); }
};

test('the classifier reads its databases from the environment, so it can be run against a fixture', () => {
  // Checked before anything is spawned: without this the script would open the real
  // private chat database and send real messages to the gateway.
  assert.match(source, /LEAGUE_CHAT_OUT/);
  assert.match(source, /GRIDIRON_DB_PATH/);
  assert.match(source, /JEV_EVALUATE_MODULE/);
  assert.match(source, /NODE_ENV/);
  seed();
  const { status, out } = runClassifier('ok');
  assert.equal(status, 0, out);
  assert.equal(doneRow()?.ok, 1, out);
});

test('a failed row is retried on the next run and given up only after MAX_ATTEMPTS, with a non-zero exit', () => {
  assert.match(source, /LEAGUE_CHAT_OUT/);
  seed();
  const first = runClassifier('throw');
  assert.equal(first.status, 0, `a retryable failure is not a failed run: ${first.out}`);
  assert.equal(doneRow().ok, 0);
  assert.equal(doneRow().attempts, 1);
  assert.match(first.out, /1 failed/);

  const second = runClassifier('throw');
  assert.equal(doneRow().attempts, 2, `the parked row must be re-sent: ${second.out}`);

  const third = runClassifier('throw');
  assert.equal(doneRow().attempts, 3);
  assert.notEqual(third.status, 0, 'giving up on a message is a non-zero exit');
  assert.match(third.out, /gave up/i);

  // Exhausted: not re-sent again, and the run is clean (the count is still reported by
  // scripts/chat/extract_league_chat.py every tick).
  const fourth = runClassifier('throw');
  assert.equal(doneRow().attempts, 3, 'an exhausted row is not re-sent');
  assert.equal(fourth.status, 0);
  assert.match(fourth.out, /0 messages to classify/);
});

test('a row parked before the attempts column existed keeps the retries it has left, not a full set', () => {
  seed();
  // The live table (18 parked rows, 2026-09-17): one attempt each, no attempts column.
  const chat = new DatabaseSync(chatDb);
  chat.exec(`CREATE TABLE jev_chat_done (msg_id INTEGER PRIMARY KEY, evaluated_at TEXT, input_tokens INTEGER, ok INTEGER, error TEXT)`);
  chat.exec(`INSERT INTO jev_chat_done VALUES (1, '2026-09-17T19:55:00Z', 0, 0, 'Question "tone" did not select a highest-probability option.')`);
  chat.close();
  const first = runClassifier('throw');
  assert.equal(doneRow().attempts, 2, `the stored row counts as one attempt already used: ${first.out}`);
  const second = runClassifier('throw');
  assert.equal(doneRow().attempts, 3);
  assert.notEqual(second.status, 0, 'giving up is a non-zero exit');
});

test('a retried row that succeeds is labelled and leaves the backlog', () => {
  seed();
  runClassifier('throw');
  assert.equal(doneRow().ok, 0);
  const good = runClassifier('ok');
  assert.equal(doneRow().ok, 1, good.out);
  assert.equal(doneRow().attempts, 2);
  const again = runClassifier('ok');
  assert.match(again.out, /0 messages to classify/);
});
