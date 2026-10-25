---
name: gridiron-yards-per-target-is-noise
description: yards_per_target (a served feature) has ICC 0.081 and needs ~11 weeks to trust; aDOT is 7x more repeatable, free, and already in the database.
metadata:
  type: project
---

Measured 2026-09-22 on nflverse 2023-2025 REG, 552 players / 6,216
player-weeks (>=3 targets in the week, >=6 such weeks per player-season).
Flat weight throughout, because ICC is not invariant to the weighting scheme
([[gridiron-icc-weighting-invariance]]).

| metric | ICC | weeks to half-trust |
|---|---:|---:|
| actual aDOT (`air_yards`) | 0.560 | 0.79 |
| route-implied aDOT | 0.530 | 0.89 |
| targets in the week | 0.302 | 2.31 |
| receiving yards | 0.247 | 3.06 |
| yards per reception | 0.169 | 4.90 |
| catch rate | 0.143 | 6.02 |
| **yards per target** | **0.081** | **11.43** |
| PPR per target | 0.047 | 20.52 |

**`yards_per_target` is a named feature (`server/services/nfl-features.js:148`)
and is served at `projections.js:729` and `routes/edge.js:417`.** It needs
about eleven weeks of a player's own targets before his figure should outweigh
the league's. aDOT needs less than one — seven times more repeatable, free in
play-by-play as `air_yards`, and already in `nfl_ngs`.

**Why:** per-target efficiency at weekly scale is almost entirely which
targets happened to be thrown, not who the receiver is. Usage repeats;
efficiency does not.

**How to apply:** where a surface shows or reasons over a receiver's
per-target efficiency on a short window, it is showing noise — put aDOT beside
it, and never let a few weeks of `yards_per_target` drive a ranking. If it
must be used, shrink it with k = 11.43 through the existing
`shrink(observed, prior, n, k)`.

**A trap in the same data:** the nflverse route taxonomy CHANGED after 2022.
Six labels (ANGLE, CROSS, FLAT, HITCH, IN, OUT) exist only in 2022; seven
(TEXAS/ANGLE, SHALLOW CROSS/DRAG, HITCH/CURL, IN/DIG, QUICK OUT, DEEP OUT,
SWING) only from 2023. A fit spanning that boundary fails silently, not
loudly. Use 2023 onward, or write the mapping by hand first — FLAT has no
obvious single successor.

**Untested, do not build yet:** route mix is 77% air yards re-expressed
(corr 0.877, r2 0.770), but the residual still repeats at ICC 0.134. Stable is
not the same as useful; it needs a walk-forward test against a projection that
already has target share and aDOT, plus the `nfl-model-watch.js:1-18` ablation
gate.

Spec: `ROUTEMIX-SPEC.md` + `served-metric-reliability.json`. Data source:
[[gridiron-participation-not-dead-after-2023]].
