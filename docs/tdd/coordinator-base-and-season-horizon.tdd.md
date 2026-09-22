# TDD evidence: the coordinator's base, and the season a trade is priced over

**Change.** `claude/project-thread-5f9c3y-trade-week`, PR #57, two further commits
on top of that PR's own pair: `f2ac614` (the coordinator base) and `570cc30` (the
season horizon). Both edit `server/services/trade-engine.js`, which is this
thread's file under the one-editor-per-server-file rule.

Neither defect was reported by a test, a user or a page. Both were found by
reading what a served number claims against what the code that made it actually
computed. Both are wrong in a direction a reader cannot see: the number renders,
it is plausible, and it is the figure the trade card leads with.

RED here is retroactive, by mutation, per the project rule: the tests are new, so
the proof that they bite is that each one fails under a defect deliberately put
back. Every injection below was run; every one of them failed the intended test.

---

## Finding 1 — the correction was added to the wrong number (`f2ac614`)

**Defect.** `coordinateFantasy(fit, experts, base)` returns `base + correction`.
The correction is a residual from the **structural** projection, by construction
and by grading:

- the fit's training target is `actualPoints - projection.structural_ppg`
  (`fantasy-coordinator.js:324`);
- its walk-forward baseline is "predict zero correction", scored with
  `structuralPpg = 0` (`:519`), so the correction alone is what gets graded.

`assetUniverse` passed `weeklyPpg` — that is `weekProjection.ppg`, the **ensemble**
— so production served `ensemble + correction`. That sum was never graded against
anything.

It is not merely off-base; it double-counts one specific thing. One of the
correction's three experts is `ensemble_shift`, defined as
`projection.ppg - projection.structural_ppg` (`:33-34`) — the ensemble calibration
itself. Feeding the ensemble as the base applies that calibration once in the base
and again inside the correction.

**Exposure, measured rather than asserted.** On a scratch rebuild: 352 of 1,169
startable players carry a non-zero `ensemble_shift`; mean 2.09 points, p90 5.21,
max 13.75. So for three in ten priced players the served number is off by the size
of a weekly starter decision.

**Fix.** The base is now a named exported function with the reasoning in its
doc-comment:

```js
export function coordinatorBase(weekProjection) {
  return weekProjection?.structural_ppg ?? null;
}
```

A bare argument at one call site is exactly how this went wrong, so the choice is
no longer expressible as one. When there is no structural head the function
returns `null` and the coordinator is skipped, rather than silently falling back
to the ensemble — the failure being fixed is a plausible wrong number, so the
absence of an input must not produce another one.

**The same seam is wrong in the other direction at `fantasy-coordinator.js:571`,
which is the fantasy plan thread's file, not this one.** It is routed, not edited
here. The two changes are independent edits in different files and merge in either
order.

### Injections (`test/coordinator-base-is-structural.test.js`, 6 tests)

```
### f1a  coordinatorBase returns weekProjection.ppg — the pre-fix behaviour restored
# tests 6   # pass 4   # fail 2
not ok 3 - the base is the structural head, not the ensemble
not ok 4 - with no structural head the coordinator is skipped, not handed the ensemble

### f1b  the ?? null fallback replaced by ?? weekProjection.ppg
# tests 6   # pass 5   # fail 1
not ok 4 - with no structural head the coordinator is skipped, not handed the ensemble
```

Tests 1, 2, 5 and 6 pass under both injections and are named for what they are.
Test 1 pins that the fit in the fixture is real, so tests 3 and 4 are about a
correction that exists rather than about zero. Test 2 pins the fit's own declared
target (`fit.safeguards.target === 'structural-projection residual'`) — that is
the fact the whole finding rests on, and if it ever changes, this test is the one
that should go red first. Test 5 pins the arithmetic of `coordinateFantasy` itself
(base plus correction, whatever base it is handed), which the fix does not touch
and must not. Test 6 measures the gap directly: feeding the ensemble instead moves
the served number by exactly the ensemble shift.

---

## Finding 2 — the season figure counted weeks already played (`570cc30`)

**Defect.** `evaluate` returned `season_delta = ppg_delta * GAMES` with
`GAMES = 17` (`trade-engine.js:120`). 17 is the length of an NFL regular season,
not the length of what is left of one. Both surfaces render it as "over the
season" (`client/src/components/TradeCard.tsx:109`,
`server/routes/trades.js:1055`).

In week 2 that charges a week already played and, worse, weeks this league will
never play: a fantasy season ends at its last playoff week, which
`leagueSchedule(lg)` (`trade-horizon.js:54`) already reads from the league's own
settings and which this file already uses one screen away for horizon weights.

The error is proportional and always in the same direction. At week 2 of a league
ending in week 16, 17 weeks are charged for 15; by week 10 it is 17 charged for 7
— the headline number is then more than double what the roster can still collect.

**Fix.**

```js
export function weeksLeftFor(lg, week) {
  const { playoffWeeks, regularSeasonEnd } = leagueSchedule(lg);
  const last = playoffWeeks?.length ? Math.max(...playoffWeeks) : regularSeasonEnd;
  return Math.max(1, last - Number(week) + 1);
}
```

All four `evaluate` call sites (twice in `findTrades`, `offerFor`, `offerForMany`)
pass it. A caller that does not gets `season_delta: null`, not a fallback, for the
same reason as Finding 1. `season_delta_weeks` is served beside it so a surface
can name the weeks it means instead of implying a season.

### Injections (`test/season-delta-remaining-weeks.test.js`, 7 tests)

```
### f2a  season_delta back to ppg_delta * GAMES
# tests 7   # pass 5   # fail 2
not ok 2 - the season figure is the weekly gain over the weeks that are left
not ok 4 - with no horizon given it reports nothing rather than a plausible number

### f2b  the null horizon replaced by a GAMES fallback
# tests 7   # pass 6   # fail 1
not ok 4 - with no horizon given it reports nothing rather than a plausible number

### f2c  the Math.max(1, …) floor removed
# tests 7   # pass 6   # fail 1
not ok 6 - the last week is never negative, and never zero
```

Test 1 pins that the fixture produces a weekly gain at all, so the horizon
assertions below it are not `0 === 0`. Test 6 is the one that matters most beyond
the headline: past the end of a league's season, an unfloored multiplier goes
negative and **flips the sign of every trade's season number** — a losing trade
would read as a winning one. Tests 3, 5 and 7 pass under all three injections and
cover the served `season_delta_weeks` field, a 16-week league, and an unsynced
league falling back to the app default rather than throwing.

---

## Not changed here, and routed rather than edited

`client/src/components/TradeCard.tsx:109` and `server/routes/trades.js:1055` both
still say "over the season" where they now mean the rest of it. The client file
belongs to the UI thread; `routes/trades.js` has no listed editor. Both are one
word each and both are routed, not taken.

---

## Is this well built

- **Well built:** yes. Both fixes are a named function replacing a literal at a
  call site, the smaller half of each being that the choice is now stated once
  where it can be read, rather than implied by an argument. Both reuse a definition
  the file already had (`structural_ppg`; `leagueSchedule`) rather than writing a
  second one.
- **Stats, or made up.** Finding 1 makes the served number **more** fitted, not
  less: it routes the graded residual onto the baseline it was graded against.
  Finding 2 replaces a hand-set `17` with a value read from the league's own
  settings. Still hand-set after this change and named so nobody mistakes it:
  `GAMES = 17` remains the divisor for `ros_ppg`, and the `Math.max(1, …)` floor
  is a choice, not a fit.
- **How we know.** Finding 1 is not an inference — `fantasy-coordinator.js:324`
  and `:519` state the target and the grading baseline in the source, and test 2
  pins that statement so the claim cannot rot. The exposure numbers are measured
  on a scratch rebuild, not estimated. Finding 2 is arithmetic against the
  league's own `leagueSchedule` output. **What is still untested:** whether the
  corrected coordinator number is more accurate in production. That needs a
  walk-forward over held-out weeks — refit the coordinator, then score
  `structural + correction` against `ensemble + correction` on weeks neither saw.
  Nothing here claims that result; the claim here is only that the served number
  now matches the one that was graded.
- **Pointed anywhere else.** `fantasy_coordinator` reaches the asset block and
  from there the trade card. The same base error exists at
  `fantasy-coordinator.js:571` (routed to the fantasy plan thread), and
  `fantasy_coordinator_refit` is a heavy-tier job (`scheduler.js:1339`) that runs
  only when `AUTO_HEAVY_SYNC=1` (`:1759`), so **this fix wants to be merged before
  that variable is set**, or the first refit trains against the wrong base.
  `season_delta` reaches both trade surfaces named above.
- **How it unifies.** One definition of what the coordinator corrects, and one
  definition of how long a fantasy season has left, each used by everything in
  this file that asks.
