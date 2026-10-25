---
name: gridiron-availability-fit-role-window
description: With 2026 player_week_usage empty, Gridiron HQ's fitted role layer runs on last season's roles — and the gate cannot detect it.
metadata:
  type: project
---

Part of [[gridiron-availability-fit]]. Verified on `origin/main` **791b131**.
Found 2026-09-19 21:05Z from Nick's read-only probe.

**`player_week_usage` has ZERO 2026 rows.** 2021-2025 hold 7,659-8,857 rows
across 18 weeks each; 2026 has no line at all.

`roleStates(2026, 2)` (`contingency.js:324`) reads
`(season = 2025 OR (season = 2026 AND week < 2))`, and `gap` counts the
player's team's games **after his last appearance inside that window**. With no
2026 rows, that window is the 2025 season alone. So:

- A player who finished 2025 healthy reads `g0` — **even if he has missed both
  2026 games so far.** The role layer is blind to 2026 absences entirely.
- Last 2025 appearance at week 14 or earlier gives `gap >= 4`, `gapBucket`
  returns null (`ROLE_MAX_GAP = 3`), and **he gets no role cell at all** —
  priced on the non-role path while `availability_basis` still reports `role`.
- A rookie, or anyone with no 2025 usage, is not in the map at all.

This is the fit's own documented weak spot — "week 1, where the role comes
from last season", 2025 wk1 log loss 0.554 -> 0.721. At 2026 week 2 with an
empty 2026 usage table, we are in that regime.

**THE GATE CANNOT DETECT IT.** The gate is scored on 2025, where in-season role
states were current. **A clean gate pass is fully consistent with the live role
layer being weaker than the gate number implies and firing for fewer players
than anyone expects.** This project's recurring failure mode in a new hat: a
check that confirms the thing RAN, not what it PRODUCED.

**The fit itself does NOT need 2026 rows** — `FIT_SEASONS = [2021..2024]`,
`TEST_SEASON = 2025` (`fit-availability.mjs:48-49`). This changes what the
after-numbers MEAN, not whether the fit can run.

## Run-sheet consequence

#20 and #31 (both in the shipped train) are what fill 2026 usage. If that
backfill lands **between** the before-reads and the after-reads, part of the
movement is the backfill changing role states, not the fit — two causes, same
direction, indistinguishable afterwards.

1. Record the 2026 `player_week_usage` count beside **every** reading.
2. Take all three readings on one side of the backfill, not one either side.

## Relayed, not verified here

From the opportunity thread: shrinkage promotion moves only the weekly path
(`player-week-engine` under `WEEKLY_ROLE_RECENCY`) — 0 of 1,130 season-long
projections, 1,155 of 1,174 weekly, startable +4.71 ppg at a week-2 cutoff —
and the ensemble re-fit is a mandatory follow-on, not optional. Consistent with
the above (the weekly path is where week-2 recency bites and the season-long
path is insulated), but not independently checked.
