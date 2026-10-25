---
name: gridiron-no-promoted-fit-has-ever-run
description: VERIFIED LIVE 2026-09-22 08:04Z — weekly_ensemble_fits has ZERO promoted rows, so production has only ever served the frozen-2023 per-position fallback, and weekly-ensemble.js:4-11 claims otherwise.
metadata:
  type: project
---

Nick's read-only live read 08:04Z 2026-09-22 (full record
[[gridiron-live-read-2026-09-22]]): `active_epoch {id:1, created_at:
'2026-09-19T04:40:30Z'}`, `promoted_fits_in_epoch 0`, `top_fit_keys null`,
`has_early false`.

**THE FACT: no promoted weekly fit has ever served a request.**
`activeWeeklyWeightSet` (weekly-weight-store.js:33-39) filters
`promoted=1 AND epoch_id=<active>`. Zero rows -> `weightSetFrom(undefined)` at
`:69` returns `{id:'frozen-2023', weights: WEEKLY_ENSEMBLE_WEIGHTS, source:'frozen'}`.
So every weekly projection the live app has ever served used the frozen
per-position constants at `weekly-ensemble.js:57-62` — structural-head exposure
**QB 40 / RB 50 / WR 60 / TE 80**.

**NOT AN EPOCH ARTIFACT — challenged 2026-09-22 12:23Z and it held, on dates.**
`activeLearningEpoch()?.id ?? 1` defaults to 1 and the active epoch IS id 1, so a
fit promoted before the epoch table was populated would still match. And the dates
close it: `weekly-ensemble.js:14` dates fit-2's promotion to **2026-09-18**, while
active epoch 1 was created **2026-09-19T04:40:30Z** and is the LOWEST epoch id —
so no epoch row existed on 2026-09-18, any promotion that day took the `?? 1`
default, and that is exactly what today's query filters on. **There is no epoch
under which a promoted fit could hide. Zero means zero.**

**`weekly-ensemble.js:4-11` IS FALSE.** It states as fact that "since fit-1 was
promoted ... every 2026 prediction uses ONE global vector
[0.20,0.40,0.15,0.05,0.20]". Production has never run that vector. Any argument
resting on "fit-1 is live" is resting on nothing.

**It makes promotion MORE attractive, not less.**
`promote-weekly-ensemble.mjs:3,7` already graded frozen WEEKLY_ENSEMBLE_WEIGHTS
(4.425 MAE) against season_to_date (4.386) with a pass rule beating both trivial
baselines. That approved fit-1-over-frozen win never landed; promoting fit-2 now
ships two already-graded improvements at once.

**Before anyone runs a promotion script there is one more read to do first** —
zero rows does not distinguish *never promoted* from *promoted then demoted*, and
the `ON CONFLICT(data_hash) DO NOTHING` trap makes the difference decisive.
Query and decision table: [[gridiron-promotion-preflight-read]].
