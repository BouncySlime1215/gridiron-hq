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
least one is above zero**. The three are individually redundant and jointly necessary:
`decided` catches a future 0-0 in a payload that carries `winner`; `anyPoints` catches one in
a payload with no `winner` key at all; and `anyPoints` is `||` rather than `&&` because a
completed week really can have a 0 on one side — a shutout is a result, not a missing week.
Each of those three cases has its own test.

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

There was no RED commit. This is an extraction of code that already had tests on the O4
branch, and writing a failing version of working code to satisfy the shape of the rule would
be theatre. CLAUDE.md's own allowance applies: retroactive RED by mutation. The sweep below
is that RED, and the tests are new — the O4 tests do not exist on `main`.

## Mutations

Every mutation was applied and the file confirmed changed before running; a pattern that did
not match is reported as NO-OP and is not evidence.

| # | mutation | result |
|---|---|---|
| E1 | admit unplayed weeks (drop the decided check) | 5 fail |
| E2 | `anyPoints` becomes `&&`, so a real shutout is dropped | 1 fail |
| E3 | `regular_periods` reports the weeks played instead | 2 fail |
| E4 | default the season length to 14 when absent | 1 fail |
| E5 | `made_playoffs: 0` instead of `null` | 1 fail |
| E6 | `outcome_known: true` on a live season | 1 fail |
| E7 | `season` from the league row, ignoring `payload_season` | 1 fail |
| E8 | postseason periods admitted as regular-season rows | 2 fail |
| E9 | a side with no team id gets a null roster row | 1 fail |
| E10 | a generic reason for every unreadable state | 1 fail |

All ten fail. None survived, so nothing was rewritten.

## Numbers

12 tests, 12 passed, 0 failed.
Full local check `npm run check`: exit 0 — 2,962 tests, 2,921 passed, 0 failed, 41 skipped;
typecheck, lint and build clean; `start:smoke` passed on an isolated database.

## The five questions

**Is this well built?** One file, one function, no imports, one name. Every unreadable state
returns a printable sentence rather than an empty array a caller has to interpret, and there
is a test that no reason contains a stray `undefined` or `null`.

**Is this based on stats, or is it made up?** It is a parser: it reports what ESPN stored and
refuses where ESPN stored nothing. The only judgement is which periods count as played, and
that judgement is three explicit conditions with a test each.

**How do we know?** Ten mutations, all failing, including one for each of the three
admission conditions.

**Should this data be pointed anywhere else on the platform?** That is the reason it exists
as its own module. Known consumers: the Team Outlook panel, the luck read, four feature-audit
thresholds, and `routes/leagues.js` at the two lines that already fetch and store the data.

**How does it unify?** It replaces four parsers that had not been written yet with one, under
one name, before they diverged. The alternative was not "no parser" — it was four.
