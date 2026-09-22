# One parser for the weekly scores already in the database

2026-09-20. `server/services/espn-weekly-scores.js`, `test/espn-weekly-scores.test.js`.
Branched off `main` (791b131), deliberately: see "Why off main".

## What was already there

`routes/leagues.js:125` requests `view=mMatchup` and `:160` stores the entire ESPN
response, so `schedule[].home.totalPoints` has been sitting in `leagues.payload` since the
first league sync, unparsed. No table in this database holds per-week fantasy team scores —
checked against `core-and-fantasy.js` and every migration. A table would need a writer, a
migration and a backfill to hold what is already stored.

Four readers want those scores: the Team Outlook panel, the luck read, and four thresholds
that currently have nothing per-week to compute against. That is four chances to write four
parsers of the same quantity, which is how two numbers for one thing end up on two pages.

## Why off main, and why its own file

The parser was written inside `server/services/team-outlook.js`, which exists only on the
O4 branch stack and is absent from `main`. Every consumer would then have had to wait for O4
to merge, and would have had to import the Team Outlook model to read a score it does not
use. So it is its own file, on `main`, with **no imports at all** — there is a test
asserting that, because "dependency-free" is a claim that decays the first time someone adds
a convenience import.

Merge order: this lands before O4's first PR, and the O4 stack then imports
`espnWeeklyRows` from here instead of defining it.

## The row that must not exist

ESPN returns the **whole** season's schedule, and an unplayed matchup comes back
`totalPoints: 0`, `winner: 'UNDECIDED'`.

One admitted zero is not one bad row. Every consumer that standardises computes the league's
mean and spread from the rows it is given, so a false zero moves the scale and every *other*
week's z-score is wrong too — and the team with the most unplayed weeks reads as the worst
team in the league.

A period is admitted only when it is **decided** AND **both sides carry a number** AND **at
least one is above zero**. Each condition is the only one that catches its own case, and the
sweep below now proves it — which it did not before, and that is the substance of this
revision:

- **`decided`** is the only one that catches a week **in progress**. On a Sunday afternoon ESPN
  returns accumulating points with `winner: 'UNDECIDED'`, so the period is neither zero nor
  finished. Admitted, it is worse than an admitted zero: a half-played 58.4 is a plausible
  weekly score, so nothing downstream can notice, and it stands as that team's real total for
  the week until the games end. The zero check cannot see it.
- **`bothScored`** is the only one that catches **one side with no total at all**. `anyPoints`
  reads the missing side as 0 through `?? 0` and passes, so without `bothScored` the scored
  side gets a real row and its opponent gets `points: null` — indistinguishable from a shutout
  to every consumer.
- **`anyPoints`** catches a future 0-0 in a payload with no `winner` key, and it is `||` rather
  than `&&` because a completed week really can have a 0 on one side: a shutout is a result,
  not a missing week.

**What the earlier version of this file got wrong.** It said `decided` "catches a future 0-0 in
a payload that carries `winner`", and recorded that mutation as failing five tests. Both were
wrong. A future 0-0 is caught by `anyPoints` whether or not `winner` is there, so deleting
`decided` broke nothing the suite was looking at, and the re-measured sweep below shows it
surviving. The `5 fail` figure is withdrawn: it was never reproduced under a recorded file
hash, which is why the hashes are now in the table. The condition was right; the argument for
it and the evidence for it were not.

## What `null` means here, in three places

Nothing in this file substitutes a plausible value for a missing one.

- `regular_periods` is the season length, **not** the weeks played. A consumer deriving
  weeks-remaining needs it, and it is `null` when the payload does not carry it. A default
  would be inventing the length of somebody's season, and the consumer that wants to refuse
  needs to be able to tell.
- `made_playoffs` and `champion` are `null`, never `0`, and every row carries
  `outcome_known: false`. A `0` reads as "did not qualify" to anything fitting on these rows,
  silently and with the wrong sign.
- A side with no `teamId` is dropped rather than given a null roster id, and its opponent is
  named as absent.

`season` comes from `payload_season` before `leagues.season`, because they differ:
`syncEspnLeague` falls back to last season when the current one returns empty rosters, and
migration `062_league_payload_season` exists to record which the payload came from.

## RED, stated honestly

There was no RED commit for the extraction itself. It moved code that already had tests on the
O4 branch, and writing a failing version of working code to satisfy the shape of the rule would
be theatre. CLAUDE.md's own allowance applies: retroactive RED by mutation, and the sweep below
is that RED. The tests are new — the O4 tests do not exist on `main`.

The two tests added in this revision have a real RED, and it is in the table: each one passes
on the base file and fails on the mutation that deletes the condition it covers, which is the
same statement a RED commit makes.

## Mutations

Re-run 2026-09-20 in the canonical shape, and the re-run is why this file changed. Every row is
applied to `server/services/espn-weekly-scores.js` one at a time from the same clean base, with
the file's SHA-256 (first 12 characters) recorded before and after, so a pattern that silently
failed to match cannot be read as a row the tests caught. Run:
`node --test --test-concurrency=1 test/espn-weekly-scores.test.js`.

Base file: `f95fd277b867`. Restored to `f95fd277b867` after the last row, checked.

| # | mutation | state | sha256 before -> after | fail | a test that fails |
|---|---|---|---|---|---|
| E1 | admit a week in progress (drop the `decided` check) | APPLIED | `f95fd277b867` -> `471e999b10be` | 1 | a week in progress is refused, even though it already has real points on the board |
| E2 | `anyPoints` becomes `&&`, so a real shutout is dropped | APPLIED | `f95fd277b867` -> `2d596ec0e51f` | 1 | a completed week with a real zero on one side is kept |
| E3 | `regular_periods` reports the weeks played instead | APPLIED | `f95fd277b867` -> `ce781b7dd4b8` | 2 | regular_periods is the season length, which is not the weeks played |
| E4 | default the season length to 14 when absent | APPLIED | `f95fd277b867` -> `a1f41a55a79e` | 1 | a payload with no season length reports null rather than a guess |
| E5 | `made_playoffs: 0` instead of `null` | APPLIED | `f95fd277b867` -> `d6e07c4bc2e1` | 1 | every row says its outcome is unknown, because the season has not finished |
| E6 | `outcome_known: true` on a live season | APPLIED | `f95fd277b867` -> `77d2955e0754` | 1 | every row says its outcome is unknown, because the season has not finished |
| E7 | `season` from the league row, ignoring `payload_season` | APPLIED | `f95fd277b867` -> `0b3880fe5cc3` | 1 | the season comes from the payload, not from the league row, when they differ |
| E8 | postseason periods admitted as regular-season rows | APPLIED | `f95fd277b867` -> `52910d254dd9` | 2 | playoff periods are not regular-season rows |
| E9 | a side with no team id gets a null roster row | APPLIED | `f95fd277b867` -> `fbe33865eb8a` | 1 | a matchup with no team id on one side is dropped, not given a null roster |
| E10 | a generic reason for every unreadable state | APPLIED | `f95fd277b867` -> `1fc748597c8d` | 1 | each unreadable state has its own printable reason |
| E11 | `bothScored` dropped, so one missing side is admitted | APPLIED | `f95fd277b867` -> `77124f69d0af` | 1 | a side with no score at all takes its whole period with it |
| CONTROL | a header comment reworded, no code path touched | APPLIED | `f95fd277b867` -> `ddf566d014cb` | 0 | none, and none should |

**Two of these rows survived on the first re-run, and that is the finding.** E1 (`decided`
deleted) and E11 (`bothScored` deleted) each failed **zero** tests against the twelve-test
suite. Both conditions were correct; neither was tested. The suite had a fixture for a future
0-0 and a fixture for a genuine shutout, so `anyPoints` was covered twice, and nothing
exercised a week with points on the board and no winner, or a matchup with a total on one side
only.

The fix was two tests, not two weaker mutations. `test/espn-weekly-scores.test.js` gained
"a week in progress is refused, even though it already has real points on the board" and
"a side with no score at all takes its whole period with it", and the rows above are from the
re-run against the enlarged suite. CLAUDE.md's rule cuts this way: fix the implementation, not
the test — and where the implementation is already right, the test is what was wrong.

**Why the state column is here.** Every row above moved the file's hash, so every row is a real
measurement rather than a pattern that failed to match and read as green. The CONTROL row is
the other half of the same argument: it changes the file, and it fails nothing. A sweep whose
control also failed tests would mean the suite was reacting to the file being touched rather
than to what the edit did.

**E11 is also the case for keeping the three conditions apart.** They read redundant, and two
of the three were in fact unverified for as long as this file existed. A reader who simplified
`decided && bothScored && anyPoints` down to one check would have taken a green suite with them.

## Numbers

14 tests, 14 passed, 0 failed (12 at the extraction, plus the two the re-run showed were
missing).
Full local check `npm run check`: exit 0 — 2,964 tests, 2,923 passed, 0 failed, 41 skipped;
typecheck, lint and build clean.

## The five questions

**Is this well built?** One file, one function, no imports, one name. Every unreadable state
returns a printable sentence rather than an empty array a caller has to interpret, and there
is a test that no reason contains a stray `undefined` or `null`.

**Is this based on stats, or is it made up?** It is a parser: it reports what ESPN stored and
refuses where ESPN stored nothing. The only judgement is which periods count as played, and
that judgement is three explicit conditions with a test each.

**How do we know?** Eleven mutations and a control, every one recorded with the file's hash
before and after so a row cannot be green by accident. Two of the eleven survived the first
re-run and are the reason this file was rewritten: the `decided` and `bothScored` conditions
were correct and untested, and the suite now has a test for each. Where a claim in the earlier
version could not be reproduced — the `5 fail` on E1 — it is withdrawn in the text above rather
than quietly corrected.

**Should this data be pointed anywhere else on the platform?** That is the reason it exists
as its own module. Known consumers: the Team Outlook panel, the luck read, four feature-audit
thresholds, and `routes/leagues.js` at the two lines that already fetch and store the data.

**How does it unify?** It replaces four parsers that had not been written yet with one, under
one name, before they diverged. The alternative was not "no parser" — it was four.
