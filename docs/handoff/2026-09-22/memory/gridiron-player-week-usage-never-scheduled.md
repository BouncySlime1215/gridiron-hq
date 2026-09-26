---
name: gridiron-player-week-usage-never-scheduled
description: The 2026 player_week_usage gap was already fixed twice in main at 791b131 and is waiting on a deploy, not on code — and a stale checkout is why several sessions reported it as open.
metadata:
  type: project
  modified: 2026-09-19T22:30:00.000Z
---

**Status: fixed in `origin/main` at `791b131`. Nothing to write. It is waiting
on a deploy.** Verified 2026-09-19 with `git show origin/main:<file>`, after
first reporting it as open from a checkout pinned at `ffe4e72`.

The symptom was real: `player_week_usage` and `player_week_snaps` held about
8,000 rows for each of 2021-2025 and **zero for 2026** mid-season, while every
source reported `ok`.

**Two independent fixes are already in main:**

1. `server/services/scheduler.js:1143` registers `nflverse_weekly_usage`
   (`maxAgeMinutes: 6*60`, `tier: 'growth'`, `offThread: true`), and
   `refreshNflverseWeeklyUsage` at `:1057` passes the **current** season
   explicitly. `growth`, not `heavy`, deliberately: the file says at `:1186`
   that the growth tier "always runs, so AUTO_HEAVY_SYNC never protected
   anyone from it". There is no flag to set.
2. `server/routes/model.js:628` now defaults to
   `[SEASON-4 … SEASON]`, including the current season, with a comment naming
   this exact symptom. The old `[SEASON-5 … SEASON-1]` is gone.

**Why the live table is still empty: main is not deployed.** The deploy of
`791b131` failed before any migration ran — the pre-migration snapshot wants
about 2.4 GB free on a 1 GB volume. Once it deploys, the weekly-usage job
fills 2026 within six hours of boot. The release thread owns that.

**Still genuinely open**, and smaller than it was first scoped:
`server/routes/nfl-betting.js` hardcodes `'2021,2022,2023,2024,2025'` as its
season default in **six** places (`:706 :721 :733 :746 :1130 :1316`). A peer
session argued this is harmless for usage because that route "never reaches
`syncWeeklyUsage`". **That is wrong on `791b131`:** `:29` imports
`syncAll as syncNflversePlayerFeeds`, `:1134` calls it, and
`nflverse.js:310` inside `syncAll` calls `syncWeeklyUsage(s)` then
`recordSync('nflverse_weekly_usage', 'ok', …)` at `:312` for each season
passed. So hitting that route stamps the usage feed as freshly `ok` while
never touching the current season — it actively manufactures the misleading
green status. Nick ruled the betting board out of scope, so confirm before
anyone fixes it.

**The lesson that cost four sessions an evening:** line numbers are worthless
across branches. This repo has many live branches and a checkout can be
dozens of commits behind. **Cite `git show origin/main:<file>` and a commit
sha, and re-fetch before believing your own citation.** A finding that a table
is empty while its source reads `ok` is worth reporting even so — nothing in
the app asserts that a table holds rows for the season being served, which is
why this was fixed twice without anyone noticing it was still broken live.
