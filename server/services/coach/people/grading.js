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
 * TWO VERDICTS, since COACH-01a (RL-18-3). `repeatable` is the test above,
 * unchanged (`verdict` still carries it, for older readers). `predictive` asks
 * the further question: does the variable map to a tell the TELLS-01a screen
 * graded against real outcomes (adds, checkout, trades), with enough support?
 * It is `pass`, `fail` or `untestable`. No chat variable maps to a tell — ten
 * people and 37 decisions cannot grade one — so all of them are `untestable`:
 * unproven, which is not the same as predicting nothing. A variable is
 * priceable only when BOTH pass.
 *
 * A column that does not change with the window is refused (`CONSTANT_IN_TIME`).
 * It would repeat perfectly between halves while measuring nothing about time.
 *
 * WHAT CANNOT BE GRADED THIS WAY, said rather than quietly failed. The
 * thirteen variables read from `manager_chat_profile` are one row per person
 * for the whole chain; there is no early half of them to split off. They come
 * back `not_gradeable` with that reason. Calling them failures would retire
 * thirteen working variables for a property of the storage, which is the kind
 * of wrong that looks rigorous.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** The outcome-side verdict. `untestable` means unproven, never "predicts nothing". */
export const PREDICTIVE = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  UNTESTABLE: 'untestable'
});

/**
 * A confirmed tell must rest on at least this many distinct non-zero chains —
 * the TELLS-01a screen's own support floor (`rules.support_chains`), so the
 * gate cannot price on less than the screen itself would confirm on.
 */
export const PREDICTIVE_MIN_SUPPORT = 30;

/**
 * Columns whose value does not come from the window being graded. Each would
 * land the same number in both halves and "repeat" perfectly.
 */
export const CONSTANT_IN_TIME = Object.freeze({
  context_rules: 'counts rows in coach_person_context, which is the same whichever window is read, '
    + 'so it is constant in time: it does not change with the window and cannot be graded by '
    + 'splitting one.'
});

/**
 * Chat variable -> TELLS-01a tell id. Empty on purpose: no chat variable has an
 * outcome-graded counterpart, because outcome grading needs the ESPN and
 * Sleeper streams, not ten people's messages. A row here is a claim that the
 * two measure the same thing, and it needs its own evidence.
 */
export const TELL_FOR_VARIABLE = Object.freeze({});

const SCREEN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/tells-screen.json');

/** The committed TELLS-01a screen. A missing or unreadable one throws: no silent "no evidence". */
export function loadTellsScreen(file = SCREEN_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

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

const round4 = v => (v === null ? null : +v.toFixed(4));

/**
 * The repeatability test on (early, late) pairs, one pair per person. Shared
 * with the population rerun (gate-rerun.js) so the gate being audited there is
 * this exact code, not a copy of it.
 *
 * @returns {{verdict: string, n_people: number, skill: number|null,
 *   spearman: number|null, mae: number|null, reason: string}}
 */
export function repeatability(pairs, { minPeople = GRADE_MIN_PEOPLE, minSpearman = GRADE_MIN_SPEARMAN } = {}) {
  const n = pairs.length;
  if (n < minPeople) {
    return { verdict: VERDICTS.NOT_ENOUGH_DATA, n_people: n, skill: null, spearman: null, mae: null,
      reason: `${n} people have a value in both halves; grading needs ${minPeople}. `
        + 'Not a failure — nothing has been measured about it either way.' };
  }
  const xs = pairs.map(p => p[0]);
  const ys = pairs.map(p => p[1]);
  const mseModel = mean(pairs.map(([a, b]) => (a - b) ** 2));
  const populationMean = mean(ys);
  const mseBase = mean(ys.map(b => (b - populationMean) ** 2));
  const mae = mean(pairs.map(([a, b]) => Math.abs(a - b)));

  if (mseBase === 0) {
    return { verdict: VERDICTS.NOT_ENOUGH_DATA, n_people: n, skill: null, spearman: null, mae,
      reason: 'every person has the same late value, so there is nothing for the variable to '
        + 'tell apart and no skill score can be computed.' };
  }

  const skill = 1 - mseModel / mseBase;
  const rank = spearman(xs, ys);
  const passes = skill > 0 && rank !== null && rank >= minSpearman;
  return { n_people: n, skill: round4(skill), spearman: round4(rank), mae: round4(mae),
    verdict: passes ? VERDICTS.PASS : VERDICTS.FAIL,
    reason: passes
      ? `the early half predicts the late half across ${n} people better than the `
        + `population average (skill ${round4(skill)}) and people keep their order `
        + `(rank ${round4(rank)}). It is a property of the person.`
      : skill <= 0
        ? `guessing the population average beats this person's own early value `
          + `(skill ${round4(skill)}), so it is measuring the period rather than the person.`
        : `it beats the average on size (skill ${round4(skill)}) but people do not keep their `
          + `order between halves (rank ${rank === null ? 'undefined' : round4(rank)}, `
          + `needs ${minSpearman}), so a comparison between two people would not hold.` };
}

/**
 * The outcome-side verdict for one variable, from the TELLS-01a screen.
 * Pass needs a `confirmed` tell with support at or over the floor; a tell the
 * screen killed is a fail with the screen's reason; anything else is untestable.
 */
export function predictiveVerdict(variableId, { screen, tellMap = TELL_FOR_VARIABLE,
  minSupport = PREDICTIVE_MIN_SUPPORT } = {}) {
  const tellId = tellMap[variableId];
  if (!tellId) {
    return { predictive: PREDICTIVE.UNTESTABLE, tell: null,
      predictive_reason: 'no tell in the TELLS-01a screen measures this variable, so no outcome '
        + '(adds, checkout, trades) has graded it. Unproven, not disproven: chat variables rest on '
        + 'ten people and 37 decisions, too few to grade against outcomes.' };
  }
  const rowsFor = (screen?.tells ?? []).filter(t => t.id === tellId);
  if (!rowsFor.length) {
    return { predictive: PREDICTIVE.UNTESTABLE, tell: tellId,
      predictive_reason: `mapped to ${tellId}, which the screen does not list, so no outcome has graded it.` };
  }
  const confirmed = rowsFor.filter(t => t.verdict === 'confirmed');
  const supported = confirmed.filter(t => (t.support_chains ?? 0) >= minSupport);
  if (supported.length) {
    const outcomes = supported.map(t => t.outcome).join(', ');
    return { predictive: PREDICTIVE.PASS, tell: tellId,
      predictive_reason: `${tellId} is confirmed out of sample for ${outcomes} with support `
        + `${Math.min(...supported.map(t => t.support_chains))} chains (floor ${minSupport}).` };
  }
  if (confirmed.length) {
    return { predictive: PREDICTIVE.UNTESTABLE, tell: tellId,
      predictive_reason: `${tellId} is confirmed but rests on ${Math.max(...confirmed.map(t => t.support_chains ?? 0))} `
        + `chains, under the support floor of ${minSupport}; too thin to price on.` };
  }
  const reasons = [...new Set(rowsFor.map(t => t.dead_reason ?? t.verdict))].join(', ');
  return { predictive: PREDICTIVE.FAIL, tell: tellId,
    predictive_reason: `${tellId} did not survive the screen (${reasons}) for any outcome it was `
      + 'graded on: no replicated signal for those outcomes in that test.' };
}

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

/**
 * ISO stamp `fraction` of the way through the corpus's own span, and the
 * corpus's message count (so the windows can be checked to cover it once).
 */
function splitAt(corpus, fraction) {
  const span = corpus.prepare(`SELECT MIN(ts_utc) AS lo, MAX(ts_utc) AS hi, COUNT(*) AS n FROM messages`).get();
  const total = span?.n ?? 0;
  if (!span?.lo || !span?.hi) return { cut: null, total };
  const lo = Date.parse(span.lo);
  const hi = Date.parse(span.hi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return { cut: null, total };
  return { cut: new Date(lo + (hi - lo) * fraction).toISOString(), total };
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

/** How many messages each half holds, and how many land in both (must be none). */
function windowCounts(total, early, late) {
  const ids = slice => new Set(slice.prepare(`SELECT msg_id FROM messages`).all().map(r => r.msg_id));
  const a = ids(early);
  const b = ids(late);
  let shared = 0;
  for (const id of a) if (b.has(id)) shared += 1;
  return { early: a.size, late: b.size, shared, total };
}

const PREDICTIVE_SUMMARY = 'Predictive: every chat variable is untestable against outcomes '
  + '(ten people, 37 decisions), so none is priceable. That makes them unproven, not useless; '
  + 'outcome grading happens on the ESPN and Sleeper streams (TELLS-01a).';

/**
 * Grade every variable that can be graded.
 *
 * @param {{corpus: DatabaseSync, minPeople?: number, split?: number,
 *   screen?: object, tellMap?: object}} args
 *   `corpus` is an open handle. It is not closed here; the caller owns it.
 *   `screen` defaults to the committed TELLS-01a screen; `tellMap` to
 *   `TELL_FOR_VARIABLE`. Both are injectable for fixtures.
 * @returns {{graded: object[], passed: string[], failed: string[], priceable: string[],
 *   split: number, split_at: string|null, people: number, windows: object|null,
 *   predictive_summary: string}}
 *   `passed`/`failed` are the repeatable verdict; `priceable` needs both.
 */
export function gradeVariables({ corpus, minPeople = GRADE_MIN_PEOPLE, split = GRADE_SPLIT,
  screen, tellMap = TELL_FOR_VARIABLE } = {}) {
  if (!corpus) throw new Error('grading needs an open corpus; there is nothing to grade without one');

  const people = peopleIn(corpus);
  const { cut, total } = splitAt(corpus, split);
  const shape = personVariables('nobody at all', { corpus });
  const tellsScreen = screen ?? loadTellsScreen();

  const withPredictive = grade => {
    const outcome = predictiveVerdict(grade.id, { screen: tellsScreen, tellMap });
    return { ...grade, repeatable: grade.verdict, ...outcome };
  };
  const finish = (graded, windows) => {
    const passed = graded.filter(g => g.repeatable === VERDICTS.PASS).map(g => g.id);
    return {
      graded,
      passed,
      failed: graded.filter(g => g.repeatable === VERDICTS.FAIL).map(g => g.id),
      priceable: graded.filter(g => g.repeatable === VERDICTS.PASS && g.predictive === PREDICTIVE.PASS)
        .map(g => g.id),
      split, split_at: cut, people: people.length, windows,
      predictive_summary: tellMap === TELL_FOR_VARIABLE && !Object.keys(tellMap).length
        ? PREDICTIVE_SUMMARY
        : `Predictive: ${graded.filter(g => g.predictive === PREDICTIVE.PASS).length} of `
          + `${graded.length} variables pass against outcomes; the rest are failed or unproven.`
    };
  };

  if (!cut || !people.length) {
    return finish(shape.map(v => withPredictive({
      id: v.id, name: v.name, family: v.family, source: v.source,
      n_people: 0, skill: null, spearman: null, mae: null,
      verdict: VERDICTS.NOT_ENOUGH_DATA,
      reason: `the corpus has no usable span to split, so no variable rests on any people`
    })), null);
  }

  const early = windowed(corpus, { from: '', to: cut });
  const late = windowed(corpus, { from: cut, to: '9999' });
  const windows = windowCounts(total, early, late);
  const earlyValues = valuesFor(early, people);
  const lateValues = valuesFor(late, people);
  early.close();
  late.close();

  const graded = [];
  for (const spec of shape) {
    const base = { id: spec.id, name: spec.name, family: spec.family, source: spec.source };
    // Read from the whole chain and unsplittable. Said, not failed.
    if (spec.source === 'extractor') {
      graded.push(withPredictive({ ...base,
        n_people: 0, skill: null, spearman: null, mae: null, verdict: VERDICTS.NOT_GRADEABLE,
        reason: 'read from manager_chat_profile, which the extractor writes once per person for '
          + 'the whole chain, so there is no early half of it to split off. Ungradeable by this '
          + 'method rather than failing it.' }));
      continue;
    }
    if (CONSTANT_IN_TIME[spec.id]) {
      graded.push(withPredictive({ ...base,
        n_people: 0, skill: null, spearman: null, mae: null, verdict: VERDICTS.NOT_GRADEABLE,
        reason: CONSTANT_IN_TIME[spec.id] }));
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
    graded.push(withPredictive({ ...base, ...repeatability(pairs, { minPeople }) }));
  }

  return finish(graded, windows);
}

/**
 * Write the grades into the stored profiles: repeatable AND predictive makes
 * a variable priceable, everything else makes it not.
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
  if (!Array.isArray(report.priceable)) {
    throw new Error('applyGrades needs a report with both verdicts; re-run gradeVariables');
  }
  for (const id of report.priceable) {
    run(`UPDATE coach_person_variables SET priceable = 1 WHERE variable = ?`, id);
  }
  const after = rows(`SELECT COUNT(*) AS n FROM coach_person_variables WHERE priceable = 1`)[0];
  return { priceable: after?.n ?? 0, passed: report.passed.length, failed: report.failed.length,
    predictive: report.priceable.length };
}
