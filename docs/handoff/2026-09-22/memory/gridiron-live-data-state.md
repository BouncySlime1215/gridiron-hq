---
name: gridiron-live-data-state
description: What is in the live gridiron-hq.fly.dev database after the 2026-09-19 ingestion sweep — the NFL data side went from a seed skeleton to populated; supersedes the earlier "nearly empty" reading.
metadata:
  type: project
  modified: 2026-09-19T19:30:00.000Z
---

**Superseded reading:** an audit at 15:20Z found this database nearly empty
on the NFL side — 448 seed players with no ids, 53 of 78 ingestion sources
never run. That was true then and is **no longer true**. Do not quote those
figures.

A full sweep ran against the live app between 15:28Z and 16:06Z on
2026-09-19, using the app's own ingestion routes, after Nick resized the
machine to 2 GB and set the odds, CFBD and Anthropic keys.

**Verified live at 19:22Z (warm reads, authenticated):**

- `players` **965 rows**, of which **800 carry an espn_id**, 928 a gsis_id,
  751 a sleeper_id. Previously 448 rows with no ids of any kind.
- `player_season_stats` 1,294 · `player_metrics` 1,311, of which **196 carry
  `source = 'fc_value'`** · `roster_players` 2,485 · `team_cap` 32 ·
  `news_items` 428.
- `nfl_snaps` about 25,300 per season 2021-2025 and 1,585 for 2026 ·
  `nfl_injuries` 428 · `nfl_ngs` 150 · `nfl_pfr_adv` 739 ·
  `nfl_external_ratings` 64 · nfelo 1,725 · Polymarket 9,610 markets.
- `nfl_qbr_weekly` **2025: 540, 2026: 34, and 2021-2024 deliberately 0** —
  see the hold in [[gridiron-open-risks]].
- `player_week_usage` and `player_week_snaps` populated 2021-2025 (7,659 to
  8,857 rows a season) and **zero for 2026** — see
  [[gridiron-player-week-usage-never-scheduled]].
- All five ESPN leagues untouched throughout, still `connected` with real
  rosters.

**Source status after the sweep:** of 78 registered sources, 60 ran clean,
against 23 before. The stragglers and why:
- `nfl_learned_shadow` — `research_python_unconfigured`, needs a Python env.
- `twitter_insiders` — still skipping, see the key-name bug in
  [[gridiron-fly-ingestion-limits]].
- `nfl_sgo_snapshot` — needs a SportsGameOdds key Nick does not have.
- `nfl_prop_calibration` — throws, see [[gridiron-betting-bugs-unfixed]].

Operationally, read this together with [[gridiron-fly-cold-start]] (a cold
first request takes about three minutes, so warm the machine before reading)
and [[gridiron-long-writes-block-the-app]] (never start a multi-season sync
without an agreed window).

## READ THIS BEFORE TRUSTING THE SOURCES DASHBOARD (added by the scheduler thread)

**Every "ok" on an unscheduled source above is the sweep, not a working
system.** All 24 sources that have no timer were forced by hand between 15:28Z
and 16:07Z on 2026-09-19. They have no scheduler job, so nothing will refresh
them again. On their own `maxAgeMinutes` budgets they go stale over the
following one to three days and then **stay stale forever**. Anyone opening
`/api/dev/sources` tomorrow will see a healthy-looking system that is not one,
and the healthier it looks the longer the real problem hides.

Six of them — `nflverse_crosswalk`, `nflverse_weekly_usage`,
`nflverse_snap_counts`, `espn_depth_chart`, `espn_season_stats`,
`sleeper_players` — actually recur once PR #20 merges. The rest remain manual
by design (multi-season backfills, offseason-only feeds, quota-costing
captures); PR #20's body lists each one and why.

See [[gridiron-scheduler-outage-2026-09-19]] for the full scheduler audit and
the six-PR set that fixes it.
