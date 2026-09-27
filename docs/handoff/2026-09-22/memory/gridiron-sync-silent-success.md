---
name: gridiron-sync-silent-success
description: Three ways the scheduler logged "ok" for work that failed or never happened, and why a green sync dashboard on this project proves nothing.
metadata:
  type: reference
  modified: 2026-09-19T21:36:00.000Z
---

The recurring failure mode on this project, in its original instances. **Any
check that confirms a thing RAN is weaker than one confirming what it should
have PRODUCED. Count rows; do not read statuses.**

**Three silent-success bugs in `runIfStale`, all real, all fixed in #19:**

- `refreshPlayerRosters` returns `{ skipped: 'live draft in progress' }` — a
  string — while the check was `detail?.skipped === true`, so it logged `ok`.
- `refreshLeagueRosters` returns `{ leagues: 5, failed: 5 }` and logged `ok`
  with every league failed.
- `record()` stamped `last_run_at` on failure exactly as on success, so there
  was **no retry anywhere in the file**: one transient 502 cost `espn_rosters`
  24 hours and `ffopportunity` three days.

**The sweep trap.** On 2026-09-19 all 24 unscheduled sources read `ok` —
because a human forced them between 15:28 and 16:07Z. The sweep made the
dashboard green; with no timer they go stale again and stay stale. So after any
deploy, "everything reads ok" proves nothing. Read `GET /api/mlb/sync/status`
and confirm **`scheduled_now: true` and a `due_after_minutes`** per source;
both fields exist in #19 to answer exactly this.

**Others of the same shape, found the same day:** sources reading ok only
because of that sweep; `evidence_daemon` which has run 29 times and completed
zero; a chat upload that exits zero and binds to nothing; availability
percentages that look measured and are constants; a season-completeness check
that counted one row as a full season
([[gridiron-ffopportunity-held-gap]]); and a verification step that would have
returned a cached answer and read as "the fit changed nothing".

Part of [[gridiron-scheduler-outage-2026-09-19]]. Live readings are in
[[gridiron-live-data-state]].
