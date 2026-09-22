---
name: gridiron-post-deploy-scheduler-read
description: What to read after the deploy to prove the scheduler actually schedules — scheduled_now and due_after_minutes, not source statuses, plus the two row counts that expose silent staleness.
metadata:
  type: project
  modified: 2026-09-19T22:16:00.000Z
---

Owed by the scheduler thread once the app is up. **Every check here asks what
was PRODUCED, never whether something ran** — see
[[gridiron-sync-silent-success]] for why statuses lie on this project.

**1. Scheduling, not status.** `GET /api/mlb/sync/status`. For each fantasy
source confirm **`scheduled_now: true`** and a **`due_after_minutes`**. Both
fields exist in #19 precisely to answer this. "Everything reads ok" proves
nothing: on 2026-09-19 all 24 unscheduled sources read `ok` only because a
human swept them between 15:28 and 16:07Z.

**2. The ESPN market table, grouped by season:**

```sql
SELECT season, COUNT(*), MAX(fetched_at) FROM espn_player_market GROUP BY season;
```

Not a bare `COUNT(*)`. A 2025 row set there is the **single heaviest input**
(weight 2 against 1 each for FFC and Sleeper) to the live Draft board through
`computeConsensus` (`aggregates.js:218` and `:250`), and presence checks never
flag it. **Any row older than 2026 means the problem is live now; all-2026
means it is latent.** See [[gridiron-espn-market-job]].

**3. ffopportunity completeness, per season:** count rows AND distinct weeks
per season rather than trusting that a season is present. A season holding a
handful of weeks was counted complete forever before the fix —
[[gridiron-ffopportunity-held-gap]].

**4. Do not read a clean live tier as evidence capture working.**
`evidence_daemon` has never once completed (29 runs, 29 timeouts); #32 makes
that failure cheap and therefore quiet. Same for `nfl_prop_calibration`, which
crashes on a null. Both betting-side and deliberately unfixed.

## What a FAILING result looks like, line by line

Written out because on this project the pass shape and the fail shape look
alike, and three of these four fail by reading healthy.

1. **Scheduling.** Fail is a fantasy source with `scheduled_now: false`, or
   with `scheduled_now: true` and **no `due_after_minutes`** — the second is
   the dangerous one: it means the source is in the table but nothing computed
   a next run, which reads as scheduled and never fires. A source absent from
   the payload entirely is also a fail; the six #20 put on timers are the ones
   to name individually rather than scanning for red.
2. **ESPN market.** Fail is **any row with `season` below 2026**, which means
   last year's ADP is the heaviest input to the live Draft board right now.
   Second fail shape: a single 2026 group whose `MAX(fetched_at)` is older than
   12 hours once #50 is deployed, which means the job is registered and not
   running. An empty table is the *least* bad outcome here, not the worst.
3. **ffopportunity.** Fail is a prior season (2023, 2024, 2025) whose distinct
   week count is **below 17** — a partial season that the pre-#45 code counted
   as held forever. Row count alone cannot show this; the query must group by
   season and count `DISTINCT week`. The current season having few weeks is
   correct and not a fail.
4. **Betting-side jobs.** There is no pass shape to look for. `evidence_daemon`
   showing a clean live tier is NOT evidence capture working, and
   `nfl_prop_calibration` will still crash on a null. Record, do not fix.

Deploy-time steps that go with it: AUTO_HEAVY_SYNC back ON *after* the deploy,
never before ([[gridiron-scheduler-ship-plan]]).
