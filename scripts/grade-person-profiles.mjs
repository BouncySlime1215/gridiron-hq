#!/usr/bin/env node
/**
 * Grade the person variables, and only then let anything be priced with them.
 *
 * `build-person-profiles.mjs` writes forty numbers per person, every one of
 * them `priceable = 0`. This decides which of them have earned anything more.
 * The first test is repeatability — split the chain in time, measure
 * each variable on the early part, and see whether that predicts the same
 * variable on the late part across people better than guessing the population
 * average. `server/services/coach/people/grading.js` explains why that is the
 * honest question and what it does not answer.
 *
 * Expect failures. `manager-signals.js:73-76` ran the equivalent test on the
 * draft metrics and none of them survived, which is why none of them is in the
 * app. A harness that passes everything has not measured anything.
 *
 * Usage, on the machine with the corpus, after build-person-profiles --write:
 *
 *   node scripts/grade-person-profiles.mjs             # grade and print
 *   node scripts/grade-person-profiles.mjs --apply     # and set priceable
 *
 * `--apply` resets every variable to not-priceable first, so one that passed
 * last month and fails today loses the flag rather than keeping it.
 */
import { openChatDb } from '../server/services/manager-signals.js';
import { gradeVariables, applyGrades, VERDICTS, GRADE_MIN_PEOPLE, GRADE_MIN_SPEARMAN }
  from '../server/services/coach/people/grading.js';

// Two verdicts per variable since COACH-01a: `repeatable` (the split-in-time
// test above) and `predictive` (does it map to a tell the TELLS-01a screen
// graded against adds, checkout and trades). Priceable needs both.


const APPLY = process.argv.includes('--apply');

const corpus = openChatDb();
if (!corpus) {
  console.error(`No chat corpus on this machine.

The corpus is at data/derived/league_chat.sqlite and exists only on Nick's Mac.
Run this where the corpus is.`);
  process.exit(1);
}

const report = gradeVariables({ corpus });
corpus.close();

const pad = (s, w) => String(s).padEnd(w);
const num = v => (v === null || v === undefined ? '—' : v.toFixed(3));
const ORDER = [VERDICTS.PASS, VERDICTS.FAIL, VERDICTS.NOT_ENOUGH_DATA, VERDICTS.NOT_GRADEABLE];

console.log(`\n${report.people} people, split at ${report.split_at} (${report.split} of the span).\n`);
console.log(`${pad('variable', 26)}${pad('repeatable', 18)}${pad('predictive', 12)}${pad('people', 8)}`
  + `${pad('skill', 9)}rank`);
for (const verdict of ORDER) {
  for (const g of report.graded.filter(x => x.repeatable === verdict)) {
    console.log(`${pad(g.id, 26)}${pad(g.repeatable, 18)}${pad(g.predictive, 12)}${pad(g.n_people, 8)}`
      + `${pad(num(g.skill), 9)}${num(g.spearman)}`);
  }
}

console.log(`\nRepeatable: ${report.passed.length} passed, ${report.failed.length} failed.`);
console.log(report.predictive_summary);
console.log(`Priceable (both pass): ${report.priceable.length}.`);
console.log(`A pass needs a positive skill score AND a rank agreement of at least ` +
  `${GRADE_MIN_SPEARMAN},\nover at least ${GRADE_MIN_PEOPLE} people with a value in both halves.`);

if (report.failed.length) {
  console.log('\nFailed, with the reason:');
  for (const g of report.graded.filter(x => x.repeatable === VERDICTS.FAIL)) {
    console.log(`  ${g.id}: ${g.reason}`);
  }
}

if (!APPLY) {
  console.log('\nNothing was applied. Re-run with --apply to set priceable from these grades.');
} else {
  const applied = applyGrades(report);
  console.log(`\nApplied. ${applied.priceable} rows are now priceable, from ` +
    `${applied.predictive} variables passing both tests. Everything else was reset to not priceable.`);
}
