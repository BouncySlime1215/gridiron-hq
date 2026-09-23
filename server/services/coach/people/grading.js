/**
 * Does a person variable measure the person, or the week it was measured in?
 *
 * Forty variables ship `priceable: false`, and this is the thing that may
 * change that. Nothing else may. The rule is `manager-signals.js:73-76`'s and
 * it is applied here for the same reason it was applied there: every draft
 * metric that file tried failed its repeatability test, and the reason none of
 * them is in the app is that somebody checked.
 *
 * WHAT IS ACTUALLY BEING MEASURED, because the honest answer is narrower than
 * "is this variable any good".
 *
 * There are no labels. Nothing in this database says whether a trade was
 * accepted because the counterparty replies quickly, and manufacturing a label
 * would be exactly the invention the whole Coach rebuild exists to remove. So
 * this does not test prediction. It tests REPEATABILITY:
 *
 *   split each person's chain in time; measure the variable on the early part;
 *   ask whether that predicts the same variable measured on the late part,
 *   across people, better than simply guessing the population average.
 *
 * A variable that cannot do that is not describing a person. It is describing
 * a fortnight, and a price built on it would be a price built on noise. A
 * variable that can do it has earned only one thing — the right to be called
 * a property of that person — and predicting a trade from it is still a
 * further claim nobody has tested.
 *
 * TWO NUMBERS, both reported, and a variable needs both.
 *
 *   skill    1 − MSE(early → late) / MSE(population mean → late).
 *            Above zero means knowing this person's early value beats knowing
 *            nothing about him. At or below zero the population average is the
 *            better guess and the variable has told you nothing.
 *   spearman rank correlation between early and late across people. Skill can
 *            be dragged positive by one extreme person; rank cannot. It asks
 *            the question a human actually has: do people keep their order?
 *
 * THE SPLIT IS ON TIME, NOT ON MESSAGE COUNT. A split by count puts a chatty
 * person's early half months after a quiet person's, and then the two halves
 * are not comparable between people — half the signal would be the calendar.
 * One cut, the same date for everyone, at `GRADE_SPLIT` of the corpus's own
 * span.
 *
 * WHAT CANNOT BE GRADED THIS WAY, said rather than quietly failed. The
 * thirteen variables read from `manager_chat_profile` are one row per person
 * for the whole chain; there is no early half of them to split off. They come
 * back `not_gradeable` with that reason. Calling them failures would retire
 * thirteen working variables for a property of the storage, which is the kind
 * of wrong that looks rigorous.
 */
import { DatabaseSync } from 'node:sqlite';
import { run, rows } from '../../../db/index.js';
import { personVariables } from './variables.js';

/** Where the single time cut falls, as a fraction of the corpus's own span. */
export const GRADE_SPLIT = 0.7;

/**
 * Below this many people with a value in both halves, a skill score is noise
 * about noise. Eight is the number of managers in the smallest league here
 * that anyone actually trades in; it is a floor, not a sufficiency.
 */
export const GRADE_MIN_PEOPLE = 8;

/** Rank agreement a variable has to reach. Below this, people do not keep their order. */
export const GRADE_MIN_SPEARMAN = 0.5;

export const VERDICTS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  NOT_ENOUGH_DATA: 'not_enough_data',
  NOT_GRADEABLE: 'not_gradeable'
});

const SELF = 'ME';

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Ranks with ties averaged, so a run of equal values does not invent an order. */
function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k][1]] = shared;
    i = j + 1;
  }
  return out;
}

function pearson(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  // No spread on one side means the coefficient is undefined, not zero.
  return dx === 0 || dy === 0 ? null : num / Math.sqrt(dx * dy);
}

const spearman = (xs, ys) => pearson(ranks(xs), ranks(ys));

/** Everyone who has said anything, Nick excluded. */
function peopleIn(corpus) {
  return corpus.prepare(
    `SELECT name FROM messages WHERE name IS NOT NULL AND name <> ?
     GROUP BY name ORDER BY name`).all(SELF).map(r => r.name);
}

/**
 * A corpus holding only the messages inside a time window.
 *
 * Built in memory and handed to `personVariables` unchanged, deliberately: the
 * alternative is a window parameter threaded through the measurement code,
 * which would mean the thing being graded is not quite the thing that ships.
 * `manager_chat_profile` is left out on purpose — see the header.
 */
function windowed(corpus, { from, to }) {
  const slice = new DatabaseSync(':memory:');
  slice.exec(`CREATE TABLE messages (msg_id INTEGER PRIMARY KEY, name TEXT, chat_kind TEXT,
    chat_name TEXT, ts_utc TEXT, text TEXT)`);
  slice.exec(`CREATE TABLE jev_chat_signals (msg_id INTEGER, question TEXT, probability REAL)`);

  const messages = corpus.prepare(
    `SELECT msg_id, name, chat_kind, chat_name, ts_utc, text FROM messages
     WHERE ts_utc >= ? AND ts_utc < ? ORDER BY ts_utc`).all(from, to);
  const insert = slice.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?)`);
  const ids = [];
  for (const m of messages) {
    insert.run(m.msg_id, m.name, m.chat_kind, m.chat_name, m.ts_utc, m.text);
    ids.push(m.msg_id);
  }

  if (ids.length) {
    const signals = corpus.prepare(
      `SELECT msg_id, question, probability FROM jev_chat_signals
       WHERE msg_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const insertSignal = slice.prepare(`INSERT INTO jev_chat_signals VALUES (?,?,?)`);
    for (const s of signals) insertSignal.run(s.msg_id, s.question, s.probability);
  }
  return slice;
}

/** ISO stamp `fraction` of the way through the corpus's own span. */
function splitAt(corpus, fraction) {
  const span = corpus.prepare(`SELECT MIN(ts_utc) AS lo, MAX(ts_utc) AS hi FROM messages`).get();
  if (!span?.lo || !span?.hi) return null;
  const lo = Date.parse(span.lo);
  const hi = Date.parse(span.hi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  return new Date(lo + (hi - lo) * fraction).toISOString();
}

/** Every variable's value for one person in one half, keyed by id. */
function valuesFor(slice, people) {
  const out = new Map();
  for (const person of people) {
    const byId = {};
    for (const v of personVariables(person, { corpus: slice })) byId[v.id] = v;
    out.set(person, byId);
  }
  return out;
}

/**
 * Grade every variable that can be graded.
 *
 * @param {{corpus: DatabaseSync, minPeople?: number, split?: number}} args
 *   `corpus` is an open handle. It is not closed here; the caller owns it.
 * @returns {{graded: object[], passed: string[], failed: string[],
 *   split: number, split_at: string|null, people: number}}
 */
export function gradeVariables({ corpus, minPeople = GRADE_MIN_PEOPLE, split = GRADE_SPLIT } = {}) {
  if (!corpus) throw new Error('grading needs an open corpus; there is nothing to grade without one');

  const people = peopleIn(corpus);
  const cut = splitAt(corpus, split);
  const shape = personVariables('nobody at all', { corpus });

  const empty = () => ({
    graded: shape.map(v => ({
      id: v.id, name: v.name, family: v.family, source: v.source,
      n_people: 0, skill: null, spearman: null, mae: null,
      verdict: VERDICTS.NOT_ENOUGH_DATA,
      reason: `the corpus has no usable span to split, so no variable rests on any people`
    })),
    passed: [], failed: [], split, split_at: cut, people: people.length
  });
  if (!cut || !people.length) return empty();

  const early = windowed(corpus, { from: '', to: cut });
  const late = windowed(corpus, { from: cut, to: '9999' });
  const earlyValues = valuesFor(early, people);
  const lateValues = valuesFor(late, people);
  early.close();
  late.close();

  const graded = [];
  for (const spec of shape) {
    // Read from the whole chain and unsplittable. Said, not failed.
    if (spec.source === 'extractor') {
      graded.push({ id: spec.id, name: spec.name, family: spec.family, source: spec.source,
        n_people: 0, skill: null, spearman: null, mae: null, verdict: VERDICTS.NOT_GRADEABLE,
        reason: 'read from manager_chat_profile, which the extractor writes once per person for '
          + 'the whole chain, so there is no early half of it to split off. Ungradeable by this '
          + 'method rather than failing it.' });
      continue;
    }

    const pairs = [];
    for (const person of people) {
      const a = earlyValues.get(person)?.[spec.id];
      const b = lateValues.get(person)?.[spec.id];
      // A null is already the sample floor doing its job: personVariables
      // withholds below MIN_N rather than returning a number, so skipping
      // nulls skips thin halves. A second explicit `a.n < MIN_N` check here
      // was redundant — nothing could make it fire that had not already been
      // caught — and a guard that cannot fail is a guard nobody can test.
      if (a?.value == null || b?.value == null) continue;
      pairs.push([a.value, b.value]);
    }

    const base = {
      id: spec.id, name: spec.name, family: spec.family, source: spec.source,
      n_people: pairs.length
    };

    if (pairs.length < minPeople) {
      graded.push({ ...base, skill: null, spearman: null, mae: null,
        verdict: VERDICTS.NOT_ENOUGH_DATA,
        reason: `${pairs.length} people have a value in both halves; grading needs ${minPeople}. `
          + 'Not a failure — nothing has been measured about it either way.' });
      continue;
    }

    const xs = pairs.map(p => p[0]);
    const ys = pairs.map(p => p[1]);
    const mseModel = mean(pairs.map(([a, b]) => (a - b) ** 2));
    const populationMean = mean(ys);
    const mseBase = mean(ys.map(b => (b - populationMean) ** 2));
    const mae = mean(pairs.map(([a, b]) => Math.abs(a - b)));

    if (mseBase === 0) {
      graded.push({ ...base, skill: null, spearman: null, mae,
        verdict: VERDICTS.NOT_ENOUGH_DATA,
        reason: 'every person has the same late value, so there is nothing for the variable to '
          + 'tell apart and no skill score can be computed.' });
      continue;
    }

    const skill = 1 - mseModel / mseBase;
    const rank = spearman(xs, ys);
    const passes = skill > 0 && rank !== null && rank >= GRADE_MIN_SPEARMAN;
    const round = v => (v === null ? null : +v.toFixed(4));

    graded.push({ ...base, skill: round(skill), spearman: round(rank), mae: round(mae),
      verdict: passes ? VERDICTS.PASS : VERDICTS.FAIL,
      reason: passes
        ? `the early half predicts the late half across ${pairs.length} people better than the `
          + `population average (skill ${round(skill)}) and people keep their order `
          + `(rank ${round(rank)}). It is a property of the person.`
        : skill <= 0
          ? `guessing the population average beats this person's own early value `
            + `(skill ${round(skill)}), so it is measuring the period rather than the person.`
          : `it beats the average on size (skill ${round(skill)}) but people do not keep their `
            + `order between halves (rank ${rank === null ? 'undefined' : round(rank)}, `
            + `needs ${GRADE_MIN_SPEARMAN}), so a comparison between two people would not hold.` });
  }

  return {
    graded,
    passed: graded.filter(g => g.verdict === VERDICTS.PASS).map(g => g.id),
    failed: graded.filter(g => g.verdict === VERDICTS.FAIL).map(g => g.id),
    split, split_at: cut, people: people.length
  };
}

/**
 * Write the grades into the stored profiles: a pass makes that variable
 * priceable, everything else makes it not.
 *
 * Deliberately a separate call. Grading tells you something; acting on it is a
 * decision, and running the harness should never quietly change what the rest
 * of the platform is allowed to price.
 */
export function applyGrades(report) {
  if (!report?.graded?.length) throw new Error('applyGrades needs a report from gradeVariables');
  const exists = rows(`SELECT name FROM sqlite_master WHERE type='table' AND name='coach_person_variables'`);
  if (!exists.length) {
    throw new Error('coach_person_variables does not exist yet — run scripts/build-person-profiles.mjs --write first');
  }

  // Everything drops to not-priceable first, so a variable that used to pass
  // and now fails cannot keep a price on last week's grade.
  run(`UPDATE coach_person_variables SET priceable = 0`);
  for (const id of report.passed) {
    run(`UPDATE coach_person_variables SET priceable = 1 WHERE variable = ?`, id);
  }
  const after = rows(`SELECT COUNT(*) AS n FROM coach_person_variables WHERE priceable = 1`)[0];
  return { priceable: after?.n ?? 0, passed: report.passed.length, failed: report.failed.length };
}
