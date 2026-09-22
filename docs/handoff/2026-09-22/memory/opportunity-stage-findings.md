---
name: opportunity-stage-findings
description: Player-opportunity stage result, 2026-09-19 — the real defect is the volume shrinkage constants in projections.js, whose promotion gate passes but has never been run.
metadata:
  type: project
  modified: 2026-09-19T19:55:00.000Z
---

Measured 2026-09-19 on a database rebuilt from scratch in a cloud session
(nflverse, ffopportunity, nfldata games.csv), seasons 2021-2026. Shipped as draft
**PR #15**, based on the `-docs` top of the PR stack. Runbook:
`docs/RUNBOOK-promote-volume-shrinkage.md`; evidence:
`docs/OPPORTUNITY-FINDINGS-2026-09-19.md`.

**The real opportunity defect is `projections.js`'s volume shrinkage.**
`K.share = 6` and `K.team_volume = 10` regress volume ~20-30x harder than the
data supports; fitted values are 0.18-0.28 and 1.3-2.9. On the live database's
own QBR coverage the gate passes all five pre-registered conditions: structural
head MAE 4.921→4.475 (2024) and 4.758→4.394 (2025); full ensemble 4.453→4.428
and 4.364→4.343, both significant; start/sit pair accuracy 0.6349→0.6395 and
0.6273→0.6333; 80% coverage 0.759→0.785.

**It is a database write, not a code change.** The fitter, gate, cutoff-safety
guard and recency-units guard all exist and are correct; `shrinkage_fits` and
`shrinkage_k` are simply empty, so production has always taken the hand-picked
branch. Promotion writes 1 + 6 rows plus an active flag. **Rollback is one
statement:** `UPDATE shrinkage_fits SET active = 0`. Then
`scripts/promote-weekly-ensemble.mjs` re-fits the weights.

**The window between the two steps is a wash, measured not assumed:** fitted k
with the currently promoted weights scores 4.4406→4.4372 (2024) and
4.3647→4.3685 (2025), neither significant. All the gain comes from the re-fit,
which raises the structural weight from 0.20-0.25 to 0.50-0.55.

**NOT EXECUTED** — held pending Nick's own word. See
[[shrinkage-promotion-execution]] for everything about running it: what the
verdict is sensitive to, whether the script is even on the machine, and why it
now waits for the deploy.

**Teammate absence: real mechanism, payoff inside the noise.** Log-space
coefficient on a same-position vacated share is positive in every position and
season (WR/TE 0.49-0.67, RB carries 0.72-0.83, RB targets 1.39-1.65). MAE payoff
only for RB carries (−0.86%/−0.98% pooled), intervals still straddle zero.
Nothing wired in. A 16-feature ridge model is WORSE than an EWMA of the player's
own recent volume for RB carries and QB attempts. **Why three earlier attempts
measured zero:** they looked for absent teammates among players who have a
box-score row in the graded week, and a player ruled out has none. Affected slice
0 of 5,336 built that way; 2,170 of 5,336 built from the prior-week roster.

See [[opportunity-dead-artifacts]], [[gridiron-live-data-state]].

## PR #15 CHANGED MEANING (21:55Z 2026-09-19)
#15 was "Opportunity model: measure what is real, remove what is dead". Its
content merged into main with the release train (`791b131`) but **the PR itself
was never closed**, and its head was this thread's designated branch
`claude/project-thread-w45mur`. Resetting that branch onto main and pushing made
#15's head the follow-up commits. Old head `9db53ff` and old base `d9b4a90` are
both ancestors of main, so nothing was orphaned; #15 was retargeted to `main` and
retitled. **#15 now means: the data-completeness checker + the blast-radius probe
+ two doc corrections** (4 files, 527 lines, draft). Any plan entry treating #15
as the opportunity PR or as a merge-order item is STALE. Coordinator told; offered
to close it and open a fresh number if the release thread prefers.

Follow-up branches from here: because #15 is OPEN, not merged, the harness's
fresh-branch rule does not apply — push to the same branch and the existing PR
updates. Re-check that before assuming a new PR is needed.
