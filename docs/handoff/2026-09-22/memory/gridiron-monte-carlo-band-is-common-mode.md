---
name: gridiron-monte-carlo-band-is-common-mode
description: The simulation re-draw band is per-gate CI inflation AND a common-mode shift across every gate run at the same default seed — so N gates at one seed are not N independent confirmations, but candidate ORDERING against a shared incumbent carries zero draw noise.
metadata:
  type: project
---

Auditor ruling 2026-09-22 (§R20.1), on Explorer's measured CRPS re-draw band.

**The measurement (accepted, arithmetic reproduced).** 40 stream positions, seeds
20260900+k, same rows, averaged `r._errors.crps` at full precision because
`r.distribution.crps` rounds to 2dp. 2024/300 runs: mean 3.30607, sd 0.00392,
n=4,343. 2024/200: 3.31109, sd 0.00467. 2023/300: 3.17753, sd 0.00366, n=4,306.
Mechanism confirmed, not just asserted: 1/sqrt(runs) predicts sd(200)/sd(300) =
sqrt(1.5) = 1.2247, measured 1.191, and at n=40 the sd of an sd is ~11.3% so the
ratio carries ~16%.

**The hash split is the load-bearing move.** The point-prediction vector is
byte-identical across all 40 seeds (one hash over `player_id|week|prediction|
actual`), so a conformal arm — whose sample is quantiles of calibration
residuals — carries ZERO re-draw noise. `delta = conformal - simulated` therefore
inherits the simulated arm's draw noise exactly, which is why quadrature (not
doubling) is the right combination. **Determinism is demonstrated by hash, never
by argument.** Conformal vs conformal: band is exactly zero, bootstrap CI alone
is the complete resolution.

**Carried, not retired:** the band is 3.5x below the bootstrap SE (0.00392 vs
0.01368) — not an order of magnitude — so it applies on any gate with a simulated
arm. Applied to #20: 2024 delta -0.077, half-width 0.0225 -> 0.0234; 2023 -0.042,
0.0180 -> 0.0190; +4.0%/+5.4%, both still exclude zero, verdict stands.

**THE AUDITOR'S ADDITION — a different error mode, not a caveat.** Every gate
evaluates the incumbent at the SAME default seed (`weekly-backtest.js:91`,
`opts.seed ?? 20260826`), so the draw error `e` is **common-mode across gates**.
1. **N gates at one seed are NOT N independent confirmations** — they all inherit
   the same `e`, same direction, same season. Never aggregate them as independent
   evidence that an incumbent stands.
2. **The gift:** for two candidates graded against the same incumbent draw,
   `delta_g - delta_h` has ZERO draw noise; `e` cancels. **Candidate ORDERING
   against a common incumbent needs no band. Only the margin-vs-incumbent does.**

And 20260826 is one draw, not the centre: 2024/300 reads 3.30981 vs mean 3.30607
(0.95 sd high, flatters -0.077 by ~5% of the effect); 2023/300 3.17536 vs 3.17753
(0.59 sd low). Inside the band; no verdict moves.

Related: [[gridiron-randomized-pit-noise-band]] (the same shape for coverage),
[[gridiron-auditor-thread-standing-2026-09-22]].
