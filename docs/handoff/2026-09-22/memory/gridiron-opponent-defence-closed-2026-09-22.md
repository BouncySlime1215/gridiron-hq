---
name: gridiron-opponent-defence-closed-2026-09-22
description: Opponent defence for the fantasy projection is closed on its own measured ceiling (2026-09-22) — and the contamination trap that made a same-week team-aggregate oracle lie by 29x.
metadata:
  type: project
---

**Sixth Phase A feature, declined — and unlike the other five, declined on its
CEILING rather than on a forecasting failure.** Evidence:
`docs/evidence/2026-09-22/opponent-defence-the-oracle-was-the-player.md`
(commit 132f44d3, LOCAL on `claude/project-thread-w0gpjt`, unpushed).

This was the one candidate reopened after the wiring audit killed the
"already covered" argument ([[gridiron-opp-adj-def-epa-wiring]] —
`opp_adj_def_epa` is betting-only; no fantasy service references it). It is now
properly closed.

**Design that closed it.** Rolling origin with the training span fixed at 3
seasons (test S trained on [S-3, S-1]), 5 replicates 2021-2025, so era and
training-set size no longer move together as they did in the old split-half.
n_train drifts only 8,879 -> 10,005. 16,620 out-of-sample predictions, baseline
R2 0.32957, MSE 39.1348, var(y) 58.373.

**The result.** Even a leave-the-player-out hindsight measure of the opponent's
pass defence in the predicted week — the ceiling of any opponent-defence
feature — gives dMSE +0.0533, CI [-0.0065, +0.1156], 3/5 seasons. The
optimistic end of that is +0.00198 R2, 0.3% of the model's error. The causal
prior-weeks estimator gives +0.0265, CI [-0.0303, +0.0831]. Shuffled and no-op
controls both null. Consistent with [[gridiron-weekly-ceiling-2026-09-22]].

**THE TRAP, and this is the part to carry forward.** The first positive control
was the opponent's ACTUAL pass EPA allowed that week. It fired at **+1.5496
MSE, 5/5 seasons** — huge, clean, and entirely an artifact. A receiver who goes
for 30 points IS part of what made that defence look bad. Rebuilt from
play-by-play excluding the player's own targets, the same feature gives
+0.0533. **The two versions correlate +0.9530.** About 97% of the apparent lift
lived in 5% of the variance.

**Why:** any feature built from a SAME-WEEK TEAM AGGREGATE contains the
player's own contribution to that aggregate. Team passing volume this week,
team red-zone trips this week, opponent yards allowed this week — identical
shape. The correlation between the contaminated and clean versions looks
reassuringly high and tells you nothing.

**How to apply:** before trusting any same-week team-aggregate feature or
oracle, rebuild it from play-by-play with the player's own plays removed and
re-run. If the lift collapses, it was the target. A high correlation between
the two versions is NOT evidence the contamination is small.

**Honest limit.** What is dead is TEAM-LEVEL pass defence quality. A specific
CB-on-receiver matchup or scheme-level coverage against a route tree is a
different feature this says nothing about — and both are behind paid feeds
([[gridiron-free-data-first-rule]], `docs/data/missing-data-register.md`).
Do not re-open the team-level version; do not treat this as closing the
matchup-level one.

Also see [[gridiron-phase-a-feature-verdicts]],
[[gridiron-phase-a-baseline-caveat]], [[gridiron-five-questions-rule]].
