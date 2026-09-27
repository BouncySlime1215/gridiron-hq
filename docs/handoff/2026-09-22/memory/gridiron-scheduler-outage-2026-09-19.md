---
name: gridiron-scheduler-outage-2026-09-19
description: Index to the 2026-09-19 scheduler audit — why the app went unreachable, why the fantasy feeds had never run (a different cause), and where each part is now recorded.
metadata:
  type: project
  modified: 2026-09-19T21:36:00.000Z
---

Two separate findings, both correcting beliefs recorded earlier the same day
in [[gridiron-fly-ingestion-limits]]. This file is the index; the substance
moved into the files below so none of it falls past the 4 KB recall cut.

**1. Turning AUTO_HEAVY_SYNC ON is what took the app down**, and a TCP check
is why it stayed down for three hours → [[gridiron-wedge-mechanism]], which
also holds the Fly health-check-versus-restart-policy semantics and the three
traps that defeat the obvious watchdog.

**2. The fantasy feeds were never gated by AUTO_HEAVY_SYNC — they had no timer
at all.** `espn_players`, `nflverse_crosswalk`, `nflverse_weekly_usage`,
`nflverse_snap_counts`, `espn_depth_chart`, `espn_season_stats` and
`sleeper_players` sat in `source-registry.js`'s `MANUAL_SOURCES`, which by
design means "only runs when someone calls its /sync route". Nobody ever did,
so switching the flag on changed nothing for any of them. That is why the
players table was 448 seed rows with no external ids: the crosswalk that
writes `gsis_id` was never scheduled, and `syncWeeklyUsage` throws without it.
Fixed by #20 → [[gridiron-feeds-never-pulled]],
[[gridiron-player-week-usage-never-scheduled]].

**3. The scheduler logged `ok` for work that failed or never happened** →
[[gridiron-sync-silent-success]].

**4. The 2026 gap, root-caused and fixed in #31.** `server/routes/model.js`
defaulted its season list to `[SEASON-5 … SEASON-1]` = 2021-2025, so the route
driving play-by-play, nflverse usage, the advanced feeds and ffopportunity
could never ingest the season being played — and `scripts/bootstrap-data.mjs`
calls it with no `seasons`, so the default is what runs. Now
`[SEASON-4 … SEASON]`: five seasons still, window slides forward.
`server/routes/nfl-betting.js:1130` has the same defect as a literal
`'2021,…,2025'` and was deliberately left alone (betting out of scope, nothing
depends on it) — see [[gridiron-betting-bugs-unfixed]].

**Measured payload sizes (2026-09-19, week 2), which decide what is safe to
schedule on a 2 GB machine:** nflverse `depth_charts_2026.csv` **51 MB** and
growing weekly, a row per player per team per game — **do NOT schedule this**;
use ESPN's per-team core API instead. `players.csv` 7.3 MB,
`stats_player_week_2026.csv` 530 KB, `snap_counts_2026.csv` 142 KB. ESPN
`kona_player_info` 17.6 MB. `nfelo` qb_elos.csv 6.4 MB, timed at 69 s on Fly.

**What shipped, the merge order and the deploy-time facts:**
[[gridiron-scheduler-ship-plan]]. All eight PRs are merged into main.
