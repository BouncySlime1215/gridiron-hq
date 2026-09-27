---
name: playoff-odds-skip-k-and-def
description: The season simulator that produces playoff and title odds never simulates kickers or defences, so its weekly totals are missing two starters and its spread is narrower than real league scoring.
metadata:
  type: project
  modified: 2026-09-19T21:08:45.713Z
---

Found 2026-09-19 by the UI-rebuild thread while checking a different claim.
Verified in source on main; branch line numbers differ.

`season-sim.js` is skill-only, in two places that agree with each other:

```js
:31   const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);
:92   if (!SCORED.has(slot)) continue;           // K/DEF slots dropped from the lineup
:187  const roster = [...].filter(p => SCORED.has(p.position));   // K/DEF dropped from the pool
```

**All five of Nick's leagues start a K and a DEF.** So every simulated weekly
total is missing two starters, on both sides of every matchup.

**This is DELIBERATE, not an oversight.** The filter is really one level up, in
`trade-engine.js#lineupSlots` (`:305` on main), which drops any slot not in
`SCORED` from the league's own `roster_positions` — a helper shared with the
trade engine's lineup optimiser. Its reason is stated at `trade-engine.js:49-50`:
"Positions we model. K and D/ST are near-random week to week and roughly
interchangeable, so including them adds noise to every lineup comparison."
Do not file this as a defect. The modelling scope is defensible; what is
missing is any surface SAYING it, which is why Start/Sit shows no kicker or
defence slot and never explains that it does not.

**What this does and does not imply.** Both teams lose the same two slots, so the
head-to-head comparison is not obviously biased. What changes is the *shape*: K
and DEF carry real week-to-week variance, so the spread the odds are computed
from is narrower than the league's actual scoring. A narrower spread makes
favourites look safer and underdogs look deader than they are. **Not measured** —
nobody has quantified how far the odds move, and the direction above is reasoning
from the missing variance, not a measurement. Do not quote a magnitude.

It does **not** invalidate tonight's before/after fit readings: the same
simulator runs on both sides, so the delta is still the delta.

**A related non-finding, recorded so it is not re-found as live.**
`season-sim.js:210` (`:226` on branch) is `activeChance.get(p.id)
?.active_probability ?? 0.92`, which looks like the same hardcoded-constant
defect as [[availability-unfitted-positions]]. It is not reachable for K/DEF —
the `:188` filter removes them from the loop three hundred lines earlier — and
`weeklyAvailability` covers every skill row in `players`, so it is close to
unreachable for anyone. The wiring-map thread's constant-finding rule flags it;
it is a true hit and a non-finding.

**The general lesson**, which is the second time tonight: a constant's
reachability is not decidable from its own line. Both the `?? 0.9` in
`lineup-brain.js` and this one die to code far away — a threshold in one case, a
filter in another. Read the callers before calling a hit a defect.

See [[availability-unfitted-positions]] and [[basis-fields-served-never-rendered]].
