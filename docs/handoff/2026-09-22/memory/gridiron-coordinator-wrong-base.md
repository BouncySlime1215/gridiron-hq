---
name: gridiron-coordinator-wrong-base
description: Gridiron HQ's fantasy-coordinator correction was fitted and gated against the STRUCTURAL head but both live call sites add it to the ENSEMBLE number, so the served weekly projection is a combination nobody graded — measured at mean 2.09 points.
metadata:
  type: project
  modified: 2026-09-20T01:35:37.633Z
---

Found 2026-09-20 on `origin/main` at **791b131**. Routed to the coordinator for
the threads that own `trade-engine.js` and `fantasy-coordinator.js`; written up
on PR #68.

## The defect

`coordinateFantasy(fit, expertValues, structuralPpg)` returns
`structuralPpg + correction` (`fantasy-coordinator.js:457`, `:478`). The fit's
target is `actualPoints − projection.structural_ppg` (`:324`) and the promotion
gate grades `|target − correction|` (`:519`). **So what was proven is
`structural + correction` beats `structural`.**

Both live call sites pass the ensemble number instead:

- `trade-engine.js:354` — passes `weeklyPpg`, set at `:347` to
  `weekProjection?.ppg`.
- `fantasy-coordinator.js:571` — the module's own wrapper, passes
  `projection.ppg`.

So production serves `ensemble + correction`, never graded. The error is exactly
`ensemble_shift`, **which is itself one of the three experts the correction is
built from** (`:33`) — the ensemble's departure from the structural head counted
once in the base and again in the correction.

## The size, measured

Scratch rebuild from nflverse, players with `structural_ppg ≥ 3`, in fantasy
points:

| | startable | non-zero shift | mean | median | p90 | max |
|---|---|---|---|---|---|---|
| 2025 W2 | 1,059 | 354 (33%) | 1.96 | 1.31 | 4.40 | 12.32 |
| 2025 W8 | 1,054 | 469 (44%) | 1.44 | 0.90 | 3.23 | 7.61 |
| 2025 W12 | 1,069 | 515 (48%) | 1.38 | 0.87 | 3.08 | 9.68 |
| **2026 W2** | **1,169** | **352 (30%)** | **2.09** | 1.29 | 5.21 | 13.75 |

Run under the **frozen cold-start weights** (`weekly-ensemble.js:59-64`), which
put 0.40-0.80 on the structural head; the promoted fit-1 puts ≈0.20 there, so
the live shift should be **larger** than this, not smaller.

## Fix and the open caveat

One argument at each site: `weekProjection.structural_ppg` and
`projection.structural_ppg`.

**Caveat I could not close from a cloud session:** whether
`activeFantasyCoordinatorFit()` returns a fit on the live DB. If it returns
null the whole path is inert and this is latent, not live. One query settles it.

This hits `current_week_ppg`, which is the most-consumed number in the app
(Start/Sit, the League Hub card, the matchup card). See
[[gridiron-model-audit-2026-09-20]].
