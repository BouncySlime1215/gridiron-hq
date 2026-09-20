# TDD evidence (retroactive): the odds say which evidence and which constants made them — 2026-09-20

**What this is.** PR #44 changed two gated behaviours: which seasons and weeks the season
simulator builds its projections from, and whether the response names the shrinkage
constants those projections used. Both shipped with tests and with measurements in the PR
body; what was missing was this file. `CLAUDE.md` asks for a RED commit, a GREEN commit and
an evidence record under `docs/tdd/`, and #44 had the first two twice over and not the third.

**How the retroactive RED was shown.** Each guarded rule was reverted in place — one
mutation at a time, restored from a pristine copy between runs — and the relevant test files
re-run. Eight mutations were run. **Three of them passed**, which is the substance of this
file: three guarded rules had no test, one of them the single field another thread had
already built user-facing copy on. Tests for all three were written and are listed below.

| Guarded rule | Test | Mutation | Caught |
|---|---|---|---|
| Two games, not one, before reading this season | `season-sim-playoff-shape.test.js` | `SIM_PROJECTION_MIN_GAMES` 2 → 1 | 3 fail |
| Evidence is counted from the usage log, not the calendar | same | `have = calendar` | 3 fail |
| The cutoff is `fromWeek - 1`, never the week being simulated | same | `calendar = week` | 5 fail |
| A log claiming more weeks than were played cannot buy the this-season basis | **nothing, before today** | `Math.min(calendar, logged)` cap removed | **0 — see below** |
| `projection_fit` is present in the response | `sim-projection-fit-response.test.js` | field deleted from the literal | both fail |
| `volume_k` reports `hand_set` for a season-long caller with a fit active | **nothing, before today** | `volume_k: 'fitted'` | **0 — see below** |
| `activeFitMeta` reports when the fit was fitted | **nothing, before today** | `fitted_at` dropped from the SELECT | **0 — see below** |
| The volume entries are withheld from callers not on weekly-role recency | **nothing, before today** | the withholding branch removed | **0 — see below** |

## Gap 1: the cap on `logged` guarded the threshold, and only the cutoff was tested

There was a test named *"the logged count can never push the cutoff past the week being
simulated"*, and it asserts the cutoff — which is `fromWeek - 1` whatever the log says. So it
passes with the cap removed:

```
### M3: a logged count above the calendar widens the cutoff
# pass 19
# fail 0
```

What the cap actually guards is the **threshold**. At week 2 one game has been played; a log
reporting 99 weeks is impossible, and without `Math.min(calendar, logged)` `have` becomes 99,
clears `SIM_PROJECTION_MIN_GAMES`, and selects the one-game basis that #44 measured as *worse*
than reading last season complete — while printing "only 99 of those 1 weeks are in the usage
log". A new case asserts the basis rather than the cutoff, and the mutation now fails:

```
### M3 again, with the cap removed
not ok 20 - a log claiming more weeks than have been played cannot buy the this-season basis
# pass 19
# fail 1
```

## Gaps 2, 3 and 4: the no-active-fit premise hid the whole field

`test/projection-fit-meta.test.js` says in its own header that it "deliberately run[s] with
NO active fit in the database, which is the state the live volume is in". That is true and
worth keeping — it is the production case. But with `shrinkage_fits` empty, `activeFitMeta()`
returns null and `projectionFitMeta` returns before reaching any of the logic the field
exists for, so three mutations passed all four of its tests:

```
### M6: volume_k always reports fitted
# pass 6
# fail 0

### M7: activeFitMeta stops selecting fitted_at
# pass 4
# fail 0

### M8: the withholding rule removed (volume handed to every caller)
# pass 3
# fail 0
```

M6 is the one that matters. `volume_k` is the single field the Trade Lab copy was built on,
and the sentence it prevents is "these odds use the fitted model" rendered while the volume
half runs on constants `shrinkage-fit.js`'s own header describes as "not claimed to be
right, only untested with the fitted k". Hardcoding it to `'fitted'` would have rendered
exactly that sentence with nothing failing anywhere.

`test/projection-fit-meta-active.test.js` (4 tests) stores a fit and asserts on the branch
the other file cannot reach. It is a separate file on purpose, so the no-fit premise stays
intact. The fixture is the production configuration — `through_season` 2025 predicting 2026,
so `cutoffSafeKVector` returns the stored vector rather than re-fitting for cutoff safety —
and its k rows mix one efficiency metric with two volume ones, because a vector of only one
kind could not show the withholding at all. All three mutations now fail:

```
### M6 again: volume_k hardcoded to fitted
not ok 1 - a season-long caller with an active fit reports hand_set volume, not fitted
# pass 7
# fail 1

### M7 again: activeFitMeta drops fitted_at
not ok 3 - the fit is identified by id and by when it was fitted
# pass 3
# fail 1

### M8: the withholding rule removed (volume handed to every caller)
not ok 1 - a season-long caller with an active fit reports hand_set volume, not fitted
# pass 3
# fail 1
```

## The five mutations that were already caught, as run

```
### M1: switch to this season after ONE game (threshold 2 -> 1)
not ok 11 - one game played is still last season, and the basis says why
not ok 15 - the minimum-games constant is the one the basis actually uses
not ok 16 - the log being behind the calendar is what decides the basis, not the week number
# pass 16
# fail 3

### M2: count the calendar, not the usage log
not ok 16 - the log being behind the calendar is what decides the basis, not the week number
not ok 17 - an empty log for this season says so, instead of naming a week it cannot read
not ok 18 - a log behind the calendar but past the threshold reads this season and states the gap
# pass 16
# fail 3

### M4: the cutoff reads the week being simulated (a leak)
not ok 10 - week 1 reads last season, because there is nothing else to read
not ok 12 - from two games played the simulator reads this season, up to the week before
not ok 18 - a log behind the calendar but past the threshold reads this season and states the gap
not ok 19 - the logged count can never push the cutoff past the week being simulated
not ok 20 - a log claiming more weeks than have been played cannot buy the this-season basis
# pass 15
# fail 5

### M5: projection_fit dropped from the response
not ok 1 - the response carries every basis field a surface is entitled to render
not ok 2 - a caller supplying its own projections is told nothing about the fit, rather than a guess
# pass 0
# fail 2
```

## The measurements, and what they are not re-derived from

The walk-forward crossover in #44's body stands as measured and is not repeated here:
projections built from the complete prior season against the test season through week *c*,
scored by mean absolute error on every later week, with the crossover between one game and
two in all three of 2023, 2024 and 2025, and the advantage growing monotonically to about
0.2 points by eight games against a base error near 5. `SIM_PROJECTION_MIN_GAMES = 2` is that
measurement, and M1 is what stops a later "fix" from switching earlier.

The defect in #44's own first version is worth keeping next to it, because the mutation sweep
is the same instrument that found it: the basis was derived from `fromWeek - 1` alone and
never asked whether `player_week_usage` held those weeks, so it could pick the basis that
measured worse while reporting a week count it did not have. M2 is that defect as a mutation.

## Verification

Branch `claude/project-thread-f921do-sim-basis` at the head this file is committed on. Full
local run stated in the commit, taken in place of CI while the repository's only workflow is
disabled.
