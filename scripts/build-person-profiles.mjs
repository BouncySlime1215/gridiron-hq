#!/usr/bin/env node
/**
 * The counted half of a person profile, built from the real chat corpus.
 *
 * Nick, 2026-09-20: "I want our analysis of these people to be scored on
 * TONNSSS of physiology variables to create an aggregate of who this person
 * is. Read my entire text chain with each person."
 *
 * `build-negotiation-profiles.mjs` is the other half — it asks a model for
 * what a threshold cannot produce, reading at most 160 trade-flagged messages
 * per person. This one reads EVERY message and asks no model anything: it
 * counts, and it writes the count down beside the number. The two are
 * complementary and neither replaces the other.
 *
 * WHY THIS IS A SCRIPT AND NOT A JOB. The corpus lives only on Nick's Mac
 * (`data/derived/league_chat.sqlite`) and never ships anywhere
 * (docs/FANTASY-ENGINE-MASTER-PLAN.md:1098). So this runs where the corpus is,
 * by hand, and what it writes is derived numbers with no message text in them
 * — which is what makes the OUTPUT safe to leave the machine even though the
 * input is not. A test asserts that property
 * (test/coach-person-variables.test.js, "nothing in a profile carries a
 * message").
 *
 * WHAT IT WILL NOT DO. Nothing here becomes a price. Every variable is written
 * with `priceable = 0`, and only a grading harness that has actually measured
 * skill may flip that — the same discipline that left every draft metric out
 * after it failed its repeatability test (manager-signals.js:73-76). A
 * variable measured on fewer than five observations is written with a NULL
 * value and the reason, never as a zero.
 *
 * Usage, in this order, from the repository root on the machine with the
 * corpus:
 *
 *   node scripts/build-person-profiles.mjs               # dry run, prints a table
 *   node scripts/build-person-profiles.mjs --write       # load coach_person_variables
 *   node scripts/build-person-profiles.mjs --person "Josh Smith"   # one person
 *
 * The dry run is the default on purpose: the first thing to look at is whether
 * the numbers are plausible for people Nick knows, and that is a judgement he
 * makes before anything is stored.
 */
import { openChatDb } from '../server/services/manager-signals.js';
import { personVariables, MIN_N, NOT_COMPUTED } from '../server/services/coach/people/variables.js';
import { contextBrief, seedPersonContext } from '../server/services/coach/people/context.js';
import { db, run, rows } from '../server/db/index.js';

const WRITE = process.argv.includes('--write');
const personIdx = process.argv.indexOf('--person');
const ONLY = personIdx > -1 ? process.argv[personIdx + 1] : null;

/**
 * The derived table. Numbers only, and every row carries the sample size and
 * the sentence saying how it was measured, so a screen showing one of these
 * can always say what stands behind it.
 */
function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS coach_person_variables (
    person TEXT NOT NULL,
    variable TEXT NOT NULL,
    display_name TEXT NOT NULL,
    family TEXT NOT NULL,
    source TEXT NOT NULL,
    unit TEXT,
    value REAL,
    n INTEGER NOT NULL,
    withheld TEXT,
    priceable INTEGER NOT NULL DEFAULT 0,
    measured_by TEXT NOT NULL,
    built_at TEXT NOT NULL,
    PRIMARY KEY (person, variable))`);
}

/** Everyone who has said anything, excluding Nick himself. */
function peopleIn(corpus) {
  return corpus.prepare(
    `SELECT name, COUNT(*) AS messages FROM messages
     WHERE name IS NOT NULL AND name <> 'ME' GROUP BY name ORDER BY messages DESC`).all();
}

const corpus = openChatDb();
if (!corpus) {
  console.error(`No chat corpus on this machine.

The corpus is at data/derived/league_chat.sqlite and exists only on Nick's Mac.
This is the expected result anywhere else, and it is not an error to fix by
pointing the script somewhere: run it where the corpus is.`);
  process.exit(1);
}

const people = peopleIn(corpus).filter(p => !ONLY || p.name === ONLY);
if (!people.length) {
  console.error(ONLY ? `No messages from ${JSON.stringify(ONLY)} in the corpus.` : 'The corpus has no messages.');
  process.exit(1);
}

// The rules Nick has already stated about people (context.js) change what their words
// mean, so a write starts from them; idempotent. Negotiation mode's follow-up clock
// reads these variables live (warroom-negotiate.js), which is what made this seed need a caller.
if (WRITE) { ensureTable(); seedPersonContext(); }
const builtAt = new Date().toISOString();
let written = 0;
const summary = [];

for (const person of people) {
  const variables = personVariables(person.name, { corpus });
  const reported = variables.filter(v => v.value !== null);
  const withheld = variables.length - reported.length;
  summary.push({ person: person.name, messages: person.messages,
    reported: reported.length, withheld, rules: contextBrief(person.name) ? 'yes' : '' });

  if (!WRITE) continue;
  for (const v of variables) {
    run(`INSERT OR REPLACE INTO coach_person_variables
         (person, variable, display_name, family, source, unit, value, n, withheld, priceable, measured_by, built_at)
         VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`,
      person.name, v.id, v.name, v.family, v.source, v.unit ?? null, v.value,
      v.n, v.withheld ?? null, v.measured_by, builtAt);
    written += 1;
  }
}

corpus.close();

const pad = (s, w) => String(s).padEnd(w);
console.log(`\n${pad('person', 24)}${pad('messages', 10)}${pad('reported', 10)}${pad('withheld', 10)}context rules`);
for (const s of summary) {
  console.log(`${pad(s.person, 24)}${pad(s.messages, 10)}${pad(s.reported, 10)}${pad(s.withheld, 10)}${s.rules}`);
}

console.log(`\n${people.length} people. A variable is withheld below ${MIN_N} observations rather than`);
console.log('reported as zero, so a high withheld count on a quiet person is correct, not a fault.');
console.log(`${NOT_COMPUTED.length} variables cannot be computed at all from a chat corpus; ` +
  'run with --write and query\ncoach_person_variables, or read the list in variables.js#NOT_COMPUTED.');

if (WRITE) {
  const stored = rows(`SELECT COUNT(*) AS n, SUM(priceable) AS priceable FROM coach_person_variables`)[0];
  console.log(`\nWrote ${written} rows. coach_person_variables now holds ${stored.n}, ` +
    `${stored.priceable ?? 0} of them priceable.`);
  console.log('Nothing is priceable until the grading harness has measured it. That is the point.');
} else {
  console.log('\nDry run — nothing was written. Re-run with --write once the numbers look right.');
}
