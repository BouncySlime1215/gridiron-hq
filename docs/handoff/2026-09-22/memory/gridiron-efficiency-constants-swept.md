---
name: gridiron-efficiency-constants-swept
description: Gridiron HQ's three hand-set efficiency shrinkage constants were swept and graded on 2026-09-20 and they hold — so nobody re-opens them as "made up"; the one real finding is that yards_per is a single constant serving three metrics that disagree about it.
metadata:
  type: project
  modified: 2026-09-20T07:26:25.250Z
---

Done 2026-09-20 on Nick's "do we guess or is that fr tested". Scripts on
`claude/project-thread-w0gpjt-hold` at **114a19d** (no PR, freeze intact):
`scripts/grade-efficiency-vs-baseline.mjs` and
`scripts/grade-proportion-shrinkage.mjs`. Write-up in
`docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md`, ledger rows **D30-D33**.

## What was tested, and why it counts

`projections.js:94-125` carries five efficiency constants. `int_rate: 1600` was
already swept and graded. `yards_per: 34`, `catch_rate: 26`, `td_rate: 70` never
were — and [[gridiron-what-is-actually-tested]]'s rejection
(`shrinkage-fit.js:465-473`) tested the **fitter**, not the literals.

Design: every arm is the real `buildProjections` with a `kOverride` moving one
family and nothing else; every arm passes an override, so the **volume** half
sits at hardcoded constants in all arms whichever fit is active; `k = 0` and
`k = Infinity` are in the grid, so "his own rate" and "the prior alone" come out
of the same machinery; the gate is on **forward** usage, which is no arm's
input; paired bootstrap **clustered by player**.

## The answers

- **Nothing on a nine-point grid beats any of the three literals on 2024-2025**
  (20 cutoffs, 2,811 receiving rows / 259 players). **Every value below each
  literal loses**, most with the interval clear of zero. Do not call them made up.
- **But five of six MAE curves bottom out above their literal**, and on **2023,
  a season the grid never saw, `k = 68` beats the shipped 34 for yards per
  target**, 90% CI **[+0.0036, +0.0482]** — chosen on one set, confirmed on
  another, which is this repo's own promotion shape.
- **Yards per carry wants 68 on 2023 and 34 on 2024-2025; yards per attempt
  wants 34 on 2023 and 300 on 2024-2025.** So the finding is **not "34 is
  wrong"** — it is that **one constant is doing three jobs**. Split `yards_per`
  per metric (and per position, as the volume half already does) and re-fit,
  through a gate. `projections.js` is the **fantasy plan's** file.
- **The wrong-helper rule is real and costless.** `stats-util.js:31-48` says use
  `shrinkRate` for proportions; every caller is MLB; `projections.js:564-578`
  uses plain `shrink` on catch rate and the TD rates. Measured: arcsine is
  slightly **worse** on all three, and on catch rate (2,162 rows, 251 players),
  where its own reasoning predicts the biggest gain, there is none. **Leave it —
  tidying it up loses ground.**
- **Withdrawn (D33):** the touchdown-rate low bias (-0.0060 receiving on
  2024-2025) is not stable — 2023 came back at -0.0014. Not a calibration defect.

Still open and untouched by all this: the outside-signal arm (aDOT, air-yards
share, CPOE, RACR, PACR). The sweep says the estimator is well tuned **within
its family**; it says nothing about whether that family is the right one.

See [[gridiron-bootstrap-clustering-trap]] · [[gridiron-what-is-actually-tested]] · [[gridiron-model-audit-open-findings]]
· [[gridiron-audit-findings-ledger-2026-09-20]].
