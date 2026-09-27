---
name: gridiron-replay-is-not-the-live-path
description: "Measured 2026-09-22: replaySeasonWeekly executes 3 statements over 4 tables; the live buildPlayerWeekEngine executes 28 over 23. The backtest harness does not model the shipped projection."
metadata:
  type: project
---
Explorer, 2026-09-22. One process, one database (`a6/rig.sqlite`), one instrument wrapping `db.prepare`. Package `/mnt/project-files/PACKAGE-SNAPREACH-LIVE-VS-REPLAY-2026-09-22.md`, prereg `SNAPREACH-PREREG-2026-09-22.md`, trace `SNAPREACH-snaptrace.mjs`, output `SNAPREACH-snapreach.out`.

| | A: `replaySeasonWeekly(2024)` | B: `buildPlayerWeekEngine({season:2024,week:10})` |
|---|---|---|
| distinct statements | **3** | **28** |
| tables | **4** | **23** |

A's four: `player_week_usage`, `shrinkage_fits`, `nfl_player_week_features`, `players`.
B reads per player, and A reads not at all: `nfl_learning_epochs` (1088x), `nfl_engine_artifacts` (1086x), `game_lines` (1086x), `nfl_news_signals` (1086x). Plus `player_week_snaps` `offense_pct` once, via **`role-changepoint.js:49`**.

**REGISTERED QUESTION (`nfl_snaps`) ANSWERED: reading 2, class 1 on BOTH paths.** B's one `nfl_snaps` statement is a CENSUS — `nfl-engine-registry.js:38`, `SELECT COUNT(*) rows, COALESCE(MAX(week),0) through_week` — in a block that counts nine tables identically. It counts rows, never reads `offense_pct`. So the 128,146 production rows serve the betting and team-card sides; the fantasy weekly projection cannot see them, live or replayed. `nfl_depth`, `nfl_injuries`, `nfl_ngs`, `nfl_pfr_adv` appear in B **only** in that same census.

**EXPLORATORY, NOT TESTED** (found by a trace built for another question): if the live projection consumes news signals and game-line timing and the replay does not, what has every backtest on this project been grading? Needs its own registered unit before anyone acts on it.

**CRITICAL CAVEAT:** on the rig, `player_week_snaps`, `nfl_news_signals`, `game_lines` and `nfl_engine_artifacts` are all **0 rows**. Every statement executed and returned nothing. **Reachability proven, behaviour not.** `player_week_snaps`'s production count is unknown and is on the next-production-read query list.

**Only `buildPlayerWeekEngine` was traced.** `ros-projection.js`, `season-sim.js`, `ceiling-lineup.js` untraced; this bounds nothing about them. One season, one week (2024 w10).

[[gridiron-table-reach-taxonomy]] [[gridiron-weekly-replay-reads-only-four-tables]]
