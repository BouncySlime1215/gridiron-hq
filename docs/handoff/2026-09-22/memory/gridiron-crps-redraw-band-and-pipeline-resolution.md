---
name: gridiron-crps-redraw-band-and-pipeline-resolution
description: CRPS carries its own Monte-Carlo re-draw band (sd 0.0039 at 300 draws, n~4300) whenever a simulated arm is in the comparison; a bootstrap with the simulation frozen is only a LOWER BOUND on a gate's resolution.
metadata:
  type: project
---

Measured by the Explorer 2026-09-22 on the Auditor's R15 order, 40 stream
positions (seeds 20260900+k, the same positions R4 used for the PIT band).
Script `/mnt/project-files/crpsband.mjs`, output `crpsband.out`, written up as
`CONFORMAL-SPEC.md` §R8.

**THE RULE (register it in every pre-registration): the resolution of a gate is
the noise of the WHOLE PIPELINE that produces the number, not of one
component.** A paired bootstrap resamples rows with the simulation frozen, so
it answers "would other players have given a different answer" — never "would
another simulation have given a different answer". **It is a lower bound.**

**The band, incumbent mean CRPS:**

    season  runs   n       mean      sd        half-range
    2024    300    4,343   3.30607   0.00392   0.00893
    2024    200    4,343   3.31109   0.00467   0.00992
    2023    300    4,306   3.17753   0.00366   0.00806

Mechanism check: sd should scale as 1/√runs, predicted 1.225× from 300 to 200,
**measured 1.19**. It behaves like simulation noise because it is.

**WHICH GATES IT BINDS — measured, not assumed.** The point-prediction vector
is **byte-identical across all 40 seeds** (one hash over
`player_id|week|prediction|actual`). So:

- **A conformal arm carries ZERO re-draw noise** — its sample is quantiles of
  calibration residuals, a deterministic function of predictions and actuals.
  **Conformal vs conformal (e.g. the bin-cut unit's arm D vs E): the bootstrap
  CI alone is the complete resolution.** That unit's 0.15 ratio is unaffected.
- **Conformal vs the SIMULATED incumbent: carry the band.** Combine standard
  errors (bootstrap half-width / 1.645, in quadrature with the re-draw sd).
  On #20: half-width 0.0225 → 0.0234 (2024) and 0.0180 → 0.0190 (2023),
  **inflation 4.0% and 5.4%, both intervals still excluding zero.**

**NOT retired.** The Auditor's stand-down condition was "an order of magnitude
below the bootstrap CI". It is **3.5×** below, so the band must be carried on
any gate with a simulated arm; only a demonstrated-deterministic arm escapes,
and the demonstration is the hash, not an argument.

**The default seed is one draw, not the centre.** At 2024/300 seed 20260826
reads 3.30981 against a 40-seed mean of 3.30607 — the incumbent drew *worse*
than average, flattering #20's published −0.077 by ~5% of the effect. At
2023/300 it reads 3.17536 against 3.17753, drawing *better*, so −0.042
understates the gain. Neither moves a verdict; both belong in the write-up.

Note `r.distribution.crps` is rounded to 2dp and cannot see this band — average
`r._errors.crps` instead.

Related: [[gridiron-randomized-pit-noise-band]],
[[gridiron-conformal-beats-interval-layer-2026-09-22]],
[[gridiron-gate1-state-the-best-case]].

**COMMON-MODE (Auditor R20, 2026-09-22).** Every gate evaluates the incumbent
at the same default seed **20260826** (`weekly-backtest.js:91`), so the draw
error is one realisation reused, not a fresh draw per gate.
1. **N gates at one seed are NOT N independent confirmations** — never
   aggregate them as independent evidence that an incumbent stands.
2. **A difference of two deltas against a common incumbent carries ZERO draw
   noise** (the incumbent term cancels). So **ordering candidates against a
   common incumbent needs no band**; only the margin *against* the incumbent
   does. This is the operative form of the rule.

**Also registered (R20):** a verdict that survives a new instrument is
**amended, never re-opened as a unit**. §R8 is a record amendment to #20's
R1-R3, not a new gate.
