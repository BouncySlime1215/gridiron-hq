# Auditor §R25/R36 result: level vs. information in shipped-vs-control

Method locked in `R25-LEVEL-VS-INFORMATION-PREREGISTRATION.md` before this
run. Raw output: `r25-level-vs-information-output.json`. Script:
`scripts/r25-level-vs-information.mjs`.

**R37 rider**: this grades the replay predictor, whose equivalence to
production's is unestablished.

## (a) Claim

2024's raw 0.0728 MAE win for control over shipped is **62% level, 38%
information** (level_share 0.0454, information_share 0.0274), and the
"information" share is not statistically distinguishable from zero on
2024 itself (debiased bootstrap CI `[-0.057, 0.0037]`, includes zero). The
win does not reproduce out of sample: on 2021 the same level-dominated
pattern holds (raw significant, debiased not); on 2022 the raw win
vanishes entirely (not significant) and the debiased comparison
**reverses direction significantly** — once both arms are centred on
their own 2023 bias, shipped beats control on 2022 (mean_diff +0.0569,
CI `[0.0316, 0.0826]`, excludes zero). Reading across all three seasons,
control's reported production advantage is level-driven and
season-dependent — the artefact case the pre-registration flagged, not a
robust information edge.

## (b) file:line (tree: `shrinkage-efficiency-weighting` @ `7583e6b`, not
`main` — see pre-registration §0 for why; `main` `1a136145` keeps the
pre-rewrite line numbers for `weekly-ensemble.js`)

- `server/services/weekly-ensemble.js:75-80` (`WEEKLY_ENSEMBLE_WEIGHTS`,
  shipped), `:172-177` (`weeklyEnsembleWeightsFor`), `:99-106`
  (`weeklyEnsemblePrediction`)
- `server/services/weekly-backtest.js:88-92` (`replaySeasonWeekly`, fixed
  seed 20260826), `:154-158` (`active_champion` always computed, the
  `predictionHead` injection point), `:179` (`_predictions` row shape)
- `server/services/level-information-decomposition.js:23-36`
  (`weightedQuantile`), `:41-52` (`predictionWeightedMedianRatio`, R7's
  `m0`), `:58-73` (`decomposeArm`, median-based centring per R36 change 1)
- `server/services/backtest-significance.js:57` (`pairedBootstrapDiff`)
- `scripts/r25-level-vs-information.mjs:1-95` (the measurement script;
  whole file)

## (c) Evidence

- **Bias split**: 2023, n=4,389 graded player-weeks. Shipped: medianBias
  -1.128, m0 0.9126 (predictions ~8.7% high on the median, by the
  prediction-weighted ratio). Control: medianBias -0.700, m0 0.8855.
- **2024** (n=4,419 — the figure being decomposed, in-sample for
  control): shipped raw MAE 4.4855 (signed error +0.5201), control raw
  MAE 4.4127 (signed error +0.4561). raw_delta 0.0728. Debiased: shipped
  4.3944, control 4.3670, debiased_delta 0.0274. level_share 0.0454,
  information_share 0.0274. Raw bootstrap: mean_diff -0.0724, CI90
  `[-0.1016, -0.0424]`, **significant**. Debiased bootstrap: mean_diff
  -0.0270, CI90 `[-0.0570, 0.0037]`, **not significant**. Headroom
  (multiplicative, per arm): shipped 0.0106, control 0.0167.
- **2021** (n=4,341, out-of-sample both arms): raw_delta 0.0441
  (shipped MAE 4.6777, control 4.6336), debiased_delta 0.0128. level_share
  0.0314, information_share 0.0128. Raw bootstrap: mean_diff -0.0439,
  CI90 `[-0.0746, -0.0147]`, **significant**. Debiased bootstrap:
  mean_diff -0.0121, CI90 `[-0.0415, 0.0182]`, **not significant**.
  Headroom: shipped 0.0436, control 0.0846.
- **2022** (n=4,359, out-of-sample both arms): raw_delta 0.0015 (shipped
  MAE 4.4448, control 4.4433) — essentially a wash. Raw bootstrap:
  mean_diff -0.0014, CI90 `[-0.0301, 0.0281]`, **not significant**.
  debiased_delta -0.0572 (shipped now LOWER/better once centred).
  Debiased bootstrap: mean_diff +0.0569, CI90 `[0.0316, 0.0826]`,
  **significant** — shipped beats control, the opposite direction from
  2024/2021. Headroom: shipped 0.0605, control 0.1001.
- Production figures being decomposed (-0.4898 / -0.5136 mean signed
  error, pooled): not independently reproduced by this run's per-season
  signed errors, which are pooled differently (this run's 2024 alone:
  shipped +0.5201, control +0.4561 — opposite sign from the pooled
  figures, and the pooling window/seasons behind the cited -0.4898/-0.5136
  were not respecified in the R36/R37 relay). Flagging rather than forcing
  agreement: the pooled production figures may cover a different season
  set or weighting than this unit's per-season replay. Worth a follow-up
  if the Auditor wants the pooled figure reproduced exactly.

## (d) Incumbent to beat

Shipped (`WEEKLY_ENSEMBLE_WEIGHTS`, the live path). This unit does not
propose replacing it. No promotion, no weight change, no `saveWeeklyFit`
call was made. Given the result — the "information" share is not
significant on 2024 or 2021, and reverses against control on 2022 — this
unit's own conclusion is that a promotion case for control's vector
should not be built on the pooled MAE figure alone without addressing why
2022 disagrees.

## Numbers (run)

`node scripts/r25-level-vs-information.mjs` — 4 replay runs (2023 bias +
2024/2021/2022 test), `distributions: false` throughout, seed 20260826
fixed by `replaySeasonWeekly`. Exit 0. `node --test
test/level-information-decomposition.test.js`: 11/11 pass (see
`docs/tdd/level-information-decomposition.tdd.md`).
