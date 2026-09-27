---
name: gridiron-name-the-table-rule
description: Fleet rule (proposed 18:10Z, adopt unless the Auditor objects) — every data claim names the exact table and the exact writer function, never the concept, because this codebase has near-homonym pairs that behave differently
metadata:
  type: feedback
  modified: 2026-09-22T18:12:00.000Z
---
**Why:** Explorer's optional-sources package claimed role detection was exposed to stale "snaps"; `role-changepoint.js:49` actually reads `player_week_snaps` (scheduled, player_id-keyed, offense only), not `nfl_snaps` (unscheduled, name-keyed, keeps defense/ST) — the same nflverse CSV ingested twice by two different functions. The claim was withdrawn ([[gridiron-state-1266-2026-09-22]]). The earlier "nfl_depth has a second writer" claim died the same way: `syncDepthChart` (routes/nfldata.js, writes `roster_players.depth_*`) is not `syncDepthCharts` (nfl-model-growth, writes `nfl_depth`).

**Known near-homonym pairs (extend as found):** `nfl_snaps` / `player_week_snaps`; `syncSnaps` (nfl-advanced.js:174) / `syncSnapCounts` (nflverse.js:270); `syncDepthCharts` / `syncDepthChart`; `nfl_injuries` two writers (scheduler.js:826-831 vs nfl-model-growth).

**How to apply:**
1. A claim about data freshness, reach or writers names the TABLE (`nfl_snaps`), the WRITER function with file:line, and the READER with file:line — never "snaps", "depth", "injuries".
2. Before asserting "X reads stale Y", open the reader and quote the table name from its SQL.
3. When two functions share a stem, the package lists both and says which one the claim is about.
4. Pairs with [[gridiron-table-reach-taxonomy]] (reach + write-side axes) and [[a-grep-finds-a-pattern-not-a-shape]].

**ADOPTED AS FLEET RULE — Auditor R54.5, 18:25Z:** name the table AND the writer function verbatim with file:line, every time. The Auditor was its own latest violator (its R53.2 scope line, withdrawn in R54.4). [[gridiron-state-1269-2026-09-22]]
