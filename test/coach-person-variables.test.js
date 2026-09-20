/**
 * The counted half of a person profile.
 *
 * Nick asked for people "scored on TONNSSS of physiology variables to create
 * an aggregate of who this person is", read from the entire chain. The
 * builder that exists today reads at most 160 trade-flagged messages
 * (build-negotiation-profiles.mjs:45) and returns prose. This reads every
 * message and returns numbers, each with the sample size it rests on.
 *
 * Three properties matter more than the variables themselves:
 *
 *  - A thin variable is WITHHELD, not reported as zero. A reply latency from
 *    two observations and one from two hundred must not look alike, and the
 *    zero that a naive count returns is the most confident-looking wrong
 *    number there is. This is the discipline manager-signals.js already
 *    applies to tx_accept_rate and it is applied here to everything.
 *  - Nothing is priceable until it has been graded. Every variable ships
 *    `priceable: false` and only the grading harness may flip it, the same
 *    way no draft metric survived its repeatability test
 *    (manager-signals.js:73-76).
 *  - A variable the extractor already computes is READ, never recomputed.
 *    Two implementations of "night share" would eventually disagree and
 *    nobody would know which screen was right.
 *
 * The corpus here is a fixture with invented people. The real one is on
 * Nick's machine and is not read from anywhere but there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-vars-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const CHAT = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT;

await import('../server/db/index.js');
const { seedPersonContext, addPersonContext } =
  await import('../server/services/coach/people/context.js');
const { personVariables, VARIABLE_FAMILIES, NOT_COMPUTED, MIN_N } =
  await import('../server/services/coach/people/variables.js');

/* ---- the fixture: two people with properties chosen to be checkable by hand ---- */
const chat = new DatabaseSync(CHAT);
chat.exec(`CREATE TABLE messages (msg_id INTEGER PRIMARY KEY, name TEXT, chat_kind TEXT,
  chat_name TEXT, ts_utc TEXT, text TEXT)`);
chat.exec(`CREATE TABLE jev_chat_signals (msg_id INTEGER, question TEXT, probability REAL)`);
chat.exec(`CREATE TABLE manager_chat_profile (name TEXT PRIMARY KEY, msgs INTEGER, group_msgs INTEGER,
  tapbacks INTEGER, night_share REAL, p_trade_talk REAL, p_trash_talk REAL, confidence_mean REAL,
  p_competitive REAL, p_friendly REAL, p_defensive REAL, p_open_to_trade REAL,
  p_reacting_to_loss REAL, p_own_complaining REAL, p_own_untouchable REAL)`);

let id = 0;
const say = (name, ts, text, kind = 'dm', room = 'dm:quick') =>
  chat.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?)`).run(++id, name, kind, room, ts, text);
const signal = (msgId, question, probability) =>
  chat.prepare(`INSERT INTO jev_chat_signals VALUES (?,?,?)`).run(msgId, question, probability);

// Quick replies to Nick, ten of them, each exactly two minutes after his message.
for (let i = 0; i < 10; i++) {
  const hour = String(10 + i).padStart(2, '0');
  say('ME', `2026-09-01T${hour}:00:00Z`, 'you around?');
  say('Quick', `2026-09-01T${hour}:02:00Z`, 'yeah whats up');
}
// Style: one shouted message, one hedged, one question, one very long.
say('Quick', '2026-09-02T10:00:00Z', 'THAT WAS INSANE');
say('Quick', '2026-09-02T10:01:00Z', 'i think maybe we hold him? not sure');
say('Quick', '2026-09-02T10:02:00Z', 'what do you want for him');
say('Quick', '2026-09-02T10:03:00Z', `here is my thinking. ${'x'.repeat(250)}`);
// One group message, so the group/dm split is not degenerate.
say('Quick', '2026-09-02T11:00:00Z', 'hey all', 'group', 'group:league');

// A second person with only three messages: too thin for anything to be reported.
say('Thin', '2026-09-03T10:00:00Z', 'hi');
say('Thin', '2026-09-03T10:05:00Z', 'ok');
say('Thin', '2026-09-03T10:06:00Z', 'sure');

// Signals: two of Quick's messages are non-fantasy, one is trade talk.
signal(21, 'topic.non_fantasy', 0.9);
signal(22, 'topic.non_fantasy', 0.8);
signal(23, 'topic.argmax:trade_talk', 0.7);
for (const [msgId, value] of [[21, 0.9], [22, 0.2], [23, 0.5], [24, 0.4]]) {
  signal(msgId, 'confidence.mean', value);
}

chat.prepare(`INSERT INTO manager_chat_profile VALUES
  ('Quick', 15, 1, 4, 0.2, 0.3, 0.1, 0.55, 0.4, 0.5, 0.1, 0.35, 0.2, 0.15, 0.05)`).run();
chat.close();

const varsFor = person => {
  const list = personVariables(person);
  return Object.fromEntries(list.map(v => [v.id, v]));
};

test('a person with real volume gets variables, each with its own sample size', () => {
  const v = varsFor('Quick');
  assert.ok(Object.keys(v).length >= 25, `only ${Object.keys(v).length} variables`);
  for (const variable of Object.values(v)) {
    assert.ok(variable.name?.trim(), `${variable.id} has no display name`);
    assert.ok(VARIABLE_FAMILIES.includes(variable.family), `${variable.id} family ${variable.family}`);
    assert.ok(['computed', 'extractor', 'signal'].includes(variable.source), `${variable.id} source`);
    assert.ok(Number.isInteger(variable.n), `${variable.id} has no n`);
    assert.equal(variable.priceable, false, `${variable.id} is priceable before it was graded`);
    assert.ok(variable.measured_by?.length > 20, `${variable.id} does not say how it was measured`);
  }
});

test('reply latency is the real median of the real gaps', () => {
  const v = varsFor('Quick');
  assert.equal(v.reply_latency_p50.value, 2, 'ten replies, each two minutes after Nick');
  assert.equal(v.reply_latency_p50.unit, 'minutes');
  assert.equal(v.reply_latency_p50.n, 10);
});

test('a thin variable is withheld, not reported as zero', () => {
  const thin = varsFor('Thin');
  const latency = thin.reply_latency_p50;
  assert.ok(latency, 'the variable is still listed');
  assert.equal(latency.value, null, 'a value from too few observations must be withheld');
  assert.ok(latency.n < MIN_N);
  assert.match(latency.withheld, /sample|observations|too few/i);
  // And the zero-looking trap specifically: nothing reports 0 here.
  for (const variable of Object.values(thin)) {
    if (variable.n < MIN_N) assert.equal(variable.value, null, `${variable.id} reported on n=${variable.n}`);
  }
});

test('style variables count what they say they count', () => {
  const v = varsFor('Quick');
  assert.equal(v.all_caps_rate.n, 16);
  assert.equal(v.all_caps_rate.value, 1 / 16);
  assert.equal(v.hedge_rate.value, 1 / 16, '"i think maybe ... not sure" is one hedged message');
  assert.equal(v.question_rate.value, 2 / 16, 'two messages end in a question mark');
  assert.equal(v.long_message_rate.value, 1 / 16);
});

test('the extractor’s own aggregates are read, not recomputed', () => {
  const v = varsFor('Quick');
  assert.equal(v.night_share.source, 'extractor');
  assert.equal(v.night_share.value, 0.2);
  assert.equal(v.confidence_mean.source, 'extractor');
  assert.equal(v.confidence_mean.value, 0.55);
  assert.match(v.night_share.measured_by, /manager_chat_profile/);
});

test('confidence volatility is computed, because the extractor only keeps the mean', () => {
  const v = varsFor('Quick');
  assert.equal(v.confidence_volatility.source, 'computed');
  assert.ok(v.confidence_volatility.value > 0, 'the fixture confidences are not all equal');
});

test('the non-fantasy share comes from the signal the extractor already writes', () => {
  const v = varsFor('Quick');
  assert.equal(v.non_fantasy_share.source, 'signal');
  assert.equal(v.non_fantasy_share.value, 2 / 16);
});

test("a person's context rules are counted, so a profile can say how much is being reinterpreted", () => {
  seedPersonContext();
  addPersonContext({ person: 'Quick', scope: 'pronoun',
    rule: '"we" is his softball team', applies_when: 'we', author: 'Nick Matta' });
  const v = varsFor('Quick');
  assert.equal(v.context_rule_hits.value, 1, 'one message contains a standalone "we"');
  assert.equal(v.context_rules.value, 1);
});

test('a variable we cannot compute is named, with what is missing', () => {
  assert.ok(NOT_COMPUTED.length >= 3);
  for (const missing of NOT_COMPUTED) {
    assert.ok(missing.id && missing.name, 'an unnamed gap');
    assert.ok(missing.needs?.length > 25, `${missing.id} does not say what is missing`);
  }
  const concession = NOT_COMPUTED.find(m => m.id === 'concession_after_counter');
  assert.ok(concession, 'the ladder variable the playbook depends on is not recorded as a gap');
  assert.match(concession.needs, /proposal|4e|join/i);
});

test('an unknown person is empty, not invented', () => {
  assert.deepEqual(personVariables('Nobody At All').filter(v => v.value !== null), []);
});

test('nothing in a profile carries a message, so a derived profile can leave the machine', () => {
  const list = personVariables('Quick');
  const json = JSON.stringify(list);
  assert.equal(json.includes('whats up'), false);
  assert.equal(json.includes('INSANE'), false);
  assert.equal(json.includes('x'.repeat(50)), false);
});
