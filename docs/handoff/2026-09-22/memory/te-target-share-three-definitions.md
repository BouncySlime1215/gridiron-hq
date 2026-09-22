---
name: te-target-share-three-definitions
description: Three different quantities are all called "TE target share"; only the per-player-week one is what player_week_usage holds, and the corps figure overstates drift 5x.
metadata:
  type: project
---

Measured 2026-09-22 on nflverse `stats_player_week_<season>.csv`, REG only.
Script and output: `/mnt/project-files/te-share-defs-2026-09-22.mjs` / `.out`.

Three quantities were in circulation at once and two threads spent rounds
disagreeing about a number they were both measuring correctly:

| definition | 2022 | 2025 | who quoted it |
|---|---|---|---|
| A per-player-week, `>0` filter | 0.1070 | 0.1165 | the dead `positionalPriors` branch |
| **B per-player-week, zeros in** | **0.0963** | **0.1011** | **what production consumes** |
| C TE corps' share of team targets | 0.2144 | 0.2393 | the Explorer's "0.2115 -> 0.2449" |

`player_week_usage.target_share` is the nflverse column of the same name
(`nflverse.js:218`), so it is **B**. The corps figure **overstates the drift 2.3x
relative and 5.1x absolute** and may never be quoted as the size of this error.

**The composition effect is bigger than the drift.** Zero-target TE weeks went
0.1002 -> 0.1321 (+31.8%), and it decomposes exactly: `B = A x (1 - zero_share)`.
So A's +8.9% is partly more no-catch tight ends being carried, not role change.

**Why it matters:** the live prior is the literal `0.06` (`projections.js:547`),
1.69x below the 2025 population TE. The 5.1% drift is the small term; the 40.7%
level error is the finding.

See [[gridiron-planner-role-and-path-facts-2026-09-22]].
