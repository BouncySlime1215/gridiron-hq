---
name: gridiron-feeds-never-pulled
description: Four Gridiron feeds had never been pulled anywhere (2026 xFP, QBR every season, FTN 2022-2025) plus the one-line reason the model-sync route can never ingest the current season; measured 2026-09-19.
metadata:
  type: project
  modified: 2026-09-19T16:45:00.000Z
---

All measured 2026-09-19 against a freshly bootstrapped database
(see [[gridiron-cloud-box-rebuilds-data]]).

**The root cause of most current-season gaps.** `POST /api/model/sync`
defaults its season list to `[SEASON-5 … SEASON-1]`
(`server/routes/model.js:612`; `SEASON = 2026` at `model.js:44`), so **2026
is excluded**. That one list drives every feed the route pulls — per-season
`syncPbpSeason`, `syncNflverse`, `syncAllAdvanced` (snaps, NGS, PFR, depth,
injuries) and `syncFfOpportunity`. It is the route `bootstrap-data.mjs`
calls and the heavy route on Fly, so it structurally cannot add a
current-season row. Whatever 2026 data exists came from separate scheduler
jobs, which pass `[season]` or `[season-1, season]`. Sole occurrence of the
pattern in `server/`. Widening it to include `SEASON` is ingestion-only and
leakage-free: `seasons` is not passed to any fit — `fitGameScript()`,
`fitCorrelations()` and `refitFantasyCoordinator({})` take no season
argument, and `gamescript.js:301-317` already prefers `closing_spread` for
current-season rows so a completed current-season week is legal to fit on.
Handed to the "Make the data keep itself current" thread, not fixed by the
finder.

**Filled by hand, each a one-liner that just had never been called:**
- `nfl_ffopportunity_weekly` had **zero 2026 rows**. `syncFfOpportunity([2026])`
  returns 354. This is the xFP benchmark in O1's own signal list.
- `nfl_qbr_weekly` was **empty for every season 2021-2026**.
  `syncQbr({seasons:[2021..2026]})` writes 2,754 rows, 0 quarantined. Not
  cosmetic: `projections.js:230` documents a walk-forward-validated QB
  structural head fed by that table, so **that head has been inert**. This
  also settles the recorded "2026 QBR corruption" — the table was empty
  because the job had never run.
- `nfl_play_charting` (FTN) held 2,854 rows, 2026 only. `ingestCharting` for
  2022/2023/2024/2025 returns 41,643 / 48,225 / 48,031 / 47,316 plays, ~1s
  each — the ~188k the master plan assumes for scheme and pressure.

**A real upstream limit, not a bug to retry:** nflverse publishes
`advstats_week` only from 2024. `syncPfrAdv([2021,2022,2023])` is HTTP 404 for
all three seasons and all three kinds (pass/rec/def). PFR advanced is a
2024-onward signal; anything fitted on it has about two seasons of history.

See [[gridiron-scheduler-outage-2026-09-19]] for the separate reason the
fantasy feeds had no timer at all (`MANUAL_SOURCES`), which is a different
cause from the season-window bug above.

Also seen in `sync_log` on a fresh box: `espn_rosters` failed for all 32
teams, `espn_schedules` returned `{teams:0,games:0}`, and ESPN's news API
answers 403. Not chased.
