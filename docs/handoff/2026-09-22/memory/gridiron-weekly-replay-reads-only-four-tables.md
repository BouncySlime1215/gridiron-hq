---
name: gridiron-weekly-replay-reads-only-four-tables
description: replaySeasonWeekly executes just 3 SQL statements over player_week_usage, shrinkage_fits, nfl_player_week_features and players — it never reads nfl_snaps, nfl_injuries, nfl_qbr_weekly or nfl_depth, so Condition B is lifted for weekly-blend comparisons.
metadata:
  type: project
---

Measured by the Explorer 2026-09-22 (Auditor R25.1), by EXECUTION not by
grep. Script `/mnt/project-files/tabletrace.mjs`, write-up
`CONDITION-B-DISCRIMINATING-CHECK-2026-09-22.md`. Cited lines are identical on
654ff933 and origin/main 1a136145 (empty diff over the replay path).

**NEVER answer "does this path read table X" with the import graph.** The
transitive import closure of `weekly-backtest.js` is **205 files** and reaches
routes, `player-week-engine.js`, `contingency.js` and `nfl-availability.js`.
Grepping it returns 37/81/14/42 references for snaps/injuries/QBR/depth and is
entirely misleading.

**The method that works:** patch `db.prepare` on the repo's single connection
*before* importing the services, wrap each statement's `all`/`get`/`run`, and
record SQL only while a flag is on. Prepared-at-import but never-executed then
does not count. `rows`/`row`/`run` all funnel through `db.prepare`
(`server/db/index.js:240-248`), so one patch catches everything.

**The result.** `replaySeasonWeekly(2024)`, 4,343 graded player-weeks,
**3 distinct SQL statements executed**, touching only `player_week_usage`,
`shrinkage_fits`, `nfl_player_week_features`, `players`. **None of nfl_snaps,
nfl_injuries, nfl_qbr_weekly, nfl_depth.** The two feature tables are written
from play-by-play (`nfl-pbp.js:577`) and nflverse weekly stats
(`nflverse.js:243`), not from the snaps/injuries store — so there is no
indirect path either. (`nfl-weekly-feature-store.js:134,142` does read snaps
and injuries, but builds TEAM-week features for a different consumer.)

**CONDITION B IS LIFTED for weekly-blend comparisons on the replay path, and
ONLY for those.** It stands in full for anything routed through
`player-week-engine.js` — the live engine, which is where `nfl_depth` is read
(`player-week-engine.js:517`) and where `contingency.js:890` reads injuries.

**So production's `nfl_depth = 0` does not touch the weekly projection.** It is
an offseason, rookie, roster-strength and live-engine gap:
`offseason-model.js:179,300,470`, `offseason-data.js:984,986`,
`nfl-rookies.js:155`, `nfl-roster-strength.js:85,372`,
`nfl-player-value.js:196`, `preseason-model.js:239`.

**QBR is empty where it matters.** `projections.js:254-260` records 540 rows
for 2025, 32 for 2026 week 1, **nothing for 2021-2024** (572; production reads
574 today). Any 2023-2024 evaluation has no QBR to read.

**CORRECTION, same day — "NOT READ" meant two different things.**
`nfl_qbr_weekly` IS on the path and **would fire on a database with
`players.espn_id` populated**. It was not queried on the rig only because
`players.espn_id` is **NULL for all 1,140 players (135 QBs, 0 with one)**, so
`qbrTrailingForPlayer` returns at `nfl-qbr.js:129` before preparing either
query. `nfl_snaps`, `nfl_injuries` and `nfl_depth` are different: **no query
referencing them exists in any module the replay calls**, so no data can make
them fire. The verdict stands anyway — `projections.js:254-260` records no QBR
rows for 2021-2024, so the adjustment is 0 in the read's window regardless.

**THE RULE THIS TEACHES:** an execution trace proves a statement **did not
run**; it does **not** prove it **cannot** run. A guard on missing data looks
exactly like an unreachable branch. Separating them takes reading the guard.

**FIFTH RIG BLINDNESS, newly recorded:** beyond the four empty tables,
**`players.espn_id` is entirely NULL on the rig**, silently disabling the QB
QBR nudge. Any rig unit on a path keyed to ESPN ids inherits it.

**WAS OPEN, NOW RESOLVED (kept so nobody re-opens it):** `QBR_SIGNAL` is `{enabled: true, k: 0.073, ...}`
(`projections.js:272`, default at `:447`) yet `nfl_qbr_weekly` was never
queried across 486 graded QB player-weeks. Gate at `:689`. Needs the tracer
re-run with a per-branch counter before anyone calls it a dead path.

Related: [[gridiron-offline-measuring-rig-2026-09-22]],
[[gridiron-no-read-only-path-to-the-production-db]].
