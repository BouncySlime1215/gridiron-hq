---
name: gridiron-randomized-pit-noise-band
description: Coverage and calibration-error figures from the repo's randomized PIT carry a +-0.007/+-0.008 RNG stream-position band at n~4300; no gate may be decided on a margin inside it, and the repo's own coverage gate is only 2.9x that band wide.
metadata:
  type: project
---

Measured by Data & techniques R&D, #20 re-reports section R4, 2026-09-22, over 40
re-draws. Auditor accepted and promoted it to a standing rule the same day.

**The band:** randomized PIT (`weekly-backtest.js:46`) makes coverage and
calibration error depend on RNG stream position. At n ≈ 4,300:
**coverage ±0.007, calibration error ±0.008.** It scales as 1/√n, so at a week
bucket of n ≈ 1,200-1,600 the band is **±0.011 to ±0.013**.

**Why:** the PIT breaks ties by randomisation, so two runs on identical data and
an identical seed-setting but a different stream position give different figures.

**How to apply:**
- No gate decision on a margin inside the band. A 0.01 coverage gap is noise.
- Carry the band, scaled to that row's n, on every coverage or cal.err figure.
- When two configurations differ by less than the band, they are not separated —
  do not attribute the difference to either. (This is how the auditor refused
  "the coverage offset is a rig property, not draw count": 200 → 300 draws moved
  coverage +0.009/+0.008, barely outside ±0.007, so neither component was
  separated.)

**It reaches production.** `scripts/fit-weekly-coverage.mjs` already warns at
:26-31 that draw count and seed move coverage by more than the band's margin,
without quantifying it; this is the measurement. That gate is `TARGET=0.80`,
`GATE=[0.78,0.82]` at `:79-81` — **±0.02, only 2.9× the band** — so one draw can
flip a true value sitting near either edge. **Queued recommendation: evaluate the
gate as a median over k re-draws rather than a single run.** Not yet built.

Also settled here: `replaySeasonWeekly` defaults `opts.seed` to **20260826**
(`weekly-backtest.js:91`), so a caller passing no seed is already on the gate's
seed. The auditor's earlier "#20 ran with no stated seed" was wrong and is
corrected; #20's real departures from the gate were **draw count (200 vs 300) and
eval seasons (2023-24 vs 2025)**.

**CRPS has a SEPARATE band, from the Monte-Carlo draws rather than the PIT
tie-break, measured 2026-09-22: sd 0.00392 at 300 draws, n≈4,300. Do not reuse
this band for CRPS** — see [[gridiron-crps-redraw-band-and-pipeline-resolution]],
which also carries the rule that a bootstrap with the simulation frozen is only
a lower bound on a gate's resolution.

See [[gridiron-mae-optima-are-medians]], [[gridiron-offline-rig-evidence-line]].
