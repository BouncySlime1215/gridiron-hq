---
name: gridiron-replay-config-axes
description: replaySeasonWeekly's defaults differ from the production serving path on four coupled axes, so a bare replay grades a model the app does not run; which results actually carry the rider.
metadata:
  type: project
---

`replaySeasonWeekly` (server/services/weekly-backtest.js:88-129) does NOT default to
production's configuration. Four known axes, as of 2026-09-22:

1. **roleRecency** — `:96` destructures it with no default, so `projections.js:453`
   spreads `undefined` and the replay runs `RECENCY` (seasonDecay 0.35, weekHalfLife
   null, `projections.js:162`). Production serves `WEEKLY_ROLE_RECENCY` (0.05, 5 —
   `weekly-ensemble.js:55`) at `player-week-engine.js:271-274`. `weekly-backtest.js:30`
   already imports the constant.
2. **volume k vector — COUPLED to axis 1.** `projections.js:459` calls
   `activeKVectorFor(rr, …)`, and `shrinkage-fit.js:494-521` withholds every fitted
   VOLUME k unless `isWeeklyRoleRecency(rr)`. So a bare replay also loses the shipped
   shrinkage vector. **Any measured "roleRecency effect" is therefore a JOINT effect of
   1 and 2 and must not be attributed to the argument alone.**
3. **prediction head** — with no `predictionHead` the replay centres on the STRUCTURAL
   head; production centres on the ensemble. Written up in-repo at
   `scripts/fit-weekly-coverage.mjs:47-55`.
4. **draws/seed** — 200 runs, seed 20260826, vs production's 2,000 draws
   (`fit-weekly-coverage.mjs:29`). See [[gridiron-monte-carlo-band-is-common-mode]].

**Rider scope is NARROW, not global.** The 4.749 / 4.921 baseline family that the
volume-shrinkage provenance rests on is CLEAN: `shrinkage-fit.js:39-42`'s 2024 = 4.921
matches a role-recency-ON measurement (4.931 measured independently, 0.2% apart), and
its producer `scripts/promote-volume-shrinkage.mjs:151-154` passes the constant. So do
test-new-heads, grade-harness, promote-weekly-ensemble, promote-early-week-weights,
player-head-validation, grade-feature-vector, availability-decision-calibration and
fit-weekly-coverage's `production()`. Only these OMIT: **`server/services/nfl-blind-audit.js:263`
(a LIVE service)**, `scripts/verify-qbr-integration.mjs:12-13`,
`scripts/fit-shrinkage-weekly.mjs:42-43` (also `kOverride: null`), and
`scripts/fit-weekly.mjs:44,65-67` (defensible as a fit, see below).

**Deltas get no automatic pass.** Common-mode cancellation in a candidate-minus-incumbent
ordering only holds where the candidate does not interact with the misconfigured axis.
Volume-shrinkage candidates interact with axis 2 directly, so their deltas do not cancel.

**Fix shape ruled 2026-09-22 (R41.3): THROW, do not default.** A silent default would
change every existing script's numbers silently — the same defect pointed the other way.
The live caller must be corrected in the SAME commit as the throw.

**R41.4, the larger one:** `RECENCY.seasonDecay = 0.35` was validated by `fit-weekly.mjs`,
which omits roleRecency — i.e. fitted with role and efficiency memory held EQUAL, while
production splits them. The shipped constant was never selected under the configuration
it serves. Another [[gridiron-fit-vs-serving-population-mismatch]] instance.

Full ruling: /mnt/project-files/audit-unitA-and-ceiling-bracket-2026-09-22.md §R41.
Related: [[gridiron-replay-rolerecency-trap]], [[gridiron-replay-may-not-grade-the-shipped-model]],
[[gridiron-bespoke-tool-cross-check-rule]].
