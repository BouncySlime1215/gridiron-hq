---
name: shrink-weight-is-an-accidental-availability-weighting
description: In projections.js the shrink weight n/(n+k) counts weeks with a known share, so a player who misses games is shrunk harder — an availability weighting nobody designed.
metadata:
  type: project
---

`projections.js:599` interpolates the observed target share toward the prior
with weight `n/(n+k)`, where `n` is `a.tgtShareW` — a sum of role weights over
weeks with a **known** share. A player who misses games carries a smaller `n`
and is therefore shrunk harder toward the prior. **That is an availability
weighting, and nobody designed it.**

It compounds with a support mismatch. Three quantities, three definitions of
which weeks count (verified 2026-09-22):

| quantity | line | zero-target weeks |
|---|---|---|
| observation | `projections.js:515` | included |
| prior `positionalPriors()` | `projections.js:408` | included (gated `> 0` before 2026-09-22) |
| `k` for `target_share` | `shrinkage-fit.js:329-330` | **excluded** |

**Exactly one of the three has always been the odd one out**; the 2026-09-22
change moved which one rather than creating the mismatch. Because `k` was fitted
on the zero-excluded support, its value is calibrated against a different `n`
scale than the one it is divided into, so **the contamination is n-dependent,
not a uniform offset.**

**How to apply:** before laying an availability multiplier over this path, know
that availability is already being priced implicitly at an unknown,
player-varying rate — stacking one on top double-counts. The cheap check is to
correlate each player's understatement (zero-included mean share minus
zero-excluded) against his `n`: uniform contamination predicts no relationship,
the n-dependent account predicts a negative one. See
[[a-low-projection-is-an-accidental-availability-hedge]].
