---
name: gridiron-partial-pooling-weekly-blend-null
description: Measured null — per-player partial pooling of the weekly blend weight does not beat one pooled alpha on held-out data; position-level pooling is already sufficient at this n.
metadata:
  type: project
---

Measured 2026-09-22 on the rig. Pre-registration published BEFORE the run and
unchanged after it: `/mnt/project-files/POOLING-PREREG-2026-09-22.md`; script
`pooling.mjs`.

**Design:** `pred = (1-a) E + a STD` with E = the position ensemble
(`candidate_heads.active_champion`) and STD = `season_to_date`. Control = one
pooled `a`; candidate = `a_i = (n_i ahat_i + k a)/(n_i + k)`. Rolling (prior
season + earlier weeks, size-per-week check printed and strictly increasing).
k chosen on 2023, frozen, tested on 2024. 2025 untouched.

**Result: NULL.** 2024 n=4,343: control 4.4660, candidate 4.4667,
**+0.0007 [-0.0097, +0.0111]**, point estimate on the wrong side of zero. The
2023 gain (whole k range spans 0.0103) did not reproduce at all — a validation
gain that was selection, which is why k was frozen first.

**Conclusion: position-level pooling is already sufficient at this sample size.
A player's own history does not usefully move his blend weight.** Do not
re-propose per-player blend weights without a materially larger n or a
different parameterisation.

**Trap recorded, do NOT quote as a finding:** on the rig the shipped weights
read 4.5251 while both fitted arms read ~4.466, and plain season_to_date beats
the promoted champion (4.4976 vs 4.5251 in 2024). That is the rig's DEGRADED
STRUCTURAL HEAD (`nfl_snaps`, `nfl_qbr_weekly`, `nfl_depth` empty), not evidence
against the shipped ensemble. Any weight fitted on this rig is biased against
structural; that is why the comparison was arranged between two arms that both
inherit the same head. [[gridiron-offline-measuring-rig-2026-09-22]]

Mean signed error negative for both arms (-0.4954, -0.5462), matching
`weekly-ensemble.js:69-77` in sign. [[gridiron-mae-optimum-is-the-weighted-median]]
