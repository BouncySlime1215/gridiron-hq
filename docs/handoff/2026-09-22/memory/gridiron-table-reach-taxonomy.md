---
name: gridiron-table-reach-taxonomy
description: "The Auditor's three-way taxonomy for 'the code does not use table X' — not reachable / reachable-data-absent / reachable-predicate-dead — with the instances found on this project."
metadata:
  type: feedback
---
Adopted from Auditor R29, 2026-09-22. **Reporting format for every table claim in an Explorer package.**

1. **Not reachable on the path.** No executed statement, and no query referencing it exists in any module the run actually calls. No data can make it fire. — `nfl_snaps` (**128,146 production rows**), `nfl_injuries` (28,411), `nfl_depth` (0), on the weekly projection path.
2. **Reachable, data absent.** The code would fire; the table has nothing to give it. — `nfl_qbr_weekly` (574 production rows, **none in the 2021-2024 evaluation window**); on the rig it is a different miss again, short-circuiting at `nfl-qbr.js:129` because `players.espn_id` is NULL for all 1,140 rows.
3. **Reachable, data present, predicate dead.** The code fires, the data is there, a condition excludes all of it. — `news_items`: `trades.js:466` wants `importance = 3`, all 914 rows are 2.

**Why:** an execution trace proves a statement DID NOT run; it does not prove it CANNOT run. A guard on missing data looks exactly like an unreachable branch. Explorer published a package conflating classes 1 and 2 and had to correct it the same day.

**How to apply:** never write "table X is not read" without naming the class. **Class 1 with a large row count is the interesting cell** — `nfl_snaps` is 128,146 rows of present data the weekly projection cannot see, and that is an opportunity, not a gap. Class 2 findings are **conditional and need a registered expiry** [[gridiron-condition-b-lift-expiry]].

**WRITE-SIDE AXIS (Auditor R53.3, 18:03Z):** reach classes describe who READS a table; a second, independent axis describes what WRITES it — **own trigger** (a scheduled job with its own staleness check), **piggyback** (written only when another job's condition fires, e.g. the optional sources in `nfl-model-growth.js:76-98` under `finalized_week > 0 && (force || coreLag)`), **hand-run only** (`scripts/collect-league-transactions.mjs`), or **none**. The two axes compose: a route-reached table with a piggyback writer can be stale for weeks with every reader "healthy". Origin [[gridiron-state-1265-2026-09-22]], [[gridiron-optional-sources-never-trigger]].
