# EA-06 drift monitor: pre-registration (committed before any live grade exists)

Unit: EA-06 (ENGINE-SPECS "EA-05 monitor + fallback"; ENGINE-ARCHITECTURE §7.4; ENGINE-00b-b).
Code: `server/services/engine/producers/monitor.js` (`decideDrift`, `RULE`, `alphaFor`),
`server/services/engine/stats/confseq.js`. Simulation: `scripts/engine-monitor-null-sim.mjs`.

## The rule (fixed before live data)

- **Observation.** For each field with a `fallbackField`, one number per graded week. The number is
  the grader's `grade.week.by_field[field].vs_fallback.delta_mean`: the live version minus the fallback
  field, in the primary score (pinball quantile score for `dist`, log loss for `prob`). Both are
  losses, so **positive means live is worse**. A week is one cluster.
- **Sequence.** Two-sided normal-mixture confidence sequence (Robbins; Howard et al. 2021):
  `|S_t − tμ| < sqrt((V_t + ρ) ln((V_t + ρ)/(ρ α²)))`.
  - `ρ = 6 × priorVar`.
  - `V_t` is the sum of predictable variances: prior weight 2, plus a running variance of the
    earlier weeks only.
  - `priorVar` is the larger of two numbers:
    - 2 × the median of `delta_sd² / n_pairs`, the within-week variance of the weekly mean;
    - the sample variance of the weekly deltas across weeks.
- **Fallback:** the cluster floor is met (≥ 4 graded weeks AND ≥ 20 distinct paired players,
  season to date) AND the lower bound is > 0.
- **Recovery (hysteresis):** a fresh window counts only the weeks graded after the flip. It must meet
  the same floor and have an upper bound < 0.
- **Error level:** `α = min(0.10, 1 / k)`, with k = the number of fields that declare a `fallbackField`.
  This is the system budget: one expected false flip per season across all fields together.
- **Version change:** a newly promoted live version starts a new sequence.

## Null simulation (the PRE)

Command: `node scripts/engine-monitor-null-sim.mjs --seasons 2000 --weeks 20`.

Measured on tree `a6e98f07` (commit `4c38fc55`). Running time 7.6 s, deterministic seeds.

- **Setup:** 2000 seasons × 20 weekly checks, 30 or 20 paired players a week.
- **Weekly difference:** shift + week effect `N(0, between²)` + the mean of player draws `N(0, within²)`.
- **Reading the table:** a flip rate at or below α is within the rule. The last column must be ≤ 1.

| scenario | fields k | α | null flip rate | expected false flips / season (k × rate) |
|---|---|---|---|---|
| within only (between 0) | 1 / 10 / 20 | 0.1 / 0.1 / 0.05 | 0.0015 / 0.0015 / 0.0005 | 0.002 / 0.015 / 0.010 |
| between = within/√n | 1 / 10 / 20 | 0.1 / 0.1 / 0.05 | 0.0175 / 0.016 / 0.0085 | 0.018 / 0.160 / 0.170 |
| between = 3 × within/√n | 1 / 10 / 20 | 0.1 / 0.1 / 0.05 | 0.041 / 0.053 / 0.0305 | 0.041 / 0.530 / 0.610 |
| 20 players, between 0.5 (between dominates) | 1 / 10 / 20 | 0.1 / 0.1 / 0.05 | 0.052 / 0.044 / 0.0315 | 0.052 / 0.440 / 0.630 |

**Result:** every scenario is within its α, and the whole-system expected false flips per season are
≤ 0.63, under the budget of 1.

**Power:** effect in weekly-sd units, α = 0.1, 20 weeks.

| scenario | effect 0.5: power / median weeks to flip | effect 1.0: power / median weeks to flip |
|---|---|---|
| within only | 0.22 / 15 | 0.93 / 12 |
| between = within/√n | 0.42 / 13 | 0.96 / 8 |
| between = 3 × within/√n | 0.48 / 10 | 0.97 / 7 |
| between dominates | 0.49 / 10 | 0.96 / 7 |

**Ablation:** why the cross-week variance is in the rule. With `priorVar` from the within-week
variance alone, the same null simulation breaks the budget:

- between = 3 × within/√n: rate 0.125 at k = 1 (α 0.1), and 2.1 expected false flips per season at k = 20.
- between dominates: rate 0.095 at k = 1, and 1.23 expected false flips per season at k = 20.

A test pins this (`N1` in `test/engine-monitor.test.js`), and the mutant that drops the term dies.

## What is assumed, and what would make it wrong

- **Weekly deltas are treated as independent across weeks.** A slow common trend in both producers
  cancels in the paired difference. A trend in only one of them is the drift the monitor exists to catch.
- **The observed variance and cluster structure are unknown.** No grade row exists yet: no producer on
  this stack writes a graded `dist`/`prob` field with a `fallbackField`. The scenarios above bracket
  the structure instead of measuring it. Re-run the simulation at the measured between/within ratio
  once the grader has ≥ 4 weeks of `vs_fallback`.
- **Heavy tails are not simulated.** A single-week outlier larger than about 3 sd of the weekly mean can
  move the bound more than the Gaussian model allows.
- **Stat corrections.** A correction to a week already graded replaces that week's observation. The
  sequence is recomputed from the stored weeks, so the path is not strictly append-only. The effect
  is bounded by one week.
