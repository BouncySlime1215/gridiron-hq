/**
 * The run-sheet script, exercised end to end.
 *
 * `scripts/build-person-profiles.mjs` runs on Nick's Mac, by hand, against a
 * corpus that exists nowhere else. That is precisely the shape of script that
 * gets written, never run, and then fails at the moment someone is standing in
 * front of it — so it is run here against a fixture corpus instead: dry run,
 * then --write, then the table is read back.
 *
 * The property that matters most is the last one. The corpus never leaves that
 * machine; the derived table is meant to. So the test serialises everything
 * the script stored and asserts no message body is in it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-profile-script-'));
const APP_DB = path.join(temp, 'app.sqlite');
const CHAT_DB = path.join(temp, 'chat.sqlite');

/* A corpus with two people: one with real volume, one too quiet to report. */
const chat = new DatabaseSync(CHAT_DB);
chat.exec(`CREATE TABLE messages (msg_id INTEGER PRIMARY KEY, name TEXT, chat_kind TEXT,
  chat_name TEXT, ts_utc TEXT, text TEXT)`);
chat.exec(`CREATE TABLE jev_chat_signals (msg_id INTEGER, question TEXT, probability REAL)`);
let id = 0;
const say = (name, ts, text) => chat.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?)`)
  .run(++id, name, 'dm', 'dm:one', ts, text);
for (let i = 0; i < 12; i++) {
  const hour = String(8 + i).padStart(2, '0');
  say('ME', `2026-09-01T${hour}:00:00Z`, 'you free');
  say('Loud Person', `2026-09-01T${hour}:03:00Z`, 'THE UNMISTAKEABLE FIXTURE SENTENCE');
}
say('Quiet Person', '2026-09-02T10:00:00Z', 'sure');
chat.close();

const runScript = (...args) => spawnSync(process.execPath,
  ['scripts/build-person-profiles.mjs', ...args],
  { encoding: 'utf8', env: { ...process.env, GRIDIRON_DB_PATH: APP_DB, GRIDIRON_CHAT_DB_PATH: CHAT_DB } });

test('the dry run reports every person and writes nothing', () => {
  const dry = runScript();
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Loud Person/);
  assert.match(dry.stdout, /Quiet Person/);
  assert.match(dry.stdout, /nothing was written/i);
  const app = new DatabaseSync(APP_DB);
  const table = app.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='coach_person_variables'`).get();
  app.close();
  assert.equal(table, undefined, 'a dry run created the derived table');
});

test('--write loads the derived table, with the sample size on every row', () => {
  const wrote = runScript('--write');
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.match(wrote.stdout, /Wrote \d+ rows/);

  const app = new DatabaseSync(APP_DB);
  const stored = app.prepare(`SELECT * FROM coach_person_variables`).all();
  app.close();

  assert.ok(stored.length >= 40, `only ${stored.length} rows`);
  for (const row of stored) {
    assert.ok(Number.isInteger(row.n), `${row.variable} has no sample size`);
    assert.equal(row.priceable, 0, `${row.variable} was written priceable`);
    assert.ok(row.measured_by?.length > 20, `${row.variable} does not say how it was measured`);
    // The zero trap, stored rather than computed: a withheld value is NULL in
    // the table too, so a screen reading this cannot render it as 0.
    if (row.value === null) assert.ok(row.withheld, `${row.variable} is null with no reason given`);
  }
  const quiet = stored.filter(r => r.person === 'Quiet Person');
  assert.ok(quiet.length > 0, 'the quiet person is absent rather than empty');
  assert.equal(quiet.every(r => r.value === null), true,
    'one message is not enough to report anything about anyone');
});

test('nothing the script stored carries a message, so the table can leave the machine', () => {
  const app = new DatabaseSync(APP_DB);
  const stored = JSON.stringify(app.prepare(`SELECT * FROM coach_person_variables`).all());
  app.close();
  assert.equal(stored.includes('UNMISTAKEABLE'), false, 'a message body reached the derived table');
  assert.equal(stored.includes('you free'), false);
});

test('running it twice replaces rather than duplicates', () => {
  const app = new DatabaseSync(APP_DB);
  const before = app.prepare(`SELECT COUNT(*) AS n FROM coach_person_variables`).get().n;
  app.close();
  assert.equal(runScript('--write').status, 0);
  const after = new DatabaseSync(APP_DB);
  const count = after.prepare(`SELECT COUNT(*) AS n FROM coach_person_variables`).get().n;
  after.close();
  assert.equal(count, before, 'a second run doubled the table');
});

test('a machine without the corpus is told so plainly, and exits non-zero', () => {
  const missing = spawnSync(process.execPath, ['scripts/build-person-profiles.mjs'],
    { encoding: 'utf8',
      env: { ...process.env, GRIDIRON_DB_PATH: APP_DB, GRIDIRON_CHAT_DB_PATH: path.join(temp, 'nope.sqlite') } });
  // Non-zero, because a run sheet that silently does nothing reads as success.
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No chat corpus on this machine/);
  assert.match(missing.stderr, /run it where the corpus is/);
});
