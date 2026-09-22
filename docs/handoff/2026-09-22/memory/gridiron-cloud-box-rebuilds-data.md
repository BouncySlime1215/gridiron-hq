---
name: gridiron-cloud-box-rebuilds-data
description: A Claude cloud box can rebuild the full Gridiron NFL-side database from public feeds in about three minutes, so "the Mac is where the data is" is no longer a reason to defer WO/WB work.
metadata:
  type: project
  modified: 2026-09-19T16:45:00.000Z
---

Measured 2026-09-19 in a cloud session on branch
`cursor/betting-model-audit-fixes-1c85`:

```
npm ci                          # 270 packages, 4s
node scripts/migrate.mjs        # 60 migrations, creates server/data.sqlite
node scripts/bootstrap-data.mjs # ~3 min
```

Result: **8,556 players** (the live Fly app holds 448), 128,146 snap rows,
12,010 NGS, 28,411 injuries, 27,176 `nfl_player_week_features`, 42,133
`player_week_usage`, 40,423 `player_week_snaps`, 8,829 depth-chart rows,
25,797 `nfl_pfr_adv`, 2,752 `nfl_team_week_features`, 16,486
`player_gamelog`, seasons 2021 through real 2026 weeks. Box had 15 GB RAM,
4 cores, 29 GB free disk — far more than Fly's 2 GB.

**No ESPN cookies are needed for any NFL-side data.** Only the ESPN *league*
half (leagues, rosters, manager profiles) needs auth, and those tables stay
empty here. So league-scoped surfaces cannot be checked in a cloud box;
everything NFL-side can.

This directly overturns the conclusion recorded in `TASKS.md` item 4c
("WO+WB cannot meaningfully run in a cloud box — there is no database of any
kind here"). True as a snapshot, wrong as a constraint: the database is
rebuildable from public feeds on demand. Do not defer model work to the Mac
on data-availability grounds again without re-running the two commands above.

`data/line-history/line_history.sqlite` (21 GB, betting) is genuinely not
needed — the fantasy engine never opens it. See
[[gridiron-feeds-never-pulled]] and [[gridiron-fly-cold-start]].
