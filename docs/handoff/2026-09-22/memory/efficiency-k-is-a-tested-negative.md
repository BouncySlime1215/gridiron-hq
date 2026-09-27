---
name: efficiency-k-is-a-tested-negative
description: In gridiron-hq the efficiency k was already fitted and REJECTED on evidence (2025 got worse, 4.773 vs 4.749) — do not propose fitting it; the open efficiency work is outside signals, which needs Nick's word.
metadata:
  type: project
---

Raised by the model evidence audit 2026-09-20, verified at 791b131 by reading
the cited lines. Corrects an over-broad line of mine that called the whole
efficiency side "untried".

**Do not propose fitting the efficiency k.** `shrinkage-fit.js:469-473`, verbatim
in the source: it was excluded on evidence, not taste — substituting it made 2025
worse (**4.773 vs 4.749**), because "player" is not a stable group for efficiency
within a season and the method-of-moments between-player variance is inflated for
those metrics. That is why `VOLUME_METRICS` (:474-477) filters to the six volume
pairs and `volumeKFits` (:481) fits only those.

**The efficiency priors are measured, not invented.** `projections.js:416-426`
computes pooled rates, with the literals (7.5 ypt, 4.3 ypc, 0.63 catch rate,
0.05 rec TD rate…) as `|| fallback`. Precise reading, since this project cares
about silent fallbacks: that idiom fires on a null rate **and on a measured rate
of exactly zero**, because 0 is falsy. Inert in practice for QB/RB/WR/TE over a
pooled window, but it is not the same claim as "literals only on zero
denominators".

**What IS still open:** outside signals as new features — aDOT, air yards, CPOE,
RACR, PACR, already columns on `player_week_usage`. That is a new model and needs
Nick's word before anyone builds it.

**Do not cite the volume study against it.** `docs/OPPORTUNITY-FINDINGS-2026-09-19.md`
section 3 tested VOLUME features (air-yards share, WOPR, vacated share, snap
trajectory, expected points, spread, implied total, opponent funnel) and found
them a tested negative for next-week VOLUME. It says nothing about efficiency
features predicting efficiency. Two different questions.

See [[shrinkage-promotion-blast-radius]], [[opportunity-stage-findings]].
