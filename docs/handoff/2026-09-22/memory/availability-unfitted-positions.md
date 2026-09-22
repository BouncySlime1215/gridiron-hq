---
name: availability-unfitted-positions
description: The hardcoded 0.92 chance to play for kickers and defences is reachable but INERT — it multiplies a quantity that is already zero for those positions — after three successive wrong claims that it priced something a user sees.
metadata:
  type: project
---

Found 2026-09-19 by the UI-rebuild thread; corrected twice the same evening.
**Verified on main ffe4e72. Line numbers differ on every train branch — four
wrong handoffs tonight came from citing another tree's numbers. Re-take them.**

## The shape of it

`contingency.js#weeklyAvailability` selects
`WHERE p.position IN ('QB','RB','WR','TE')`, so K and DEF are absent from its
Map. `trade-engine.js#buildAssetUniverse` loops `FROM players p` with **no
position filter**, so `:181` falls back:
`const activeProbability = availability?.active_probability ?? 0.92`, and
`:243` publishes it as `active_probability`.

## Why it is inert (the correction that matters)

`activeProbability` multiplies exactly one quantity:

```js
:176  const sched = p.team_abbr && SCORED.has(p.position)
:177    ? scheduleOutlook(p.team_abbr, p.position, target.week)
:178    : { sos: 1, playoff_sos: 1, bye: null, best: [], worst: [], playoff_games: [] };
:186  const thisGame = sched.games?.find(g => g.week === target.week) ?? null;
:193  const currentWeekPpg = thisGame ? currentWeekBasePpg * thisGame.mult * activeProbability : 0;
```

**The K/DEF fallback object has no `games` key.** So `thisGame` is null and
`currentWeekPpg` is 0 for every K and DEF: the 0.92 multiplies zero. Trade
value is untouched too — `decisionPpg = 0.25*0 + 0.75*rosPpg`, `rosPpg =
weeklyPpg * sos` with `sos` 1. The published `active_probability` is a display
field with nothing behind it.

## Three claims retracted, all mine, all the same mistake

1. *"It feeds the points K/DEF are ranked on."* No — `lineupSlots`
   (`:305`) drops K/DEF slots, deliberately and with a comment at `:49-50`
   (`:123-124` on the wiring-map branch): "K and D/ST are near-random week to
   week... including them adds noise to every lineup comparison."
2. *"A kicker still sits on the Start/Sit bench list."* No. lineup-brain builds
   its own bench from the unfiltered roster but on
   `base = p.current_week_ppg ?? p.adj_ppg ?? p.ppg ?? 0`, and
   `current_week_ppg` is **0, not null**, for a K — so `week_points` is 0 and
   `bench = startable.filter(p => ... && (p.week_points ?? 0) > 0)` drops it. A
   kicker is treated exactly like a player on bye, which lineup-brain's own
   comment spells out.
3. *"A kicker's trade value is priced on it."* No, per the section above.

Also retracted: the `?? 0.9` in lineup-brain's warnings map is dead code —
`risky` filters `(active_probability ?? 1) < 0.75` and a K arrives carrying
0.92. And the "fit flips the sign of the bias, ~11 points over to ~3 under"
framing, which assumed the 0.92 priced something. It does not.

**The lesson, now three times in one evening:** a constant's reachability is
not decidable from its own line. One died to a threshold, one to a slot filter,
this one to a missing `games` key. Read every caller and every downstream zero
before calling a constant a defect.

## What actually survives, and it is the better finding

The Start/Sit page covers **two fewer starters than the user's lineup has**,
shows them nowhere, and says nothing about it. All five leagues start a K and a
DEF. The modelling scope is defensible; its silence is not. That one line on
the page is the deliverable, in the same PR as the per-row basis.

See [[playoff-odds-skip-k-and-def]] and [[basis-fields-served-never-rendered]].
