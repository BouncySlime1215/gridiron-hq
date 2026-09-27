---
name: gridiron-ceiling-lineup-config-divergence
description: The My Team ceiling/floor lineup is built from a different projection configuration than the weekly projections, so the two surfaces disagree about the same player-week; ruled a bug 2026-09-22, fix assigned to UI.
metadata:
  type: project
---

`ceiling-lineup.js:62` calls `buildProjections({through: season, throughWeek: week-1, scoring})`
— a mid-season WEEKLY cutoff with NO `roleRecency`, so it runs the season-long
configuration. `player-week-engine.js:271-273` makes the identical call plus
`roleRecency: WEEKLY_ROLE_RECENCY`. Two surfaces, one player-week, different central
estimates, rendered at `routes/trades.js:655`.

**Ruled a BUG, not a classification (auditor R42.2, 2026-09-22), and it does not need the
two disagreeing comments arbitrated:** `shrinkage-fit.js:503-509` withholds the volume k
from SEASON-BOUNDARY callers and gives that as its reason, and `:507` lists ceiling-lineup
in that class — but ceiling-lineup uses a weekly cutoff, so the classification fails
shrinkage-fit.js's own criterion. `ceiling-lineup.js:54-61`'s claim that it is "built from
the same current information the rest of the app has" is false as written: the cutoff is
mirrored, the information weighting is not. See [[gridiron-replay-config-axes]].

Fix assigned to UI: pass the weekly configuration, correct the :54-61 comment, and the
coupled one-line fix to `shrinkage-fit.js:507` (different file, different editor — neither
merges claiming the other half is done). **The RED must pin the PROPERTY, not the call:**
that ceiling-lineup's projection for a given (player, season, week) EQUALS the weekly
engine's. Pinning that the argument is passed pins the implementation and survives a
refactor that breaks the guarantee. It is a user-visible behaviour change, so the PR body
and the deploy step both say lineups will move; deploy stays Nick's word.

**NO SELECTION-CHANGE RATE TRAVELS TO NICK (R45.3).** Explorer measured 80.19% of 28,000
synthetic team-weeks changing starters — but on the `'mean'` objective, while
`ceiling-lineup.js:145` and `routes/trades.js:661` make **`'ceiling'` the live default**,
and with a greedy solver where the shipped one is a one-substitution local search on
`hit_probability` at 3,000 draws (`:185-205`). Worse, the ceiling objective's **target is
self-referential** (built from the same
projections): the default bar is `r2(naiveScore.ceiling)` = the 90th percentile of the
highest-mean lineup, scored on the same draws (`:179-181`, `:132`). The `:141-142` docstring
("a stretch above the team's own median") is STALE; the auditor cited it in R45.3 and was
corrected in R49.1. A configuration change moves the pool, the reference lineup AND the bar
together, so the rate is **not bounded by the 'mean' arm in either direction**. What is supportable for Nick is
qualitative: the two surfaces disagree, and the disagreement reaches which players start.

Open after the fix, neither blocking: the self-referential target; and `ceilingLineup`
cannot be executed on the rig at all (`:148` needs a `leagues` row; rig has 0 leagues and
0 `roster_players`), so every figure about it so far is a proxy.
