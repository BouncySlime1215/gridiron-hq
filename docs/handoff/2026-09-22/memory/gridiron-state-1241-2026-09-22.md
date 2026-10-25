---
name: gridiron-state-1241-2026-09-22
description: "17:01Z fifth batch: Explorer's lineup-ordering package (80.19% starting-set change, proxy not the real ceilingLineup) and the 24-site replaySeasonWeekly routing table (3 wrong, 2 under-drawn, 2 head-only, 8 off); package.json → Wiring map for one line; Scheduler queue; deploy runbook on main"
metadata:
  type: project
  modified: 2026-09-22T17:02:30.000Z
---
- **Explorer package** `/mnt/project-files/PACKAGE-LINEUP-ORDERING-2026-09-22.md` (+ prereg LINEUP-ORDER-PREREG, LINEUP-lineup.*): 2024 wk5-18, 28,000 synthetic team-weeks per arm, seed 20260922. Starting-set change **80.19%** (draft-like pool 88.29%), mean swaps 1.311/1.633, FLEX 56.62%/59.78%, candidate-set 37.54%/47.40%. **Caveat: `ceilingLineup` itself never executed** (needs `leagues` rows) — a proxy of its `:54-62` selection step; the solver is not modelled. Explorer memory [[gridiron-lineup-ordering-changes]].
- **ROUTING TABLE** `/mnt/project-files/ROUTING-TABLE-REPLAY-CONFIG-2026-09-22.md`: 24 `replaySeasonWeekly` sites — **3 wrong** (`nfl-blind-audit.js:263` LIVE, `verify-qbr-integration.mjs:12-13`, `readdesign.mjs:81`); **2 faithful but 200/300 draws vs 2,000** (`promote-early-week-weights.mjs:369`, `fit-weekly-coverage.mjs:227`); **2 structural head only** (`player-head-validation.js:74`, `grade-feature-vector.mjs:156`); **8 deliberately off**. Axis 2 is partly determined by axis 1.
- **Ownership:** `package.json` → **Wiring map**, for the check:wiring one-line follow-up ONLY ([[gridiron-file-allocation]]).
- **Scheduler queue:** epoch-fallback-loud → refresh-lastline → #96; one full check at a time (ENOTEMPTY lesson).
- **Deploy runbook on main:** `docs/runbooks/deploy-654ff93.md`; first rollback = re-set the brake (`SCHEDULER_DISABLED=1`).
Prev [[gridiron-state-1240-2026-09-22]]. Next [[gridiron-state-1242-2026-09-22]].
