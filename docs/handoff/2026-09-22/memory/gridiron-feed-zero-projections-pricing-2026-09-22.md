---
name: gridiron-feed-zero-projections-pricing-2026-09-22
description: "What the projections.js:492 zero-snap contamination is worth, with its two limits and the n-dependence that falls rather than rises (Auditor R39, 2026-09-22)"
metadata:
  type: project
  modified: 2026-09-22T16:53:38.236Z
---

The pricing behind [[gridiron-feed-zero-class-closed-2026-09-22]]. Script:
`docs/evidence/feed-zero-projections-target-share.mjs` on branch
`claude/project-thread-2oztzw`.

Reproduces the site's own weighting (`RECENCY.seasonDecay 0.35`,
`weekHalfLife null`, so `rowWeight = 0.35 ** (through - season)`), through 2024.

| | |
|---|---|
| rows entering the `:492` gate | 10,505 (95.9% matched to a snap row) |
| of those, `offense_snaps = 0` | 364 |
| players affected | **113 of 627 (18.0%)** |
| mean understatement | 0.0059 share |
| **ratio of means — quote this one** | **21.5%** |
| mean of per-player ratios | 34.1% |
| mean contaminated base | 0.0276 share |

**34.1% is a mean of ratios and does not invert to a base** — `0.0059 / 0.341`
recovers nothing, because the two are different statistics. The base 0.0276 is
not a starter's target share, and that is the point: **the affected players are
disproportionately fringe players**, which is exactly who misses snaps.

## Two limits, always carried with the number

1. It measures `tgtShareObs`, the **input to `shrink()`**, not the served
   projection. The shrink step and the prior sit between, both damping it, so
   it is an **upper bound**.
2. Snap files covered 2023-2024 only; seasons at `back >= 2` are absent, worth
   `0.35^2 = 0.1225` and below — **under 9%** of the weight.

Unmatched rows (4.1%) were kept in the gated mean, so a failed join cannot
manufacture the effect.

## The n question (Auditor R39.2) — it FALLS with n

Shrinkage is `n / (n + k)`, and the observation's `n` counts the zero rows
while the prior's does not, so an n-dependence would be hidden by a mean over
113 players. Measured, it goes the other way:

- Pearson **−0.220** on raw row count; **−0.269** on the weighted n that `:522`
  actually passes to `pickK`. Spearman −0.097 / −0.129.
- By bucket, monotone: n=1-4 **74.1%** of base, n=5-9 29.8%, n=10-19 17.5%,
  n=20-99 **11.3%**.

**Both consequences, not just the flattering one.** It *reduces* the served
impact, since low `n` means those players are shrunk hardest toward the prior.
And it *sharpens* the three-support mismatch: the players most affected by the
contaminated observation are the ones whose projection is dominated by a prior
fit on rows the observation does not use — so the disagreement matters most
exactly where it is hardest to see.
