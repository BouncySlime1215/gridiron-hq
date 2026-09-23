# PROJ-03-a-v2: shared game path (pre-registration)

Stage 3 (SIMULATE) of the ONE ENGINE. Written before any v2 number was computed.

## 1. What is being tested

One seeded path per game. Each team's points are drawn from exactly the incumbent
baseline, `Normal(Vegas implied team total, one pooled sd)`. The only new thing is the
shared path: the two teams' residual z-scores are joined with one correlation `rho`, and
every player in the game reads the same path (same key -> same draw), so start/sit ranges
and title odds get game correlation for free.

Lesson carried from v1 (PR #215, declined): per-|spread|-bucket sd made CRPS worse. v2 has
one pooled sd and one pooled rho. No buckets.

Parameters (fitted in memory, no table):
- `implied = total/2 - spread/2` (the same arithmetic as gamescript.js impliedPoints; pace
  and win probability are read from `gameScriptFor`, never refit).
- `sd` = standard deviation of team residuals (points - implied), both sides of every game.
- `rho` = Pearson correlation of (home residual, away residual), one row per game.

## 2. Split

Fit on 2021-2022 closing lines (home rows, scored). Grade 2023 and 2024 separately, each
with the same 2021-22 fit. 2025 is never opened. Data: a local copy of data.sqlite.

## 3. Metrics and the kill test

1. Marginal CRPS: the sampler's Monte Carlo CRPS of team points vs the closed-form CRPS of
   `Normal(implied, pooled sd)`. Pass: sampler <= baseline + 0.01 in both seasons (should
   be equal by construction; this is a correctness check).
2. Joint energy score of (home points, away points): path sampler vs an independent-Normal
   pair with the same marginals, common random numbers, M = 4000 draws per game.
   Per-game difference `d = ES_path - ES_indep` (negative = path better). 95% CI from the
   shared deterministic weekly-cluster bootstrap (`weeklyClusterBootstrap`, 4000 trials).
   Pass: CI upper bound < 0 in BOTH 2023 and 2024.
3. Team-pair correlation: correlation of simulated residuals vs the graded season's
   historical residual correlation, with a 90% weekly-cluster bootstrap CI (seeded).
   Pass: simulated value inside the CI in both seasons.

Kill rule: if (2) fails in either season, DECLINE. The shared path adds nothing to the
joint distribution, the plain independent Normal stays, nothing is served, and only this
study code and doc are pushed.

Command (read-only, local copy):

    SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=.local-db/data.sqlite node scripts/proj03a-calibration.mjs

## 4. Result

(filled in after the run)
