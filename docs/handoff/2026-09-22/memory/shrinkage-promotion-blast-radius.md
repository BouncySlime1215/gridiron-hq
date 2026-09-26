---
name: shrinkage-promotion-blast-radius
description: Measured — promoting the volume fit moves the weekly path only (startable players +4.71 ppg, removing a 5.2 ppg under-projection) and zero season-long projections.
metadata:
  type: project
  modified: 2026-09-19T21:30:00.000Z
---

Measured end to end on a scratch `VACUUM INTO` copy of the rebuild: wrote a real
fit through `saveFit`/`activateFit`, then compared production's own
`buildProjections` call shapes. Packaged as
`scripts/measure-shrinkage-blast-radius.mjs` (local commit 06f7b4e), read-only.

**Blast radius is ONE code path.** `activeKVectorFor(rr, …)` returns the vector
only when `isWeeklyRoleRecency(rr)`; otherwise it strips every `VOLUME_METRIC_NAMES`
entry, and the fit contains nothing else, so it returns **null**. Exactly one
production caller passes `roleRecency: WEEKLY_ROLE_RECENCY`:
**`server/services/player-week-engine.js:271`** → start/sit, trade values, props,
expert council, news impact, role scenarios, `routes/model.js` weekly endpoints.
Everything else runs default recency and is untouched: `draft-assist.js:83`,
`season-sim.js:180` and `:380`, `ros-projection.js:331`, `preseason-model.js:459`,
`ceiling-lineup.js:62`, `week-postmortem.js:99`, `routes/model.js:404/:426/:482`.
Verified at the resolver: **0 of 1,130 season-long projections move.**

**At a 2026 week-2 cutoff the weekly change is LARGE** — far larger than the
gate's 4.363 → 4.347, because the gate graded weeks 5-18 where in-season evidence
exists and the ensemble absorbs the head. Startable pool (top 24 QB/48 RB/60
WR/24 TE): **mean +4.71 ppg, 151 of 156 up, max +15.39.** Top-N churn 5/24 QB,
6/48 RB, 3/60 WR, 2/24 TE.

**Level check vs 2025 per-game scoring** (NOT a forecast test — grades against the
season it is built from): all 384 players 8+ games MAE **3.22 → 1.69**, bias
**−1.61 → −0.05**; startable 156 MAE **5.22 → 2.32**, bias **−5.18 → −0.90**.
Trey McBride 7.5 → 18.6 against an 18.6 actual; Jaxon Smith-Njigba 9.3 → 21.9 vs
21.2. Not uniform: Jefferson 7.5 → 16.6 vs 11.8 actual, K. Walker 10.7 → 19.7 vs
11.3 — the head prices opportunity, not efficiency.

**Which SCREENS move is a different question from which callers do, and this
thread got it wrong: see [[shrinkage-which-screens-move]].**

**Consequences:**
- **Step 2 (ensemble re-fit) is not optional.** The weekly weights were fitted
  against the old structural scale; step 1 moves that head 4-15 pts for starters.
- **Cross-surface split after step 1**: start/sit shows Bijan ~29 while the draft
  board, ROS, season sim and playoff odds keep ~13. Not introduced by the
  promotion (those run the old constants today) but newly visible. Raised with
  the coordinator; recommendation is promote anyway and label/fix next train.
  Lifting the guard is new modelling work, not a flip — the vector was never
  fitted under season-long recency (counterfactual there is only mean −0.41).

**Trap the script caught on me:** diffing with an explicit `kOverride` BYPASSES
`activeKVectorFor`, so a forced diff reports the season-long path moving 1,130 of
1,130. Read the resolver, not a forced override. See
[[opportunity-graded-population]], [[shrinkage-promotion-execution]].

Which tree this describes, and the cache hazard on the after-reads: see
[[which-tree-is-production-running]].
