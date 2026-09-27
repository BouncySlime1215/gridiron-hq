---
name: gridiron-replay-may-not-grade-the-shipped-model
description: The backtest replay executes 3 statements over 4 tables while the live projection path executes 28 over 23, so every MAE figure in this project may describe the replay's predictor rather than the shipped one — unresolved as of 2026-09-22.
metadata:
  type: project
---

Explorer's exploratory finding, 2026-09-22 16:37Z; auditor §R37.

`replaySeasonWeekly(2024)` runs **3 statements over 4 tables**
(`player_week_usage`, `shrinkage_fits`, `nfl_player_week_features`, `players`).
`buildPlayerWeekEngine({season:2024, week:10})` runs **28 distinct statements
over 23 tables** for 1,086 entries, reading per player `nfl_learning_epochs`,
`nfl_engine_artifacts`, `game_lines` (gameday, gametime), `nfl_news_signals`
(verified, published_at-bounded) and `offense_pct` from `player_week_snaps`
(`role-changepoint.js:49`).

**Why it matters:** if the replay grades a different predictor than production
serves, then every MAE figure this project has produced describes the replay's
predictor — the 0.0632 shipped-vs-control gap, the 4.7233/4.4867 early-week
figures, the ceiling bracket, all of it. **Not established; not disproved.**

**THE UNIT IS ONE COMPARISON, not a general trace.** The four history heads are
arithmetic over `priorWeeks` and cannot differ if inputs match; `structural`
carries 0.40-0.80 of the weight by position. So: **does the replay's `structural`
equal production's for the same player-week?** Gate 1 is cheap and offline —
**does `replaySeasonWeekly` obtain `structural` by calling the same code
production calls, or a reimplementation?** A reimplementation is itself the
finding, with no production read needed.

**The rig CANNOT answer it.** `player_week_snaps`, `nfl_news_signals`,
`game_lines` and `nfl_engine_artifacts` are all 0 rows there — the rig's
blindness is exactly co-extensive with the difference in question. Sixth
blindness. The data half needs production or the local dev database.

**Two consequences already applied.** (1) Every rig result carries one line until
this resolves: *it grades the replay predictor, whose equivalence to production's
is unestablished.* Grading is NOT frozen. (2) The 2026-09-22 production read ran
`replaySeasonWeekly` over production DATA, so it measured **the replay predictor
on production rows, not production's predictor** — which also explains why
production reproduced the rig arm for arm (WR differing by 0.0002): same code,
similar rows, not a resemblance between rig and production models.

Fourth fit-serve mismatch found that day, after Plan 01's injuries, the kicker's
pooled prior and the early-week weights. Related:
[[gridiron-offline-rig-evidence-line]], [[gridiron-table-reach-taxonomy]].
