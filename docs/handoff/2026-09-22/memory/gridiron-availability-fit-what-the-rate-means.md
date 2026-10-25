---
name: gridiron-availability-fit-what-the-rate-means
description: The Gridiron HQ fitted availability rate measures RECORDED USAGE, not playing — why the designation band collapses, and the K/DEF claim that was retracted in full.
metadata:
  type: project
---

Part of [[gridiron-availability-fit]]. Verified on `origin/main` **791b131**.

## The fitted rate is NOT "chance of playing"

Its event is **recorded usage** — a target, a carry or an attempt —
deliberately not "dressed" (`fit-availability.mjs` header, "WHAT 'AVAILABLE'
MEANS HERE"), because a player who suits up and touches the ball zero times
scores zero and this number feeds a projection. The script warns this puts its
levels **below** published "percent who played" figures, and the gap is
largest for exactly the players carrying a designation.

So the designation band's collapse on fit day (constants hold Doubtful at 0.15
against a measured ~0.004, Out at 0.01 against ~0.001) is **expected and partly
definitional**, not the model breaking: 0.004 is how often a Doubtful player
records a touch, while 0.15 was a hand-set guess at whether he suits up. **The
designation band is the only one that moves DOWN.**

The app's label was wrong in exactly this way and is fixed in the shipped
train: "likely to play" -> **"likely to suit up and see the ball"**, in
`lineup-brain.js` (#27) and the waiver footnote (#21). True on every basis,
since the durability prior behind the constants path is also a usage rate.

Two quantities that are easy to conflate, both per player on
`weeklyAvailability`: `active_probability` (this week, injury report and role
folded in) and `durability_prior` (`contingency.js:911`) — the base prior from
`availability()` (`:40`), games with recorded usage over tenure x 17. The
"% of weeks" figure is the **prior**, not the fitted rate, and it is not
forwarded to Start/Sit.

## RETRACTED IN FULL: the K/DEF 0.92 prices nothing

This session claimed the deploy "inverts a K/DEF availability bias"
(relatively over-valued by ~11 points today, under-valued by ~3 after), then
retreated twice to narrower versions. **All wrong.**

`sched` is gated on `SCORED.has(p.position)` (`trade-engine.js:334`), so K and
DEF take the fallback at `:336-337` whose `games` is `[]`. So `thisGame` is
null (`:348`) and `currentWeekPpg` is **0** (`:359`) — the 0.92 multiplies
zero. `decisionPpg = 0.25*0 + 0.75*rosPpg` (`:385`) and `rosPpg` has no
availability term, so **trade value never sees it**.
`lineup-brain.js:279` is `p.current_week_ppg ?? ...` and 0 is not nullish, so a
kicker's `week_points` is **0**, not 0.92-scaled.

**Stronger, verified on main:** a K or DEF cannot appear on the Start/Sit bench
list at all — `lineup-brain.js:426` filters
`(p.week_points ?? 0) > 0`, and theirs is 0. The swap list filters the same way
(`trade-engine.js:2824`), and `projections.js:292` excludes them from having a
weekly projection in the first place. **So a kicker on the Start/Sit bench list
would be a FINDING, not the expected case.** (Found by the wiring-map thread;
verified here.)

`active_probability: 0.92` (`trade-engine.js:464`) is the only place the
constant survives into a response — a display field with nothing behind it.

**Never put "K and DEF stay at 0.92" in an after-read list** — true,
meaningless, and it reads as a passing check.

Still true: `buildAssetUniverse` selects every row of `players` with no
position filter (`:324`) and K/DEF do get `?? 0.92` at `:346`. What it reaches
was the wrong part. *Evidence note:* this was found on the OLD main
(`ffe4e72`), whose fallback has no `games` key at all; on the shipped tree it
carries `games: []`. Same conclusion, different snippet — do not dismiss the
retraction because the quote does not reproduce.

See [[verify-the-consumer-not-the-producer]].
