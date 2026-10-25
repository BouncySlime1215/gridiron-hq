---
name: gridiron-condition-b-lift-expiry
description: "The Condition B lift on the production read expires if nfl_qbr_weekly is ever backfilled into 2021-2024; plus the 572-vs-574 gap and the fact that nfl-qbr.js's 5,294-row crosswalk was measured on a database nobody here can reach."
metadata:
  type: project
---
2026-09-22, Explorer, answering Auditor R29. Package `/mnt/project-files/CONDITION-B-DISCRIMINATING-CHECK-2026-09-22.md` (follow-ups section at the end).

**EXPIRY TRIGGER — the lift is conditional on DATA, not on code.**
`SELECT COUNT(*) FROM nfl_qbr_weekly WHERE season BETWEEN 2021 AND 2024` must return **0** on production. If it ever does not, the production read's shipped and control arms must be re-run: `qbrAdjustment` is no longer provably 0 in-window and the 0.0632 pooled gap is no longer a clean comparison. Nothing in the codebase announces this. Also expires if `SELECT COUNT(espn_id) FROM players` stops being 0 on the rig. **Third standing condition on this rig, beside `SCHEDULER_DISABLED=1` and Condition B's five blind spots.**

**572 vs 574 — UNLOCATED, deliberately not explained away.** `projections.js:254-260` (dated 2026-09-17) accounts for 540 (2025) + 32 (2026 w1) = 572. Production read 574 on 2026-09-22. The read printed only `COUNT(*)`. **If either of the two is in 2023 or 2024 it is a counterexample to the verdict.** Inference only, not measurement: a 2026 week is ~32 rows so two is too few for a new week, and a 2021-2024 backfill would arrive in thousands — most consistent with an ESPN correction or a stale-team sibling (`nfl-qbr.js:26-37`). Settled at the next production read: `readdesign.mjs` now prints qbr-by-season, qbr 2021-2024, the espn_id crosswalk count and players-with-espn_id automatically.

**`nfl-qbr.js:124`'s "5285/5294 rows match players.espn_id" was measured on the LOCAL DEV DATABASE (Auditor R32).** `server/data.sqlite` is the default: `db/index.js:10` resolves `GRIDIRON_DB_PATH || server/data.sqlite`, `.gitignore:11-13` excludes it (ESPN cookies, personal rankings), `db/index.js:36-40` notes its WAL hitting ~3.3 GB. The figure is REAL, just not reproducible here; "local dev database, not reproducible" is an acceptable citation. **THE FINDING: local ~5,294 QBR crosswalk rows vs production's 574, about 9x — a PRODUCTION QBR BACKFILL THAT NEVER RAN.** On the opportunity list as one.

Original (over-stated) form of the same point: Production has 574 `nfl_qbr_weekly` rows; the rig has **0**, and 0 of 1,140 players carry an `espn_id`, so the join matches 0 there. The file names its own measurement database one comment earlier — `server/data.sqlite`, `nfl-qbr.js:26-37` — and **no such file exists in the repo or any checkout here**. The crosswalk claim is not wrong, it is **unreproducible** — the same word `projections.js:254-260` already uses for the `QBR_SIGNAL` fit itself. **Two load-bearing numbers in this one signal's paper trail were measured on the local dev database.** Rule, fifth instance today: **a comment asserting a measured fact must name the database.**

[[gridiron-table-reach-taxonomy]] [[gridiron-weekly-replay-reads-only-four-tables]] [[gridiron-no-read-only-path-to-the-production-db]]
