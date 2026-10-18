# TDD evidence (retroactive): the availability term two files said they did not have — 2026-09-20

**What this is.** PR #38 adds the injury-return model (WO / O2): a measured probability that
a player plays in week *w+k*, and an expected-games-remaining number built from it. It
shipped with 15 tests and with a walk-forward audit in the PR body. What was missing was
this file — `CLAUDE.md` asks for a RED commit, a GREEN commit and an evidence record under
`docs/tdd/`, and #38 had tests without the record.

**Nothing imports the new modules**, so this PR moves no pricing surface. What it changes is
that the model exists and is measured; the incumbent it replaces is the assertion, made by
`ros-projection.js:66` and `trade-engine.js:359` in their own headers, that P(he plays) = 1
for everyone every week.

**How the retroactive RED was shown.** Ten mutations were run over the guarded rules, one at
a time, each restored from a pristine copy before the next. **Two passed.** Both are fixed
below, one by a new case and one by rewriting a test whose fixture could not distinguish the
behaviour it named.

| Guarded rule | Mutation | Caught |
|---|---|---|
| Weeks-out buckets follow the hazard table's cuts | `3-4` boundary widened to `3-5` | 1 fails |
| Only R48 and R59 get their own group | every detail code gets one | 3 fail |
| Practice squad counts as unavailable | `DEV` removed from `UNAVAILABLE` | 1 fails |
| A cell below the minimum falls back to its parent | `MIN_CELL` 40 → 1 | **0 — gap 1** |
| Weeks-out restarts after a return | `out` never resets | 1 fails |
| A gap stops the horizon walk | the gap guard removed | **0 — gap 2** |
| A bye is removed from the expectation, not priced | bye term dropped | 1 fails |
| The panel reads availability from snaps, not status | `played` read from `status = 'ACT'` | 1 fails |
| A horizon past the fit is labelled `held_flat` | `held_flat: false` on the held branch | 1 fails |

## Gap 1: the fallback ladder was tested at 240 against 0, so the threshold was free

*"a thin cell falls back to its group, then to all reserve weeks, and says which"* compares a
cell with 240 observations against cells with none. Both sides of that comparison land the
same way for **any** value of `MIN_CELL`, so the constant that decides when a rate is thin
enough to distrust had nothing testing it:

```
### M4: MIN_CELL dropped to 1 (no fallback ladder)
# pass 15
# fail 0
```

A threshold with no boundary test is a comment. The new case addresses the boundary: two
weeks on reserve gives each player exactly one horizon-1 observation, so a cell's *n* is the
player count and `min_cell` and `min_cell - 1` are both constructible. The constant is read
off the fit rather than restated, so the test cannot drift from the code:

```
### M4 again: MIN_CELL dropped to 1
not ok 7 - the minimum-cell constant is the one the fallback ladder actually uses
# pass 15
# fail 1
```

Raising `MIN_CELL` to 41 still fails nothing, and that is deliberate rather than a second
gap. The guarded rule is "a cell below the minimum falls back to its parent", not "the
minimum is forty": the value is a tuning choice with no measurement behind it in the PR, and
a test that pinned 40 would fail the next time someone justifies 50. What must not change
silently is the relationship, which is now pinned.

## Gap 2: the gap test asserted empty curves on a fixture that was empty anyway

*"a gap in the panel is not treated as an adjacent week, at any horizon"* built a two-row
panel and asserted `fit.curve` and `fit.reserve_curve` were both `{}`. Two rows are below
`min_cell`, so those maps are empty whatever the horizon walk does. The assertion was
vacuous, and removing the gap guard failed nothing:

```
### M7: a gap in the panel is treated as an adjacent week
# pass 16
# fail 0
```

The rewritten test uses 60 players on reserve in weeks 1 and 2 and **active and playing in
week 4**, with week 3 absent. Week 4 is a real horizon-3 target from week 1 by arithmetic,
and grading it would credit those players with a return nothing observed — the panel does
not say they were on a roster in week 3 at all. Week 4 is also the only week anyone played,
so any non-zero rate above horizon 1 is that week leaking across a week nobody was seen in.

Finding the mutation that this catches took three attempts, and the reason is worth
recording. `if (!target || !byWeek.get(here.week + k - 1)) break;` has two conditions, and
given the `break` **the second one is unreachable**: the walk stops at the first missing
target, so `here.week + k - 1` was present in the previous iteration by construction. So

- removing the guard while keeping `break` (M7) changes nothing, and
- turning `break` into `continue` while keeping the guard (M7a) changes nothing either — the
  guard is what stops week 4 there, which is the one configuration where it is load-bearing.

Only removing both protections grades the week past the gap, and that fails:

```
### M7c: walk past a gap AND the gap guard removed
not ok 16 - a gap in the panel stops the horizon walk; the week past it is never graded
# pass 15
# fail 1
```

The guard is left in place. It is dead today and becomes the only protection the moment
someone turns that `break` into a `continue` to squeeze more observations out of a sparse
panel, which is exactly the change this model invites. It is now covered rather than
trusted.

## The eight mutations that were already caught, as run

```
### M1: bucket boundary 3-4 widened to 3-5
not ok 1 - weeks-out buckets follow the boundaries the hazard table is cut on
# pass 14
# fail 1

### M2: every reserve detail gets its own group
not ok 2 - only the two documented reserve codes get their own group; everything else pools
not ok 6 - a thin cell falls back to its group, then to all reserve weeks, and says which
not ok 8 - the state a caller describes maps to the cell the fit stores
# pass 12
# fail 3

### M3: practice squad counted as available
not ok 5 - practice squad counts as unavailable, because no practice-squad week records a snap
# pass 14
# fail 1

### M6: weeks-out never restarts after a return
not ok 3 - weeks-out restarts after a return, so a second injury is not charged the first one's duration
# pass 15
# fail 1

### M8: byes are priced rather than removed
not ok 13 - a bye week is removed from the expectation, not priced
# pass 15
# fail 1

### M9: availability read from the status code, not from snaps
not ok 15 - the panel reads availability from snaps, not from the roster status
# pass 15
# fail 1

### M10: held_flat never set
not ok 8 - a horizon past the end of the fit holds the last fitted value and is labelled
# pass 15
# fail 1
```

M9 is the one to read twice. It is the rule the whole panel rests on: `played` comes from
`player_week_snaps.offense_snaps > 0`, not from the roster status code, because a status code
says what a team filed and a snap says what happened. Reading the status instead would have
made the model's outcome variable a restatement of its own input.

## The measurements, not re-derived here

The walk-forward numbers in #38's body stand as measured: 2024 scored by a fit that saw only
2021-2023 and 2025 by one that saw only 2021-2024, Brier 0.1394 against the incumbent's
0.2582 on active weeks and 0.1046 against 0.8745 on reserve weeks, with log loss 0.35 against
12.08 — and that 12.08 only finite because predictions are clipped at 1e-6. Unclipped it is
infinite, which is the honest score for asserting that a player on injured reserve certainly
plays.

The rejected design is in the module header and is not repeated here beyond why it was
rejected: a three-state Markov chain held out on 2025 said a healthy player who played last
week would play in four weeks 69.8% of the time against an observed 79.3%, with the same sign
at every horizon from k=2 to k=8, because the pooled "active but idle → plays next week" rate
of 20.7% mixes deep-bench players with a starter who missed one week, and a memoryless chain
bleeds probability off the starter on every pass. The per-horizon curve is not a refinement
of that model; it is a different one, chosen because the chain was measurably wrong.

## Verification

Branch `claude/project-thread-f921do-o2` at the head this file is committed on. Full local
run stated in the commit, taken in place of CI while the repository's only workflow is
disabled.
