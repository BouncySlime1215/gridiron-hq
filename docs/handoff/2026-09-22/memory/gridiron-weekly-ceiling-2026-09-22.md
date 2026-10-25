---
name: gridiron-weekly-ceiling-2026-09-22
description: WITHDRAWN 2026-09-22 — the "98.9% of a hindsight oracle" ceiling figure was wrong; adjudicated, the model is at 82.7% of a 0.3854 ceiling with +0.0668 R2 of headroom.
metadata:
  type: project
---

> **THE 98.9% FIGURE IS WITHDRAWN. Do not quote it, and correct it wherever it
> is cited.** It was canonical project-wide for several hours on 2026-09-22 and
> travelled into at least three documents. Evidence, v2:
> `docs/evidence/2026-09-22/weekly-ceiling-the-model-is-already-there.md`.

**The defect.** The "hindsight oracle" was a leave-one-week-out average of a
player's own season. **That is a noisy ESTIMATE of a player's level, not his
level**, so the comparison was two noisy predictors of the same quantity
agreeing with each other — which measures their shared noise, not the absence of
headroom. The tell was inside the document: a stated variance ceiling of 0.4548
beside an "oracle" scoring 0.3223.

**Same rows, re-derived** (24,801 out-of-sample player-weeks, 2,804
player-seasons, mean 8.84 scored weeks, total variance 60.3836). Every v1 figure
reproduced exactly first, which is how the rows were confirmed identical.

| predictor | R2 | MAE | RMSE | |
|---|---|---|---|---|
| model, causal | 0.3186 | 4.8062 | 6.4146 | what ships |
| leave-one-out season mean | 0.3223 | 4.7167 | 6.3973 | **not a ceiling** |
| shrunk LOO mean (k = 1.59) | 0.3317 | 4.7763 | 6.3523 | a lower bound |
| in-sample season mean | 0.4548 | 4.2122 | 5.7379 | **overfit — it saw the week** |

**`SSB/SST` and "the R2 of the in-sample group mean" are the same arithmetic**,
so the 0.4548 published as the variance ceiling was the score of a predictor
that cheated. Unbiased ceiling, two independent ways:

- ANOVA components (sigma2_b 23.2744, sigma2_w 37.1200, n0 8.8445) → **0.3854**,
  model at **82.7%**, headroom **+0.0668 R2**.
- Inverting the LOO oracle's own R2 against observed week counts → **0.4012**,
  model at **79.4%**, headroom **+0.0826 R2**.

**CITE: ceiling 0.3854, model at 82.7%, headroom +0.0668 R2.** Adjudicated
2026-09-22; the audit accepted this over a competing derivation that kept the
raw 0.4548 (model 70.1%), and recorded that its own check had passed only
because two errors cancelled. RMSE floor sqrt(sigma2_w) = 6.0926 vs model
6.4146.

**What settled it, and it is the reusable part.** The raw share is not merely
"biased in principle" — its exact value is PREDICTED by the components:
`E[SSB/SST] = (G-1)(sigma2_w + n0*sigma2_b)/(N*var_total)` = 2803 x (37.1200 +
8.8445 x 23.2744) / (24801 x 60.3836) = **0.454766** against the **0.4548**
measured. The raw share is fully accounted for as the unbiased ceiling plus the
known inflation term, to four decimals, so there is nothing left in it for the
ceiling to be. **Run this closure whenever a raw share and a component estimate
disagree; it decides which is which in one line.**

**Within-player share is 0.5988-0.6146, NOT 54.5%** — about 60% of weekly
scoring is a player varying against himself. That half got STRONGER under
correction.

**What stands:** the four feature declines, each on its own confidence interval
([[gridiron-phase-a-feature-verdicts]]); "ship a range, not a bare number"
([[gridiron-projection-range-spec]]), strengthened. Depth-chart rank still adds
nothing despite rank1 10.91 / rank2 5.73 / rank3 4.23, because it is already
inside `targets` and `offense_pct`.

**What is SUSPENDED: "do not build another player-descriptive feature."** That
rested on headroom too small by ~18x. Four features failed; the class is not
empty. Week-specific features are still a distinct, well-motivated class (no
season-long average can carry what makes THIS week different) — that logic never
depended on the withdrawn number.

**The general trap, and it has now bitten twice:**
[[gridiron-noisy-estimate-is-not-a-ceiling]].
