---
name: gridiron-conformal-beats-interval-layer-2026-09-22
description: A binned multiplicative conformal predictive distribution beats the fitted simulation layer on calibration and CRPS in both seasons at the repo's own draw count; G1 unestablished; the first published run calibrated on the prior season only, not rolling.
metadata:
  type: project
---

Package #20, 2026-09-22, RE-REPORTED the same day (sections R0-R6 of the spec).

**Three corrections that outlive the numbers:**
1. **The published run's "rolling" calibration was not rolling.** `grab()`
   dropped `week`, so `r.week < w` was always false and every week calibrated on
   the PRIOR SEASON ALONE. Intended rolling is BETTER on every figure
   (2024 cal.err 0.042 vs 0.076), so the conclusion survives; the description
   did not match the run. Fix lives in `cp-rerun.mjs`.
2. **The draw SEED was never a difference.** `replaySeasonWeekly` defaults
   `opts.seed` to 20260826 (`weekly-backtest.js:91`) — the repo gate's own seed.
   Only the draw count (200 vs 300) and the eval seasons differed. Re-run at 300
   on both sides: conformal 0.794/0.040 and 0.799/0.034 vs incumbent 0.769/0.090
   and 0.787/0.063, CRPS -0.077 [-0.099,-0.054] and -0.042 [-0.060,-0.024].
   **The incumbent is BETTER at 300 than at 200, so the published 200-draw
   comparison under-rated it.**
3. **The randomized PIT carries real RNG noise: cal.err +-0.008, coverage
   +-0.007 at n~4,300** (40 re-draws from stored atom counts). It explains the
   published 0.065/0.055 exactly (inside the prior-only bands). **A G2 decided
   on a 0.01 gap would be noise.** This applies to ANY use of
   `weekly-backtest.js:46`, not just here.

 Record `/mnt/project-files/CONFORMAL-SPEC.md`, script
`cp-test.mjs`. Strongest R&D result so far: it beats a **fitted, defended**
incumbent on **the repo's own pre-registered gate**, not a metric I chose.

Gate, from `scripts/fit-weekly-coverage.mjs`: G1 coverage_80 in [0.78, 0.82];
G2 calibration error strictly lower; G3 CRPS not significantly worse.

**Rolling calibration (prior season + the eval season's earlier weeks — the
shape a deployment actually has):**

    eval 2024 (n=4,343)  incumbent cov 0.761 cal .107 crps 3.313
                         conformal cov 0.792 cal .065 crps 3.238
                         crps -0.075 [-0.097, -0.053] SIG BETTER
    eval 2023 (n=4,306)  incumbent cov 0.778 cal .082 crps 3.184
                         conformal cov 0.801 cal .055 crps 3.137
                         crps -0.047 [-0.065, -0.030] SIG BETTER

**The winning construction (arm D):** point prediction x 200 quantiles of
held-out residual **RATIOS** (multiplicative), **binned into 5 quantile bins of
the predicted level**, cut points from calibration data only, 50-row floor,
clamped at 0. 200 to match the incumbent's 200 sims exactly.

Arms B (ratios, unbinned) and C (residuals, binned) failed in **opposite**
directions — B calibrated but blunt, C sharp but miscalibrated. That pattern is
what pointed at the hybrid; D was built from it, not found by search.

**MANDATORY: use the repo's randomized PIT (`weekly-backtest.js:46`).** A
conformal distribution has heavy atoms (many rows share the clamped zero); the
plain `P(X<=y)` transform piles every tie into one bin and reports ~0.63
calibration error that is pure artefact. My first run did exactly that.

**Note in the incumbent's favour, stated anyway:** the repo fitted `WEEKLY_LEVEL`
on 2023+2024, my two eval seasons, so the incumbent may be partly in-sample here
and still loses.

**Touches no point projection** — uncertainty layer only, so MAE/Spearman are
unchanged by construction. A build should ASSERT that they are.

**Unswept hyperparameter, stated:** 5 bins with a 50-row floor is one arbitrary
choice, picked once, never swept (a sweep would risk selecting on the eval
seasons).

Related: [[gridiron-offline-measuring-rig-2026-09-22]],
[[gridiron-five-questions-rule]].
