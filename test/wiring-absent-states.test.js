/**
 * Three findings from the wiring map on 791b131, in the files this thread owns.
 *
 * They are one finding in three places: a value that exists but cannot be
 * accounted for. A metric written to a table nobody named reads. A read of a
 * database that is absent by design on the deployed box, returning an empty
 * collection that looks exactly like "he has never said anything". A field
 * assembled into a payload and consumed by nothing.
 *
 * The chat corpus is the reason the second one is not a bug to fix but a state
 * to label: `data/derived/league_chat.sqlite` is extracted from Apple Messages
 * by a Python script needing a Mac and Full Disk Access, so on Fly it is not
 * missing, it is *not producible*. A reader there must say which, because
 * "nobody has talked about this player" and "this machine cannot see the
 * conversation" lead to opposite actions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-absent-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
// No corpus at this path, which is the deployed box's normal state.
process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'no-such-league_chat.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const archetypes = await import('../server/services/manager-archetypes.js');
const bluff = await import('../server/services/bluff-detector.js');
const chatSync = await import('../server/services/league-chat-sync.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- finding 1

test('every draft metric the build writes is either named by a consumer or declared run-sheet only', () => {
  const declared = archetypes.RUN_SHEET_ONLY_METRICS;
  assert.ok(Array.isArray(declared), 'the file has to state which of its metrics no served surface reads');
  assert.ok(declared.includes('capital_hhi'),
    'capital_hhi is read only by metricRepeatability, which only the build script calls');
});

test('the run-sheet-only list cannot rot: every entry says why, and none is secretly read', () => {
  for (const metric of archetypes.RUN_SHEET_ONLY_METRICS) {
    const why = archetypes.RUN_SHEET_ONLY_REASON[metric];
    assert.ok(why && why.length > 20,
      `${metric} is declared unread with no reason, which is the same silence the declaration exists to break`);
  }
  assert.equal(Object.keys(archetypes.RUN_SHEET_ONLY_REASON).length, archetypes.RUN_SHEET_ONLY_METRICS.length,
    'a reason for a metric not on the list, or a metric with no reason, means the two drifted');
});

test('the archetype tables say why nothing schedules them, not just that nothing does', () => {
  assert.match(archetypes.ARCHETYPE_BUILDER, /by hand/);
  assert.ok(archetypes.WHY_UNSCHEDULED && archetypes.WHY_UNSCHEDULED.length > 40,
    '"never scheduled" is a finding until the reason is written down, then it is a decision');
  assert.match(archetypes.WHY_UNSCHEDULED, /gateway|Jev/,
    'the real reason is the Jev pass calling a paid gateway, and it should be the stated one');
});

// ---------------------------------------------------------------- finding 2

test('with no chat corpus the credibility read says it cannot see one, not that nobody spoke', () => {
  const out = bluff.declarationCredibility();
  assert.equal(out.available, false);
  assert.equal(out.events.length, 0);
  assert.ok(out.reason, 'an empty result with no reason reads as "he has never called anyone untouchable"');
  assert.match(out.reason, /Mac|Apple Messages|not on this machine/,
    'the reason has to say the corpus is not producible here, not merely that a file is missing');
  assert.match(out.reason, /no-such-league_chat\.sqlite/,
    'naming the path it looked at is what makes the state checkable');
});

// ---------------------------------------------------------------- finding 3

test('the corpus status names where it looked, even when there is nothing there', () => {
  const s = chatSync.status();
  assert.equal(s.corpus, null, 'fixture sanity: no corpus at this path');
  assert.ok(s.path, 'the path was assembled and dropped; with no corpus it is the only fact there is');
  assert.match(s.path, /no-such-league_chat\.sqlite/);
});

test('the absent note says the corpus is Mac-only, so nobody goes looking for a server job', () => {
  const f = chatSync.freshness(null, null);
  assert.equal(f.state, 'absent');
  assert.match(f.note, /Mac|Apple Messages/,
    'without this a reader assumes a sync is broken rather than that this box cannot produce the file');
});
