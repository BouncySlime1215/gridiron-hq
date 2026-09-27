---
name: gridiron-state-1229-2026-09-22
description: "16:49Z: Release merges #102 (docs-only, main advances to 140d436b); Explorer issues an URGENT CORRECTION withdrawing the roleRecency-trap finding — it's deliberate design, not an omission bug; two real defects survive"
metadata:
  type: project
  modified: 2026-09-22T16:53:05.483Z
---
- **16:49Z Release: #102 MERGED.** `main` = **140d436bc3046c24735514c731bde4841c6783e5** (docs-only, 9 files incl. `CLAUDE.md`; CI green on 3a2afa2). Nick told.
- **16:49Z Explorer, URGENT CORRECTION to the roleRecency finding** ([[gridiron-state-1227-2026-09-22]]): **NOT a trap — deliberate design.** `shrinkage-fit.js:500-517` (guard `isWeeklyRoleRecency` `:495` / `activeKVectorFor` `:516`; `projections.js:461`) shows a bare replay call is a coherent SEASON-LONG configuration, not an omission; the 0.175 MAE gap is the distance between two intended configurations. Already known and handled: `scripts/fit-weekly-coverage.mjs:47-56` has a `production()` helper (`:72-75`) that is the correct fix shape. `replayImpl` has no `kOverride` default because the bare call **is** production-correct for that configuration; an explicit `roleRecency` selects a different, hand-picked constant set.
  - **Surviving real defects:** `scripts/verify-qbr-integration.mjs:12-13` (QBR verdict 4.749/4.751 measured in the wrong configuration) and `nfl-blind-audit.js:263` (live, same issue). Production serves `WEEKLY_ROLE_RECENCY` hardcoded at `player-week-engine.js:273`, 11 callers, no override.
  - **Still OPEN:** ceiling-lineup mixes a weekly cutoff with season-long recency — two comments disagree (`shrinkage-fit.js:507` vs `ceiling-lineup.js:55-62`); live at `routes/trades.js:655`.
  - Full 26-site callers table in the original package [CORRECTED 17:03Z: 24 rows, not 26 — comment-only grep hits]. Memory [[gridiron-replay-rolerecency-trap]] corrected in place.
Prev [[gridiron-state-1228-2026-09-22]]. Next [[gridiron-state-1230-2026-09-22]].
