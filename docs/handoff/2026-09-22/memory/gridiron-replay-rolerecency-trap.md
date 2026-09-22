---
name: gridiron-replay-rolerecency-trap
description: "CORRECTED 16:49Z: NOT a trap — deliberate design (shrinkage-fit.js:500-517). A bare replaySeasonWeekly call is the coherent SEASON-LONG configuration; the 0.175 MAE gap is the distance between two intended configurations, not a missing-default bug. Surviving real defects: verify-qbr-integration.mjs and nfl-blind-audit.js measure/serve in the wrong configuration."
metadata:
  type: project
  modified: 2026-09-22T16:51:38.795Z
---
**CORRECTED 16:49Z** — the original framing (bare call = accidental omission bug, recorded in [[gridiron-state-1227-2026-09-22]]) was WRONG. Full correction: [[gridiron-state-1229-2026-09-22]].

`shrinkage-fit.js:500-517` documents the split deliberately; `isWeeklyRoleRecency` (`:495`) + `activeKVectorFor` (`:516`) are a real guard — under non-weekly recency the fitted volume-k entries are withheld, so season-long callers keep the constants they were validated with. `projections.js:461` routes every `kOverride === undefined` call through it. **A bare replay is the coherent SEASON-LONG configuration, not a broken harness.** The 0.175 MAE gap measures weekly-vs-season-long, not an omission.

Fix shape already exists: `scripts/fit-weekly-coverage.mjs:47-56`/`:72-75` has a `production()` helper returning `{kOverride: undefined, roleRecency: WEEKLY_ROLE_RECENCY, predictionHead}` — one script solved this locally, nobody lifted it elsewhere.

**Surviving real defects** (callers claiming weekly-production fidelity while omitting `roleRecency`): `scripts/verify-qbr-integration.mjs:12-13` (its 4.749/4.751 QBR verdict, quoted at `projections.js:254-260`, was measured in the wrong configuration) and `server/services/nfl-blind-audit.js:263` (live). Production's weekly number serves `WEEKLY_ROLE_RECENCY` unconditionally, hardcoded at `player-week-engine.js:273`; that is the only `buildProjections` call site in the server passing `roleRecency` at all — ~11 other callers pass only season/week/scoring.

**Still OPEN:** `ceiling-lineup` mixes a WEEKLY cutoff with SEASON-LONG recency — `shrinkage-fit.js:507` vs `ceiling-lineup.js:55-62` disagree on whether that's right. Live at `routes/trades.js:655`. Undecided.
