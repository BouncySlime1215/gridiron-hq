---
name: gridiron-redzone-bands-corrected
description: end_zone_targets is targets inside the TEN despite its name; the rushing tier pools bands 3.53x apart, the receiving one 1.41x — and a ratio between bands is NOT an effect size, which cost two threads a wrong call.
metadata:
  type: project
---

Measured 2026-09-22 on nflverse pbp REG 2022-2025 (two-point attempts
dropped), after the integration thread caught a misread. Line numbers verified
on the source.

**The naming trap.** `nfl-pbp.js:398` is
`if (yl100 != null && yl100 <= 10) p.ez_tgt++;`, emitted at `:641` as
**`end_zone_targets`**. It is targets inside the TEN, not end-zone targets.
`REC_CLASSES` (`td-regression.js:69-73`) therefore already separates <=10 from
11-20 on the receiving side. Anyone reasoning from the name will conclude the
opposite of what the code does.

**Rushing — a real gap.** `nfl-pbp.js:371` counts `p.rush_rz++` at
`yl100 <= 20`, `:372` counts `p.rush_gtg++` on goal-to-go, and **no inside-10
rush counter exists anywhere**, so the middle tier pools:

| band | carries | TD rate |
|---|---:|---:|
| inside 10, goal-to-go | 4,152 | 0.3184 |
| inside 10, not goal-to-go | 1,040 | 0.1615 |
| 11-20 | 5,002 | 0.0458 |
| outside 20 | 48,470 | 0.0053 |

**3.53x** across the pooled tier. Pooled it prices at 0.0657: a back whose
red-zone work is all inside the 10 is underpriced 59%, one who never gets
inside the 10 overpriced 43%. Worth a counter and a tier.

**Receiving — NOT ESTABLISHED (not "does nothing").** The only thing pooled
there is goal-to-go with the rest of inside-10: 0.4069 (3,087 targets) vs
0.2885 (915), **1.41x**, minority slice 23% of volume. The counter exists
unused (`nfl-pbp.js:400` writes `p.gtg_tgt++`, `:642` emits
`goal_to_go_targets`, `REC_CLASSES` never reads it), so it costs no
`nfl-pbp.js` edit and an old database already has it.

**A RATIO BETWEEN BANDS IS NOT AN EFFECT SIZE.** I first dismissed the
receiving tier because 1.41x looked small next to 3.53x. Wrong, and it cost
two threads a wrong call. The integration thread's decomposition (5,229 rows,
paired, player-clustered, 2,000 resamples, seed 20260917) on MAE 0.27196
baseline:

| arm | vs baseline | 95% CI | zero |
|---|---:|---|---|
| 4 rush / 3 rec | -0.230% | [-0.001019, -0.000053] | excluded |
| 3 rush / 4 rec | -0.456% | [-0.002076, +0.000418] | INCLUDED |
| 4 rush / 4 rec | -0.684% | [-0.002678, -0.000125] | excluded |

The receiving half has TWICE the rushing half's point estimate and the two are
almost exactly additive. What decides worth is the volume in each band and how
badly the pooled rate misprices the players in it, not the ratio. The
receiving tier is unestablished because its **interval includes zero**, not
because 1.41x is small.

**How to apply:** never rank two candidate splits by their band ratios. Rank
them by a paired ablation with an interval. And when an ablation moves two
things at once, its number establishes the PAIR — decompose before attributing
it to either half.

**MIGRATION HAZARD, applies to any new opportunity class.**
`td-regression.js:195-201` is
`out[c.key] = Math.max(0, raw - (f[c.subtractFrom] ?? 0))`. Re-point a class
at a NEW counter and, on any database ingested before the counter existed, the
`?? 0` makes the subtraction a no-op and the parent silently starts
double-counting again — the exact treble-counting the comment at
`td-regression.js:55-62` exists to prevent, inflating expected touchdowns for
goal-line backs. **Any new class needs an explicit fallback to the old parent
when the new counter is absent.**

Also corrected: `nfl-advanced.js` week-0 skip is the comment at `:111` and the
skip at `:112` on 654ff93, not `:106`.

Spec: `REDZONE-SPEC.md` (CORRECTION FIRST section) + `redzone-bands.json`.
