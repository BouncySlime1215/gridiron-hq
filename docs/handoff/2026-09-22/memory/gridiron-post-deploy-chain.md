---
name: gridiron-post-deploy-chain
description: The ordered post-deploy chain for the 2026-09-19 release (steps after the app is healthy), the restart rule, and the after-read expectations (a)-(g).
metadata:
  type: project
  modified: 2026-09-19T22:03:56.332Z
---

Run sheet = PR #35 section 6, steps 1-21. Coordinator drives; threads execute.

**Chain, in order:** once healthy Nick runs `fly secrets unset AUTO_HEAVY_SYNC -a gridiron-hq` (restarts; MUST precede the capture) → tell Trade Brain (holds the bearer token) → mid-window capture BEFORE any fit → three deterministic reads (`?seed=1&runs=2000&from_week=2`) with the 2026 usage count beside each → dry run `--report=/tmp/fit.json`, report to feature-audit AND opportunity via the coordinator (they want the QBR coverage line and graded `n` first) → gate v2 (#37) → availability write (step 10, **NO restart**: caches self-invalidate, simulate memo carries the seed, `?week=` routes are unmemoised; a restart re-runs bootJobs → nfl_injuries) → step 8 promotion (Nick's decision first, see [[gridiron-step8-decision]]) → ensemble re-fit (MANDATORY) → **restart REQUIRED** (routes/model.js proj/player-week memos and draft-assist.js:81-86 `modelProjections` carry no seed or fit id; league sync and /dev/refresh-all are NOT safe busts, they move dynasty_values) → after any restart re-baseline → posture re-fit → after-reads with seeds 4 and 5 → scheduler read (`scheduled_now`, `due_after_minutes`, `SELECT season, COUNT(*), MAX(fetched_at) FROM espn_player_market GROUP BY season` (any row older than 2026 = last year's ADP is the heaviest input to the live Draft board via computeConsensus, routes/aggregates.js:250; presence checks never flag it)) → scheduler thread → verify-trade-brain-live (script missing on the machine) → completeness script → chat-sync confirms corpus → deploy marker `GET /api/trades/3/managers/signals` → **`fly secrets set AUTO_HEAVY_SYNC=1` LAST** (heavy tier is off-thread since #17, scheduler.js:1605, but its jobs refresh nfl_injuries under the readings and it restarts the machine).

STOP conditions: qbr 2021-24 populated at step 7; opportunity gate n above 4,361 / 4,468 (impossible).

**After-reads:**
- (a) role layer runs on 2025 roles until 2026 usage exists; never straddle the backfill.
- (b) value/give/get/ratio/adj_ppg from dynasty_values CANNOT move; read `current_week_ppg`.
- (c) **K/DEF: no after-read** (three threads agreed on 791b131): the 0.92 (trade-engine.js:346) survives only as display field :464; week_points is 0 for K/DEF (:2617) and every downstream filter is `> 0`. A kicker on the Start/Sit bench list is a FINDING. Healthy skill: 0.805 constants / 0.952 role.
- (d) Odds drift floor 0.01; 0.02+ is signal.
- (e) Chips: Nick's starters carry 13 placeholder warnings (3/2/4/3/1 across leagues 1-5); expect counts to FALL, Nacua (ESPN Questionable+DNP in all 5 leagues, 0.324 = the constants-path FLOOR) to drop, new chips only on designated players; counts not falling = role rates did not land. Injuries come from nfl_injuries AND the ESPN flag (more severe wins).
- (f) `?week=2` = lowest-200 tail; count rows out of the DB.
- (g) Opportunity vector ≈ 1.28 / 1.71 / 0.175 / 0.081 & 0.090 / 0.264.

Fit facts: ~139 pooled + ~870 role rows, undo = DROP both tables; the fitted rate is a USAGE rate; baseline odds 0.62/0.63/0.26/0.24/0.90 (#41, 62c0c8f). Runbook /mnt/project-files/availability-fit-runbook.md.

**#40 interaction (wiring map + fantasy plan, 22:00Z):** #40's from_week fix alone moves playoff odds 9.5 points mean absolute across ten teams (15.3 max). Tonight's after-reads are on 791b131 without #40; the next train's #40 deploy needs its own before/after odds reading so the two effects are never attributed to each other.
