---
name: gridiron-live-read-2026-09-22
description: VERIFIED production DB read by Nick 08:04Z 2026-09-22 — zero promoted weekly fits in active epoch 1 (learning loop never ran in prod), ESPN cookies present for all 5 leagues.
metadata:
  type: project
  modified: 2026-09-22T08:05:53.429Z
---

**Read-only `node:sqlite` query on `/data/data.sqlite` via `fly ssh console -a gridiron-hq`, run by Nick, output screenshotted at 08:04Z (message `cmsg_01YAsw8AnFv4ioRMQw8dfPmT2WFHzDKT6HETRJ2FcoDeJ4`). Presence only; no secret printed.**

```
active_epoch  { id: 1, status: 'active', created_at: '2026-09-19T04:40:30.041Z' }
promoted_fits_in_epoch  0
top_fit_keys null  has_early false  early_keys null
leagues ids 1,2,3,4,5  has_cookies: 1  (espn_s2 IS NOT NULL AND swid IS NOT NULL)
```

**What it settles:**
1. **Weekly learning loop has NEVER produced a result in production.** `promote-early-week-weights.mjs` has never written a promoted `weekly_ensemble_fits` row. Every live weekly projection has come from the frozen per-position fallback (structural-head exposure QB 40 / RB 50 / WR 60 / TE 80, weekly-ensemble.js:56-63; 60/50/40/20 is the HISTORY complement, withdrawn only as a structural reading). Auditor Unit 1's open condition closed: design ACCEPTED, running-in-production = **NO**. Scheduler's loud-fallback unit (`source: 'frozen-orphaned-epoch'`, RED ea34923 / GREEN 0221966) fixes the exact live condition.
2. **ESPN cookies are PRESENT for all five leagues.** Nick does not need to supply them. The transactions collector (`scripts/collect-league-transactions.mjs`) is not cookie-blocked; it has no scheduled caller on main (held 9c7cf68 adds one). Outcome-ledger `observed` rows need the collector to run, not the cookie.
3. Caveat carried: `IS NOT NULL` proves presence, not non-empty or valid.

**Told Nick 08:05Z.** Promotion script's first real run is scheduled after the deploy, never before. The read command lives in the 08:02Z project-chat post (heredoc to /tmp/read.cjs). Related: [[gridiron-deploy-step-2026-09-22]], [[gridiron-state-0759-2026-09-22]].
