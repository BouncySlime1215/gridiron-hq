---
name: gridiron-availability-fit-what-it-writes
description: What scripts/fit-availability.mjs writes to the live Gridiron HQ database, the gate it must pass, and how to undo it.
metadata:
  type: project
---

Part of [[gridiron-availability-fit]]. Line numbers verified on `origin/main`
at **791b131** (the shipped train), 2026-09-19 21:25Z.

**It CAN be run.** An earlier version of this note said it could not, because
the script was thought absent from the machine. Nick's read-only probe at
20:58Z showed `fit-availability.mjs`, `fit-posture-calibration.mjs` and both
promote scripts are present. (`verify-trade-brain-live.mjs` is the only one
missing.) There is no HTTP route that runs it; it is a shell step.

**Writes two tables, nothing else.**
- `nfl_availability_rates` (~139 rows): league rate per injury-report status,
  league rate per status x practice cell with n>=30, one shrunk rate per
  team x status. Fit on 2021-2024.
- `nfl_availability_role_rates` (~871 rows): report group x practice x
  position x snap-share tier x games-missed bucket. Written **only** if the
  pre-registered gate passes on held-out 2025. A failed gate writes zero role
  rows and clears any left over.

One transaction, ROLLBACK on error. `FIT_SEASONS = [2021,2022,2023,2024]`,
`TEST_SEASON = 2025` (`fit-availability.mjs:48-49`); the fit never reads 2026.
Positions are `QB,RB,WR,TE` only (`:249`).

**The gate** (written 2026-09-18, before any 2025 number for it existed) needs
ALL of: log loss improved with a player-clustered bootstrap 90% interval below
zero; 10-bin calibration error improved; Q/D/Out rows no more than 0.01 worse.
Plus G2 per designation x role cell with n>=50. **#37 (gate v2) is in the
shipped train**, so a run executes v2's restructured per-cell veto — its
numbers are NOT comparable to any v1 figure.

**`--dry-run --report=path.json` prints every gate number and writes nothing.**
The report is written at `:396`, before the dry-run exit at `:408`, so the two
flags combine. Non-skippable before a real write.

**Landing on `pooled` means the gate failed and the role table was left empty
deliberately — a legitimate outcome, not an error.**

**After a write:** stamp goes `absent|absent` -> `139:<ts>|871:<ts>`, basis
goes `constants` -> `role`. A healthy starter moves from **0.805** (constants)
to **~0.952** (role) against an actual 94.5%.

**Undo.** The cleanest rollback available, because neither table exists today:
nothing to preserve, nothing to back up.
`DROP TABLE nfl_availability_rates; DROP TABLE nfl_availability_role_rates;`
restores current behaviour exactly. **Do not DELETE the rows** — empty tables
are a state the app has never been in, and `absent` is the true prior state.
No restart either way: `fittedAvailability()` (`contingency.js:559`) re-reads
whenever `availabilityFitStamp()` (`:547`) changes.

**Prerequisites verified live 19:40Z:** `nfl_injuries` 5,348 / 5,449 / 5,451 /
5,952 / 5,783 for 2021-2025; `nfl_snaps` ~25,300 a season. See
[[gridiron-live-data-state]].

**Two release notes.** Separate process, so it will not block the event loop,
but it scans five seasons and runs a 2,000-draw bootstrap on the same 2 GB
machine that was OOM-killed at 1 GB — do not run it beside a heavy sync. And
`SPREAD_SCALE` 1.63 (`lineup-posture.js:11`) was fit under a different
availability fit; re-run `scripts/fit-posture-calibration.mjs --rebuild` after.

Operational runbook: `/mnt/project-files/availability-fit-runbook.md`.
