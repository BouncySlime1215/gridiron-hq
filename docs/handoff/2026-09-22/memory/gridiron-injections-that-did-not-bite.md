---
name: gridiron-injections-that-did-not-bite
description: The Gridiron HQ defect injections that failed to turn a test red on 2026-09-20, what each one proved instead, and the fixture traps behind them.
metadata:
  type: project
  modified: 2026-09-20T02:25:00.000Z
---

Companion to [[gridiron-tdd-defect-injection]], which says to run them. This is
what running twenty-four of them across the feature-audit's nine changes
actually found. **Three tests could not fail and were rewritten; three injections did not
bite for reasons that were worth more than the injection.**

## Three tests that proved nothing

1. **A premise that named a consequence and checked a precondition.** #64's test
   1, "no betting line is loaded, so the old path would answer week 1", asserted
   only `SELECT season FROM game_lines` is empty. Changing the no-league fallback
   from `|| 1` to `|| 7` left the file green. Now also asserts
   `tradeWeekContext().week === 1` **and** that the league's week differs from 1 —
   without the second, tests 2-7 could each be comparing the league's week against
   a betting week that happened to agree.
2. **An assertion about what is NOT in a list, over an empty list.** #67's "a
   kicker or defense never appears as a patch" looped over candidate lists that
   were empty by construction. Deleting the filter AND widening `bestLineup`'s
   `SCORED` left it green. Now read against a second league where a receiver is
   unowned, asserting first that a candidate exists and that it is him.
3. **A shape check under a value-claim title.** #67's "the underlying outlook is
   unchanged" was `typeof from_week === 'number'` plus `Array.isArray(weeks)`.
   Nudging every week's `points_lost` by one left it green. Now compares
   `from_week`, `reading` and `weeks` field by field against `byeOutlook`.

**The pattern in all three: the title claimed a behaviour, the body checked a
type or a precondition.** Read every regression pin's title against its body.

## Three injections that did not bite, and what they proved

- **Widening only `waiver-brain.js`'s `LINEUP_MODELLED` does not make a kicker
  rank.** `bestLineup` is what declines to score him, so his gain stays 0 and he
  falls out at `gain <= 0.05` anyway. The filter is what lets the page **say why**;
  the solver is what makes it true. Both halves are needed to move the test.
- **An injection aimed at the wrong BRANCH of the function under test.** f4e
  coerced a null `confidence` to `0.9` inside `publishRecommendation`
  (`routes/decision-inbox.js`) — at the first textual match of the parameter
  list, which is the **UPDATE** branch. The test publishes a new record, so only
  the **INSERT** branch runs and the suite stayed 6/6 green. Under the standing
  rule that reads as "the test is wrong". It was not; the injection was.
  **Before concluding a test is vacuous, confirm the mutated line executes.** A
  function with an upsert shape has two copies of every argument list, and a
  `str.replace(old, new, 1)` will always take the first.
- **The `|| 1` week fallback is pinned in #64's file, not #57's.** #57's test 5
  seeds two game lines and asserts 6, so it guards the `MIN(week)` read and never
  reaches the fallback. Re-aimed at `MIN` -> `MAX`, it bites. This is how #64's
  weak premise came to light at all.

Fixture traps that make one of these vacuous, bye weeks and VOR alike:
[[gridiron-test-fixture-traps]].

## One test with no applicable injection, recorded as such

#62's "the spelling this file uses is the spelling the data uses" asserts that
nothing is spelled `'DST'` and things are spelled `'DEF'`. That is a claim about
the data; no mutation of this repository can fail it. Keep it, do not count it as
a guarded rule.

Also established while doing this: **K and DEF do carry a `ros_ppg`** (it is
`proj / GAMES`), so their exclusion from `bestLineup` is a modelling choice, not
missing data. See [[feature-audit-shipped-prs-55-57]].
