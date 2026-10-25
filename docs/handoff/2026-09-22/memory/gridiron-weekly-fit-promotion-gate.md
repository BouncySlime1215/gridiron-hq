---
name: gridiron-weekly-fit-promotion-gate
description: "The weekly learning loop IS scheduled (scheduler.js:581), but a retrained weight set must clear FIVE gates before it is served, and saveAndVerifyWeeklyFit — the written safety wrapper for that promotion — has zero callers."
metadata:
  type: project
---
Explorer, 2026-09-22, static analysis on tree `654ff93` (name the tree — main
moves hourly). Package
`/mnt/project-files/PACKAGE-WEEKLY-FIT-PROMOTION-GATE-2026-09-22.md`.

**Own trigger, not a piggyback.** `scheduler.js:581` imports
`runWeeklyLearningCycle` from `weekly-learning.js`. So this is NOT the
[[gridiron-optional-sources-never-trigger]] case.

**Five gates to a served weight set:**
- Gate 0: `retrainWeeklyWeights({ minSettled = 250 })`, `weekly-learning.js:224`.
- Gates 1-4, one four-way AND at `weekly-learning.js:310-311`:
  `validation.length >= 100 && significantlyBetter && candidateRank >= championRank - 0.001 && coverageGate.ok`.
Either way the fit is stored by `saveWeeklyFit` (`weekly-weight-store.js:147`)
with a `rejection_reason` naming which gate lost (`:313-318`).

**When nothing is promoted, `frozen-2023` is served** —
`weightSetFrom(null)` at `weekly-weight-store.js:69`. Observed on two trees
today (rig 17:03Z, bundle test 17:12Z). Says nothing about production.

**DEAD SAFETY WRAPPER:** `saveAndVerifyWeeklyFit` (`weekly-weight-store.js:175`)
saves promoted, re-reads, and demotes on failure (`:184`). **Zero callers
anywhere in the repo.** The scheduled path calls raw `saveWeeklyFit`
(`weekly-learning.js:319`) with no post-save verification. This part needs no
production data.

**Three outcomes registered in advance:** fits stored and all rejected (claim
holds, reasons name the binding gate); ZERO fits stored (premise WRONG, gate 0
or earlier, withdraw the headline); promoted fits present (claim REFUTED, say so
plainly).

**Weakness to keep in view:** a strict gate is not a broken gate. Four
conditions that never pass may be correctly protecting production.

Settled by the pristine census of `EXPLORER-READ-B-2026-09-22.sh`, which now
prints fit totals, promoted count and the last six rows with rejection reasons,
plus `weekly_prediction_snapshots` so gate 0 is separable from gates 1-4.
