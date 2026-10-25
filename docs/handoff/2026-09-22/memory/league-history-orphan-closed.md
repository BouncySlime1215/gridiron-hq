---
name: league-history-orphan-closed
description: league_season_teams/league_week_scores now have a scheduled writer (draft PR #47, 2026-09-19) — one of the two new orphans the 791b131 wiring map found.
metadata:
  type: project
  modified: 2026-09-19T21:46:43.723Z
---

The wiring map on `791b131` found `league_season_teams` read at
manager-archetypes.js `:243`, `:819`, `:831` (reached from the trades surface)
and written only by `scripts/backfill-league-history.mjs:112`. Draft **PR #47**
(branch `claude/project-thread-sytruo-lst`, from origin/main at 791b131) closes
it. That leaves the opportunity model as the remaining new orphan from that
map — see [[gridiron-wiring-map]] if it exists.

Two consumers the map did not list also read the table:
`scripts/build-manager-archetypes.mjs:66` and `scripts/luck-panel.mjs:127`.

**The non-obvious parts, so nobody re-derives them:**

- The script also CREATEd both tables, so the table's *existence* was
  conditional on a human having run it. Those three reads therefore threw
  `no such table` on a fresh box rather than returning nothing. PR #47 moves
  the DDL into a migration.
- The job must hold off while an ESPN draft is live: it reads the same
  `espn_s2`/`SWID` out of the same `leagues` rows Nick's browser drafts with —
  the 2026-09-06/07 signature exactly. `liveDraftActive()` in scheduler.js is
  now exported for that.
- It is in `scripts/refresh-live-data.mjs`'s `FANTASY_LIVE_JOBS`, before
  `manager_archetypes` which replays league-seasons out of these rows — that is
  for wherever the off-server loop runs. **Corrected 22:32Z: the Fly box runs
  the in-process scheduler, not that loop**, and `league_history` is a growth
  job, so on that box it inherits the defect in
  [[scheduler-job-ran-discriminators]] — the single background timer first
  fires at 300 s and the machine has been living 160-255 s per life, so no
  growth job has run on that build at all. #47 does not make the writer run on
  the live box until that restart cycle is fixed.
- `statusFromDetail()` in scheduler.js measures `failed` against a total it
  looks for under `leagues`/`attempted`/`teamsAttempted`/`seasons`/`total`. A
  detail that reports only the SUCCESSES as its total makes one failure out of
  two record as `'error'` instead of `'partial'`.

**Verified against a live-shaped database, 2026-09-19** (not inferred): with
both tables pre-created from the old script's DDL and rows in them, applying
064 leaves both tables' `sqlite_master` SQL byte-identical and the rows
untouched, records once, and a second `runMigrations()` returns `[]`. It is
NOT literally a no-op though — it creates `idx_league_season_teams_member` on
the existing table, and as a pending migration it triggers the pre-migration
`VACUUM INTO` snapshot, i.e. the deploy's existing `/data` free-space
precondition. The job run against that same database skipped the season that
already had a row and fetched only the others.

Migration numbering for this file, and the trap in picking a number, moved to
[[migration-numbering-gridiron]].

**Filename collision, 2026-09-19 22:48Z:** the O4 Team Outlook branch
(`claude/project-thread-f921do-outlook-basis`, PR #42) adds a DIFFERENT
`server/services/league-history.js` — a read-only reader over
`data/derived/sleeper_history.sqlite` (`historyStatus`, `weeklyPanel`,
`varianceComponents`, `compsFor`). Verified: real add/add, the only collision
between the two branches (064 is unique, and they touch neither
`backfill-league-history.mjs`, `scheduler.js` nor `refresh-live-data.mjs`).
The allocation gives the name to #47; the coordinator has #42 renaming theirs,
and `sleeper-history.js` is the more accurate name for it anyway.
