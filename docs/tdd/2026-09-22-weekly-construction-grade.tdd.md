# S-02: grade of the served weekly construction

Unit S-02 (WORK-QUEUE §5, plan item A2). Measures only; S-03 applies the result.
Pre-registration: `docs/evidence/2026-09-22/weekly-construction-grade-preregistration.md`.

## 1. Audit: extend or build (written before the first test, tree `d6d7bd5a`)

What already exists for this surface, and why none of it grades the served number:

| Existing | What it grades | Why it is not this grade |
|---|---|---|
| `weekly-backtest.js#replaySeasonWeekly` (:88) | a prediction head over the replay's own structural projection | Reads 4 tables; the live `buildPlayerWeekEngine` reads 23 (memory gridiron-replay-is-not-the-live-path). No coordinator, no lift. |
| `fantasy-coordinator.js#fantasyCoordinatorWalkForward` (:501) | `structural + correction` vs `structural` | Grades the correction on the structural base (:522). Production adds it to the ensemble (trade-engine.js:354). No lift. |
| `matchups.js` test (:28-52) | home/away and DvP multipliers on the replay blend | Not `vegasLift`. Its ship rule (:33-35) is the one this unit reuses. |
| `start-sit-decision-curve.md` §6 | a research baseline's win-rate curve | Says in its own caveat that production has `vegasLift` and the baseline does not (:131-135). |
| `git grep -il vegasLift -- docs` | 7 docs files mention it | All describe it; none grades it. Control: the same grep finds `start-sit-decision-curve.md`, a known mention. |
| PR #57 (draft) | changes the coordinator base to structural | A code change without a grade of the alternatives. Arm S1 grades its construction. |

**Decision: build a thin study script, reuse every producer.** The study adds no producer of
any served number. Every arm calls the served functions: `buildPlayerWeekEngine`,
`weeklyExpertValues`, `coordinateFantasy`, `fitFantasyCoordinator`,
`buildFantasyCoordinatorExamples`, `vegasLift`. Every metric reuses an existing helper:
`actuals`, `spearman`, `pairedBootstrapDiff`, `startSitPairAccuracy`,
`predictionWeightedMedianRatio`. Study code lives in `scripts/`, not in a production module
(memory feedback_study_code_not_in_production_modules).
