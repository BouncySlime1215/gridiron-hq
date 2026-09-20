/**
 * Grading: does a person variable measure the person, or the noise?
 *
 * Forty variables ship `priceable: false` and the reason is written into
 * every one of them: nothing has checked whether they mean anything. This is
 * the check. Until it passes a variable is a number nobody should price a
 * trade with, and after it fails a variable is a number nobody should price a
 * trade with ever.
 *
 * WHAT IS BEING TESTED, precisely. Not "does reply latency predict whether he
 * accepts a trade" — there are no labels for that and pretending otherwise
 * would be the invention this whole rebuild exists to remove. What is
 * testable today is REPEATABILITY: split a person's chain in time, measure
 * the variable on the early part, and see whether it predicts the same
 * variable measured on the late part, across people, better than simply
 * guessing the population average. A variable that fails that is not
 * measuring the person; it is measuring the week.
 *
 * That is the same test `manager-signals.js:73-76` applied to the draft
 * metrics, which is why no draft metric is in the app: none survived it. The
 * expected outcome here is that some of these forty do not survive either,
 * and the harness is worthless if it cannot say which.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-grading-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'app.sqlite');
const CHAT = path.join(temp, 'chat.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = CHAT;

const { run, rows } = await import('../server/db/index.js');
const { gradeVariables, GRADE_MIN_PEOPLE, GRADE_SPLIT, VERDICTS, applyGrades } =
  await import('../server/services/coach/people/grading.js');

/**
 * A corpus built so the answer is known in advance.
 *
 * Twelve people. Each has a STABLE reply latency — his own, held across the
 * whole chain — and an UNSTABLE shout rate: the person who shouts most early
 * shouts least late, so both halves have real spread between people and the
 * order between them is reversed. A harness worth having passes the first
 * kind and fails the second, and does not need to be told which is which.
 *
 * The reversal matters. An unstable variable where everyone ends up at the
 * same late value is not a failure the harness can see — there is nothing
 * left to tell people apart, and it correctly reports that instead. The
 * failure worth catching is the one where the numbers still look like data.
 */
const chat = new DatabaseSync(CHAT);
chat.exec(`CREATE TABLE messages (msg_id INTEGER PRIMARY KEY, name TEXT, chat_kind TEXT,
  chat_name TEXT, ts_utc TEXT, text TEXT)`);
chat.exec(`CREATE TABLE jev_chat_signals (msg_id INTEGER, question TEXT, probability REAL)`);

let id = 0;
const at = (day, minute) => {
  const base = Date.UTC(2026, 5, day, 12, 0, 0) + minute * 60_000;
  return new Date(base).toISOString().replace('.000', '');
};
const say = (name, ts, text, room) =>
  chat.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?)`).run(++id, name, 'dm', room, ts, text);

const PEOPLE = Array.from({ length: 12 }, (_, i) => ({
  name: `Person ${i + 1}`,
  room: `dm:p${i + 1}`,
  latency: 2 + i * 3            // his own reply time, the same all the way through
}));

const EARLY_DAYS = 21;      // where the 0.7 split falls over a 30-day span
for (const [index, person] of PEOPLE.entries()) {
  for (let m = 0; m < 30; m++) {
    const day = 1 + m;
    say('ME', at(day, 0), 'you around', person.room);
    // Stable: his own latency, both halves. Unstable: person i shouts on i of
    // his 21 early messages and on (11 - i) of his 9 late ones, so the person
    // who shouts most early shouts least late. Real spread in both halves,
    // order reversed between them.
    const shout = m < EARLY_DAYS ? m < index : (m - EARLY_DAYS) < (11 - index);
    say(person.name, at(day, person.latency),
      shout ? 'ABSOLUTELY NOT HAPPENING' : 'sounds alright to me', person.room);
  }
}
// One person with six messages in total: four before the split and two after.
// Neither half of him reaches the sample floor, so he must contribute to no
// pair at all rather than dragging a grade around on two observations.
for (let m = 0; m < 6; m++) {
  const day = 1 + m * 5;
  say('ME', at(day, 0), 'you around', 'dm:sparse');
  say('Sparse', at(day, 40), 'yeah', 'dm:sparse');
}
chat.close();

const corpus = () => new DatabaseSync(CHAT, { readOnly: true });

/**
 * A second corpus for the one case the first cannot make: a variable that
 * beats the population average on SIZE while people do not keep their order.
 * Ten people clustered tightly with their order shuffled between halves, and
 * two far-out people who stay put. The two outliers carry the squared error
 * on their own, so skill looks excellent; the ten underneath it are noise.
 * This is the shape a skill score alone cannot see, and the reason the rank
 * check exists beside it.
 */
const CHAT_OUTLIERS = path.join(temp, 'outliers.sqlite');
const second = new DatabaseSync(CHAT_OUTLIERS);
second.exec(`CREATE TABLE messages (msg_id INTEGER PRIMARY KEY, name TEXT, chat_kind TEXT,
  chat_name TEXT, ts_utc TEXT, text TEXT)`);
second.exec(`CREATE TABLE jev_chat_signals (msg_id INTEGER, question TEXT, probability REAL)`);
let secondId = 0;
const say2 = (name, ts, text, room) =>
  second.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?)`).run(++secondId, name, 'dm', room, ts, text);
for (let i = 0; i < 12; i++) {
  const name = `Outlier ${i + 1}`;
  const room = `dm:o${i + 1}`;
  const anchored = i >= 10;
  for (let m = 0; m < 30; m++) {
    const day = 1 + m;
    const early = m < 21;
    const latency = anchored
      ? (i === 10 ? 90 : 120)                       // far out, and the same in both halves
      : 5 + (early ? (i % 5) : ((i + 2) % 5));      // tight, and shuffled between halves
    say2('ME', at(day, 0), 'you around', room);
    say2(name, at(day, latency), 'ok', room);
  }
}
second.close();
const outlierCorpus = () => new DatabaseSync(CHAT_OUTLIERS, { readOnly: true });

test('grading reports every computed variable, with the people behind each grade', () => {
  const db = corpus();
  const report = gradeVariables({ corpus: db });
  db.close();

  assert.ok(report.graded.length >= 20, `only ${report.graded.length} variables graded`);
  for (const grade of report.graded) {
    assert.ok(grade.id, 'a grade with no variable');
    assert.ok(Object.values(VERDICTS).includes(grade.verdict), `${grade.id} verdict ${grade.verdict}`);
    assert.ok(Number.isInteger(grade.n_people), `${grade.id} does not say how many people it rests on`);
    assert.ok(grade.reason?.length > 15, `${grade.id} does not say why`);
  }
});

test('a variable that is the same in both halves passes', () => {
  const db = corpus();
  const report = gradeVariables({ corpus: db });
  db.close();

  const latency = report.graded.find(g => g.id === 'reply_latency_p50');
  assert.ok(latency, 'reply latency was not graded at all');
  assert.equal(latency.verdict, VERDICTS.PASS, `${latency.reason} (skill ${latency.skill})`);
  assert.ok(latency.skill > 0, 'a passing variable must beat guessing the population average');
  assert.ok(latency.spearman > 0.9, 'twelve people who keep their exact order should rank near 1');
  assert.ok(latency.n_people >= GRADE_MIN_PEOPLE);
});

test('a variable that changes between the halves fails, and is named', () => {
  const db = corpus();
  const report = gradeVariables({ corpus: db });
  db.close();

  const shouting = report.graded.find(g => g.id === 'all_caps_rate');
  assert.ok(shouting, 'the shout rate was not graded');
  assert.equal(shouting.verdict, VERDICTS.FAIL, `${shouting.reason} (skill ${shouting.skill})`);
  assert.ok(report.failed.includes('all_caps_rate'), 'a failure must appear in the failed list by name');
});

test('too few people is "not enough data", never a pass and never a fail', () => {
  const db = corpus();
  const report = gradeVariables({ corpus: db, minPeople: 50 });
  db.close();

  assert.deepEqual(report.passed, [], 'nothing may pass on a sample the harness itself calls too small');
  assert.deepEqual(report.failed, [], 'nothing may fail on a sample the harness itself calls too small');
  // The extractor's own aggregates stay ungradeable whatever the sample is —
  // that verdict is about the storage, not about how many people there are.
  for (const grade of report.graded.filter(g => g.source !== 'extractor')) {
    assert.equal(grade.verdict, VERDICTS.NOT_ENOUGH_DATA, `${grade.id} was judged on too few people`);
    assert.match(grade.reason, /people|sample|tell apart/i);
  }
});

test('the extractor\'s own aggregates are reported as ungradeable, not as failures', () => {
  const db = corpus();
  const report = gradeVariables({ corpus: db });
  db.close();

  // manager_chat_profile holds one row per person for the WHOLE chain, so
  // there is no early half of it to split off. Calling that a failure would
  // retire thirteen working variables for a property of the storage.
  const nightShare = report.graded.find(g => g.id === 'night_share');
  assert.ok(nightShare, 'night share was dropped from the report rather than explained');
  assert.equal(nightShare.verdict, VERDICTS.NOT_GRADEABLE);
  assert.match(nightShare.reason, /whole chain|cannot be split|extractor/i);
  assert.equal(report.failed.includes('night_share'), false);
});

test('the split is on time, not on message count, and the report says where it fell', () => {
  const db = corpus();
  const report = gradeVariables({ corpus: db });
  db.close();
  assert.equal(report.split, GRADE_SPLIT);
  assert.ok(report.split_at, 'the report does not say when the split fell');
  // A split by count would put a chatty person's early half months after a
  // quiet person's, and the two halves would not be comparable across people.
  assert.match(report.split_at, /^\d{4}-\d{2}-\d{2}/);
});

test('only a pass may make a variable priceable, and it is a deliberate second step', () => {
  const db = corpus();
  const report = gradeVariables({ corpus: db });
  db.close();

  run(`CREATE TABLE IF NOT EXISTS coach_person_variables (
    person TEXT NOT NULL, variable TEXT NOT NULL, display_name TEXT NOT NULL,
    family TEXT NOT NULL, source TEXT NOT NULL, unit TEXT, value REAL, n INTEGER NOT NULL,
    withheld TEXT, priceable INTEGER NOT NULL DEFAULT 0, measured_by TEXT NOT NULL,
    built_at TEXT NOT NULL, PRIMARY KEY (person, variable))`);
  for (const variable of ['reply_latency_p50', 'all_caps_rate', 'night_share']) {
    run(`INSERT OR REPLACE INTO coach_person_variables VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`,
      'Person 1', variable, variable, 'style', 'computed', 'x', 1, 10, null, 'fixture', '2026-09-20');
  }

  const applied = applyGrades(report);
  assert.ok(applied.priceable > 0, 'a passing variable was never made priceable');
  const priceable = new Set(rows(`SELECT variable FROM coach_person_variables WHERE priceable = 1`)
    .map(r => r.variable));
  assert.equal(priceable.has('reply_latency_p50'), true);
  assert.equal(priceable.has('all_caps_rate'), false, 'a failed variable was made priceable');
  assert.equal(priceable.has('night_share'), false, 'an ungraded variable was made priceable');
});

test('a person too thin in either half is left out of the grade entirely', () => {
  const db = corpus();
  const report = gradeVariables({ corpus: db });
  db.close();
  const latency = report.graded.find(g => g.id === 'reply_latency_p50');
  // Thirteen people are in the corpus. Sparse has four messages in one half
  // and two in the other, so twelve is the correct number here.
  assert.equal(report.people, 13, 'the fixture changed; this test is counting the wrong thing');
  assert.equal(latency.n_people, 12, 'a person with two observations in a half was graded on them');
});

test('a variable nobody differs on is "not enough data", not a failure', () => {
  const db = corpus();
  const report = gradeVariables({ corpus: db });
  db.close();
  // Every message in the fixture is a one-to-one message, so everyone's dm
  // share is 1 in both halves. There is nothing for the variable to tell
  // apart, which is not the same as the variable being bad, and calling it a
  // failure would retire it on the strength of a fixture with no group chat.
  const dmShare = report.graded.find(g => g.id === 'dm_share');
  assert.ok(dmShare, 'dm share was dropped from the report');
  assert.equal(dmShare.verdict, VERDICTS.NOT_ENOUGH_DATA, dmShare.reason);
  assert.match(dmShare.reason, /tell apart|same late value/i);
  assert.equal(report.failed.includes('dm_share'), false);
});

test('beating the average on size is not enough: people have to keep their order', () => {
  const db = outlierCorpus();
  const report = gradeVariables({ corpus: db });
  db.close();
  const latency = report.graded.find(g => g.id === 'reply_latency_p50');
  assert.ok(latency.skill > 0,
    `the fixture no longer produces a positive skill score (${latency.skill})`);
  assert.ok(latency.spearman < 0.5,
    `the fixture no longer scrambles the order (rank ${latency.spearman})`);
  assert.equal(latency.verdict, VERDICTS.FAIL,
    'two extreme people carried the squared error and the grade went through on it');
  assert.match(latency.reason, /order/i, 'the failure does not say the order is the problem');
});

test('applying a grade takes priceable away as readily as it gives it', () => {
  const db = corpus();
  const report = gradeVariables({ corpus: db });
  db.close();
  // A variable that passed last week and fails this week must not keep last
  // week's price. The apply step resets everything before it sets anything.
  run(`UPDATE coach_person_variables SET priceable = 1`);
  applyGrades(report);
  const stillPriced = rows(
    `SELECT variable FROM coach_person_variables WHERE priceable = 1`).map(r => r.variable);
  assert.equal(stillPriced.includes('all_caps_rate'), false,
    'a variable that failed kept the priceable flag it had before');
  assert.equal(stillPriced.includes('night_share'), false,
    'an ungradeable variable kept the priceable flag it had before');
});

test('the runner prints a grade for every variable and applies nothing by default', () => {
  const env = { ...process.env, GRIDIRON_DB_PATH: process.env.GRIDIRON_DB_PATH,
    GRIDIRON_CHAT_DB_PATH: CHAT };
  const printed = spawnSync(process.execPath, ['scripts/grade-person-profiles.mjs'],
    { encoding: 'utf8', env });
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /reply_latency_p50\s+pass/);
  assert.match(printed.stdout, /all_caps_rate\s+fail/);
  assert.match(printed.stdout, /night_share\s+not_gradeable/);
  assert.match(printed.stdout, /Nothing was applied/);
  // Expect failures in the output. A harness that passes everything has not
  // measured anything, and a run sheet that never prints a failure teaches
  // the reader to stop looking.
  assert.match(printed.stdout, /Failed, with the reason/);
});
