# One availability field, on one shared vocabulary

2026-09-20. `server/services/player-week-engine.js`, `test/availability-basis.test.js`.
Stacked: Opportunity's `9732f83` → this branch. A **merge**, not a fast-forward — this branch
was `+1/-3` against `9732f83` at the time.

This supersedes the first version of this file. That version described an accessor that
defined its own three-value list and classified by matching a prose sentence; both are gone, so
its mutation table described code that no longer exists and is not carried forward. What is
carried forward is the defect and the two findings.

## The defect

Five call sites independently wrote `?? 0.92`: `role-scenario-engine.js:124`,
`season-sim.js:226`, `news-fantasy-impact.js:87`, `roster-risk.js:257` and
`trade-engine.js:346`. None could tell a fitted availability rate from the blanket constant,
and neither could anything downstream, because both arrived as a bare number.

The defect was never the constant's value. It was that the constant was invisible.

## Why the vocabulary is not defined here

Three classifiers had grown for one question and none read a field —
`lineup-brain.js#playerAvailabilityBasis`, this accessor, and `availabilityBasis()` reporting a
different thing under the same name. `contingency.js` now states `availability_basis` on every
row, and `availability-basis.js` (Opportunity's) is its one definition. This file imports
`AVAILABILITY_BASIS`, `DEFAULT_DURABILITY_PRIOR` and `isAvailabilityBasis`, and **defines
neither the list nor a constant** — there is a test asserting the old exports are gone.

Two of the six arms are the consumer's to produce, because no row can carry them:

- **`unfitted_position`** — there is no row at all. `weeklyAvailability` covers QB, RB, WR and
  TE, so every kicker and defence lands here by construction. Deliberately **not**
  `default_durability`, which means a row exists carrying a substituted prior.
- **`unrecognised`** — a row arrived without the field, reachable only from a payload built
  before the field existed. Named rather than guessed at.

`isAvailabilityBasis` and not a null check: a value nobody declared — a typo, or an arm added
on one side only — must not reach six downstream switches as an unknown string. It falls to the
fallback instead, whose worst case is the named `unrecognised`.

## The two quantities that share their digits

`DEFAULT_DURABILITY_PRIOR` is an **input**: `contingency.js` substitutes it as the prior and
then runs the report-status curve over it, so a `default_durability` row's served
`active_probability` is nowhere near 0.92 for a Questionable player.

What this file needs is an **output**-side stand-in: the probability served for a player with no
row, who never went through the curve. Different quantity, same digits — and the digits are
shared for a reason that is not a derivation: all five replaced call sites wrote `?? 0.92`, so
0.92 is what an uncovered player has always been given.

**This is a documented borrow, not a second definition, and it is temporary.** Opportunity is
adding `DEFAULT_ACTIVE_PROBABILITY` to `availability-basis.js` under its own name; the swap here
is one line and one import when that head lands. Using the same number changes no served value
today.

**What the borrow does not do is justify the value.** Whether a kicker should be priced at 0.92,
at 1, or refused a number at all is a real question that moves the odds, and it is for Nick's
list rather than to be settled in a wiring change.

## Never find the default by comparing the number

The row's prior is served at three decimals, so a veteran whose measured prior really is 0.920
is byte-identical to the substituted constant. A value comparison would label a real career
measurement as a fallback on precisely the players whose durability is unremarkable — an error
correlated with the population rather than spread as noise. `durability_prior_measured` is the
discriminator. Pinned on both sides; row B4 is the mutation.

## Mutations

Every row: mutation applied, file hash before → after confirming it changed, failing test named.
A pattern that does not match is a NO-OP and is not evidence.

| # | mutation | applied (sha256, 12) | fails | test that caught it |
|---|---|---|---|---|
| B1 | ignore the served field (`if (false)`) and classify by prose | `51fe1716` → `c4c7661d` | 3 | "the basis the producer states is the basis served…"; "every basis it can return is in the shared vocabulary…"; "THE NO-OP CONTROL…" |
| B2 | a missing row reports `default_durability` | `51fe1716` → `fe7bfb84` | 3 | "a player with no row at all is unfitted_position, not default_durability"; "no map at all is the same answer, not a throw"; "every basis it can return…" |
| B3 | the fieldless fallback claims `role` instead of the coarser `pooled` | `51fe1716` → `20e10095` | 1 | "a row without the field falls back to the prose match, and says so when it cannot tell" |
| B4 | find the default by comparing the number (`durability_prior === DEFAULT_DURABILITY_PRIOR`) | `51fe1716` → `9e805142` | 2 | "a row without the field falls back to the prose match…"; "THE COLLISION: a measured prior of exactly 0.920 is not the default" |
| B5 | a fieldless unknown falls through to `durability_prior` | `51fe1716` → `6bfcc5c4` | 3 | "a row without the field falls back…"; "every basis it can return…"; "a basis the vocabulary does not declare is not passed through" |
| B6 | accept any non-null string as vocabulary (`served != null`) | `51fe1716` → `2b58f18f` | 1 | "a basis the vocabulary does not declare is not passed through" |
| B7 | the loose substring `/prior/i` in place of `/^fitted availability/i` | `51fe1716` → `be214aea` | 3 | "a row without the field falls back…"; "THE COLLISION…"; "a basis the vocabulary does not declare…" |
| **CONTROL** | reword a comment, changing no behaviour | `51fe1716` → `73840042` | **0** | none, correctly — the control proves the suite is not failing on edits as such |

B6 survived its first run: the check was a null test, so an undeclared string passed straight
through to consumers. It was answered by the test named above, not by weakening the mutation.

**The no-op control is the point of the field**, and it is also a test in its own right: a row
with `availability_basis: 'role'` and a directly contradicting `source` sentence keeps `role`.
Before the field existed that test could not have passed, because the sentence *was* the
classifier.

## Numbers

9 tests, 9 passed, 0 failed.
Full local check `npm run check`: exit 0 — 2,975 tests, 2,934 passed, 0 failed, 41 skipped;
typecheck, lint and build clean; `start:smoke` passed on an isolated database.

**One failure worth recording, caught by the check and nothing else.** The edit that replaced
this accessor was applied as a slice between two anchors, and `memoKBasis` — added by the
previous commit — sat between them and was deleted. Both this file's tests and the memo-key
tests still passed, because neither imports `buildPlayerWeekEngine`'s cache path; **54 tests in
other files failed** with `memoKBasis is not defined`. A targeted suite is not a substitute for
the whole one when the edit is structural rather than logical.

## The two call sites in my own files

`role-scenario-engine.js` and `season-sim.js` **serve** `availability_basis` on their own
payloads (`buildPlayerScenarios` also carries `availability_source`; the simulator's per-player
`meta` carries the basis beside `active_probability`). Reading the basis without serving it
would have left the defect where it was. UI owns `news-fantasy-impact.js`; feature audit owns
`roster-risk.js` and `trade-engine.js` and imports these rather than keeping local copies.

## The five questions

**Is this well built?** One vocabulary, defined once in another file and imported. Six declared
arms, an assertion that nothing outside them is reachable, and a refusal to pass through a value
the vocabulary does not declare. It answers rather than throws on a null map, an empty map and a
missing player, because it is called from the odds path.

**Is this based on stats, or is it made up?** It invents no number. It reports which measured
thing produced one, and says so where nothing measured did. `0.92` is not defended here — it is
named so a surface can stop presenting it as a measurement, and the open question about its
value is written down above rather than closed quietly.

**How do we know?** Seven mutations, each applied and hash-confirmed, each with the failing test
named; plus a control that changes nothing and fails nothing.

**Should this data be pointed anywhere else on the platform?** All five call sites, three
belonging to other threads. And the fact worth repeating: `weeklyAvailability` covers QB, RB, WR
and TE only, so **every other position resolves to `unfitted_position` by construction** — any
surface showing availability for a kicker or a defence is showing a number no model produced,
and now says so.

**How does it unify?** It removes the third of three classifiers for one question and replaces
five independent literals with one import — before a sixth was written.
