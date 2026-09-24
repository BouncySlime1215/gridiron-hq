# TDD evidence (retroactive): bye risk says what it never scored

**Change.** `claude/project-thread-5f9c3y-byerisk-honest`, PR #67, on top of
`25d911c` (PR #62's head). Two commits: the fix, then a second that rewrote two of
its own four tests because defect injection showed they could not fail.

**Defect.** `byePatches` (`server/services/roster-risk.js:160`) draws its pool from
the same `freeAgents` the waiver board uses and ranks every candidate through
`bestLineup`, which scores QB/RB/WR/TE only by design. A kicker or defense
therefore recovers exactly zero points and was dropped at a `recovered > 0.25`
threshold meant for *weak* candidates — after which the page concluded "nothing on
the wire fixes it, this one has to come from a trade or be absorbed."

That is advice drawn from a search that never ran on those positions. If the
defense is the player on bye, that is precisely the week the page exists for.

Unmodelled candidates are now filtered where they are filtered for a reason, and
named: `not_modelled` on the payload — the same field and the same meaning as
`waiverUpgrades`' — plus a clause on the empty-week reading. **Nothing changes
about what the solver scores.**

## RED (`test/bye-risk-not-modelled.test.js`, 4 tests, at `25d911c`)

Re-run at the parent commit with the final fixture:

```
# tests 4
# pass 2
# fail 2
not ok 1 - the page names the positions it never scored
not ok 2 - "nothing on the wire fixes it" cannot stand alone over an unscored position
```

The empty-week assertion in test 2 is guarded: it walks the weeks that produced no
patch, and a fixture producing none would make that loop vacuous, so it asserts
`empty.length > 0` first.

## Injections — two of four tests could not fail

Tests 3 and 4 pass at the parent, as regression pins should. They also passed
under injections that broke exactly what they claim to guard, which is not what a
pin should do. Both were rewritten.

**Test 3, before.** It looped over `result.patches[].candidates` in league 601,
whose wire holds nothing but a kicker and a defense. Every candidate list was
empty by construction, so the loop asserted nothing at all. Removing the
`lineup_modelled` filter *and* widening `bestLineup`'s `SCORED` set together left
it green — 4 passed, 0 failed. An assertion about what is **not** in a list proves
nothing over an empty list.

It now reads league 602, identical except that a receiver is unowned there, and
asserts first that a ranked candidate exists and that it is that receiver.

**Placing that receiver took three goes, and the fixture records why**, because
the next reader will hit it too:

1. `players.bye_week` is never populated and nothing on this path reads it.
   Writing it changed nothing.
2. `matchupModel` calls the first week from 4 to 14 with no scheduled game a
   team's bye (`matchups.js:324`), and the only schedule row the fixture seeded was
   week 1 — so **every** team byed in week 4, the squad and the whole wire alike,
   and every free agent was dropped by `fa.bye !== bad.week` before anything scored
   him.
3. Worse, the injection was self-defeating: widening `SCORED` gives K and DEF a
   real `scheduleOutlook` where they previously fell to a `bye: null` fallback
   (`trade-engine.js:336`), so widening it *created* the week-4 bye that then
   filtered them out.

Every team except the squad's is now given a week-4 game, moving the whole wire's
bye to 5. The wire is then held off the list only by what the code does. With that
fixture, the same injection bites:

```
# tests 4
# pass 2
# fail 2
not ok 2 - "nothing on the wire fixes it" cannot stand alone over an unscored position
not ok 3 - a kicker or defense never appears as a patch, on a wire that can produce one
```

**Test 4, before.** It asserted `typeof result.from_week === 'number'` and
`Array.isArray(result.weeks)` under the title "the underlying outlook is
unchanged". Nudging every week's `points_lost` by one left it green, because a
shape check cannot see a value change. It now compares `from_week`, `reading` and
`weeks` field by field against `byeOutlook` — the function `byePatches` spreads —
and asserts the outlook being compared is non-empty:

```
# tests 4
# pass 3
# fail 1
not ok 4 - the underlying outlook is unchanged
```

## GREEN

All 4 pass at the branch head, with the full suite green (numbers in the PR body).

## Is this well built

- **Well built:** yes, and deliberately small. It changes what the page says about
  its own coverage and nothing about the solve.
- **Stats, or made up:** this file is almost entirely **hand-set**, and none of it
  is fitted. `recovered > 0.25` for a candidate to be worth listing;
  `points_lost >= 5` for a week to be worth acting on; the top `3` weeks and top
  `4` candidates; a `pool` of 150; `adj_ppg < 8` for the "cheap precisely because
  he is unremarkable" phrasing. Every one is a judgement call with no citation in
  the file. The one thing that is not hand-set is the cost of a bye week itself,
  which is solved rather than counted — each week's lineup is re-optimised with
  the bye players removed, which is the right shape.
- **How we know:** for the coverage claim, the injections above and the solver's
  own `SCORED` set. Note what the injection established: K and DEF **do** carry a
  `ros_ppg`, so the exclusion is a modelling choice, not missing data.
  For the constants, nothing — no backtest exists for any of the five.
- **Pointed anywhere else:** `not_modelled` is the same field as
  `waiverUpgrades`'. Every other surface that ranks through `bestLineup` has the
  same silent gap. The `0.25` and `5` thresholds should be one shared, named
  constant rather than two files' literals, which they are not today.
- **How it unifies:** one name for "the model does not score this", used
  identically by the waiver board and the bye page.
- **A held-out test would look like:** for the thresholds, sweep `recovered` and
  `points_lost` over past league-seasons and score the recommendations against
  what the manager's actual lineup scored that week versus what the patched one
  would have. The corpus for that is the weekly fantasy scores the Team Outlook
  work is parsing out of `leagues.payload`. Until then these five numbers are
  someone's judgement and should be described that way on the page.
