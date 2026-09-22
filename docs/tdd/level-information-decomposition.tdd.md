# Level-vs-information decomposition helpers (Auditor §R25/§R36)

Pure-math helpers backing the R25 shipped-vs-control decomposition:
`weightedQuantile`, `predictionWeightedMedianRatio` (the R7 multiplicative
form's m0), and `decomposeArm` (median-based centring per R36 change 1).
Method and rig scope: `docs/evidence/2026-09-22/R25-LEVEL-VS-INFORMATION-PREREGISTRATION.md`.

## Why median, not mean (R36 change 1)

MAE's optimal centring statistic is the median of residuals, not the mean.
Weekly fantasy scores are right-skewed (a handful of boom weeks pull the
mean well above the typical week), and the two arms (shipped, control) have
different skew shapes, so a mean-based centring does not cancel out of the
delta between them — it can make one arm look more or less biased than it
really is, purely from outlier sensitivity the median doesn't have.

## RED

`test/level-information-decomposition.test.js`, 11 tests, written before
`server/services/level-information-decomposition.js` existed:
`node --test test/level-information-decomposition.test.js` failed with
`ERR_MODULE_NOT_FOUND` (the module did not exist yet).

## GREEN

Implemented `weightedQuantile`, `predictionWeightedMedianRatio`,
`decomposeArm` in `server/services/level-information-decomposition.js`,
reusing `quantile` from `stats-util.js` for the unweighted median. All 11
tests pass.

## Mutation check

Hand-mutated `decomposeArm`'s centring line from
`quantile(residuals, 0.5)` to `mean(residuals)` — the exact regression this
unit exists to prevent (reverting to the pre-R36 mean-based centring). Only
the test built to catch it failed (`decomposeArm centres on the MEDIAN
residual, not the mean`): `# pass 10 / # fail 1`. Reverted; full suite green
again (`# pass 11 / # fail 0`).

## What these tests do NOT cover

- The actual shipped/control weight vectors, `weeklyEnsemblePrediction`, or
  `replaySeasonWeekly` — those are exercised only by the measurement script
  (`scripts/r25-level-vs-information.mjs`) against real rig data, not by
  this unit test file. This file tests the decomposition MATH in isolation
  from synthetic inputs with known answers.
- Real-world skew magnitude — the skew test here is a constructed extreme
  (4 zero-residual rows, 1 outlier) chosen to make mean != median
  unambiguously, not a measurement of how skewed 2023's actual residuals
  are (that number comes out of the real run, reported separately).

## Numbers

`node --test test/level-information-decomposition.test.js`: 11 tests, 11
pass, 0 fail, exit 0. No DB, no fixtures — pure function tests, no guard
run needed for this file in isolation (guard-verified as part of the
branch's next full-suite run alongside the rig measurement work).
