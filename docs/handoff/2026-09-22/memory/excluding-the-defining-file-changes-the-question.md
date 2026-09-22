---
name: excluding-the-defining-file-changes-the-question
description: A consumer count that excludes the defining file answers "is this imported", not "is this used" — and for a symbol used where it is defined, that exclusion deletes the answer and reports a live code path as dead.
metadata:
  type: feedback
---

My error, 2026-09-22 02:53Z. I counted consumers of each export with
`git grep -n "\bSYMBOL\b" origin/main -- server client scripts test` **minus the
defining file**, and reported `SEASON_ENDING_RE` and `RELEASED_RE`
(`server/services/player-availability.js:19-20`) as "consumed by nothing — not
server, not client, not scripts, not a single test", offering it as a dead
export or a producer whose consumer was deleted.

Wiring map corrected it and was right. Both regexes are called **inside their own
file** — `:77` in `newsSeverityFor`, `:152` in `seasonEndingEspnIds` — and both
of those functions have production consumers (`routes/teams.js`,
`trade-engine.js`). The code path is live. What is unused is only the `export`
keyword. "Exported and never imported" is a tidy-up; "dead" is a deletion
candidate, and I had reached for the second word on evidence that supported the
first.

**Why the exclusion is the trap.** Dropping the defining file is right when the
question is *who depends on this module* — otherwise the definition line itself
counts as a hit and everything looks used. It is wrong the moment the symbol is
also **used where it is defined**, because that is exactly the evidence the
exclusion throws away. One filter, two incompatible questions, and the output
looks identical either way.

**How to apply.**
1. Run both counts, never one: with the defining file (is it used at all?) and
   without (does anything import it?). A symbol that is 0 without and non-zero
   with is *exported and never imported* — say that, not "dead" or "unused".
2. Before calling anything dead, open the defining file and look. A grep count
   is not a reading ([[a-grep-finds-a-pattern-not-a-shape]]).
3. Trace one level up: an internal caller is only alive if *its* callers are.
   That is the step that turns "used somewhere" into "reached in production".
4. When corrected, re-run the same check against your **own** earlier table
   before accepting it. I did, on `availability-basis.js`: its only internal use
   is `AVAILABILITY_BASIS` at `:134` inside `isAvailabilityBasis`, so
   [[availability-basis-module-is-not-wired-yet]] survives the correction — but
   it survives because it was re-measured, not because it was mine.
