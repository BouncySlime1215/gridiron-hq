---
name: gridiron-state-1227-2026-09-22
description: "16:45Z: Explorer's R37 gate-1 structural-head answer — the harness/live gap from state 1226 is roleRecency defaulting to seasonDecay instead of production's WEEKLY_ROLE_RECENCY, a 2.8x-larger gap than the production read, invalidating the QBR verdict; sent to Auditor with three questions"
metadata:
  type: project
  modified: 2026-09-22T16:48:01.402Z
---
- **16:45Z Explorer**, R37 gate-1 (`PACKAGE-STRUCTURAL-HEAD-GATE1-2026-09-22.md`): structural head is **SAME CODE** (`buildProjections`) — the replay omits `roleRecency`. `weekly-backtest.js:94-98` has no default → `projections.js:453` falls back to **RECENCY** (`seasonDecay` 0.35 vs production's `WEEKLY_ROLE_RECENCY` 0.05 at `player-week-engine.js:271-274`; `weekHalfLife` null vs 5). Rig: 2024 wk5-18, 4,343 rows — bare 4.757 MAE vs production-setting 4.931 MAE, paired clustered diff **−0.1748 [−0.2199, −0.1282]**, mean |diff| **1.01 pts/player-week**, 531/532 players move. This is **2.8× the production-read gap** — the bare default flatters the model.
  - **Callers omitting the setting** (all affected): `nfl-blind-audit.js:263` (**LIVE**), `scripts/verify-qbr-integration.mjs:12-13` (source of the 4.749/4.751 QBR verdict → **invalid**), `fit-weekly.mjs`, `fit-shrinkage-weekly.mjs`. Four history heads checked, reimplemented but equivalent. **Which setting is correct is NOT established.** Memory: [[gridiron-replay-rolerecency-trap]]. `readdesign.mjs` probes added (rig: 0 NULL shares, 1,140/1,140 `espn_id` NULL).
  - **Sent to Auditor 16:47Z with three questions:** rider vs. amendment on prior grades; fix shape and owning thread; next unit. Explorer moves to the end-to-end serving check meanwhile.
Prev [[gridiron-state-1226-2026-09-22]]. Next [[gridiron-state-1228-2026-09-22]].
