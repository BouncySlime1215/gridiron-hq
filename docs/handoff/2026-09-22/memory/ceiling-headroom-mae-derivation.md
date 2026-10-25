---
name: ceiling-headroom-mae-derivation
description: The weekly ceiling's MAE headroom is the bracket [+0.0895, +0.5940] with +0.4258 estimated inside it; +0.3141 is withdrawn.
metadata:
  type: project
  modified: 2026-09-22T11:27:26.157Z
---

`docs/evidence/2026-09-22/weekly-ceiling-the-model-is-already-there.md` §2.2,
settled 2026-09-22. Commits **e2718f53** then **405d203d** (tree **a494cb1e**), branch
`claude/project-thread-w0gpjt` — **held unpushed** while push authority is
revoked. Accepted on review 2026-09-22 11:31Z: **the bracket is what may be
cited; +0.4258 is an estimate.**

**Canonical:** ceiling **0.3854** (ANOVA, σ²b 23.2744 / σ²w 37.1200), model
share **82.7%**, headroom **+0.0668 R²** and **+0.3220 RMSE**. On MAE: **cite
the bracket [+0.0895, +0.5940]**, with **+0.4258 (CI [+0.3948, +0.4538], cluster
bootstrap by player) as an estimate inside it** — the two always in one sentence.

**WITHDRAWN: +0.3141.** It scaled the RMSE floor by the LOO oracle's MAD/RMSE
ratio — an unstated shape assumption worth 0.37 of the answer (a Gaussian shape
gives floor 4.8612, headroom **−0.055**, model already past it).

**The bracket, assumption-free**, same 24,801 rows: floor ∈ [4.2122 (own-season
mean, centre fitted on the row it scores → biased low), 4.7167 (leave-one-out
mean, unbiased centre but noisy → biased high)]. Headroom ∈ [+0.0895, +0.5940].
**The pessimistic end is positive**, so this claim cannot collapse to negative.

**The Gaussian branch is refuted by the data**: MAD/RMSE measured 0.74926
(model), 0.73411 (in-sample mean), 0.73731 (LOO mean) — Gaussian is 0.7979.
Weekly scoring is floored near zero with a long right tail, so within-player
error is leptokurtic and stays that way.

**Point estimate:** rescale each deviation to the floor variance
(`var(y − own mean) = σ²w(1 − 1/m)`, scale by `√(m/(m−1))`) → 4.4558; simulate
seasons with the measured shape and real week counts to size the residual
convolution inflation, iterate to a fixed point (×1.0265, ×1.0180, ×1.0172) →
floor **4.3804**.

**Two traps recorded so nobody re-derives them:**
- `y − LOO mean = (y − own mean) × m/(m−1)` **exactly**, so the bracket's two
  ends are one quantity through two lenses — a valid bracket, not corroboration.
- The MAE-optimal centre is the player's **median**, not his mean (in-sample
  3.9979 vs 4.2122), so +0.4258 is a **floor on the headroom, not a ceiling**.

**§3 — quote the absolute gain first; the share inherits the bracket:**
depth-chart rank +0.0031 (0.73% est., 0.52–3.46%), practice participation
+0.0007 (0.16%, 0.12–0.78%), route share +0.0008 (0.19%, 0.13–0.89%), red-zone
touches +0.0004 (0.09%, 0.07–0.45%). The four verdicts never moved — each failed
on its own interval, which no denominator touches.

**Scope the ceiling in the sentence:** it holds *for player-seasons with ≥3
scored weeks*. σ²w, σ²b and the ceiling are fitted on that restricted sample and
the restriction is selective on predictability. It drops only **2.06% of rows
but 11.1% of player-seasons** (350/3,154), and those thin-sample cases are where
weekly features would plausibly matter most. The ceiling does not speak for
them.

**Population, reconciled:** 25,323 saved predictions − 522 = 24,801 scored
rows. The 522 are 178 player-seasons with one scored week and 172 with two,
dropped by the three-week minimum (LOO is undefined at m=1, a single other week
at m=2). **The filter is not neutral:** model MAE is 3.2946 on the dropped rows
vs 4.8062 on the kept and 4.7750 on all — short seasons are low-usage or injured
players whose weeks are easy. Every figure is on the same 24,801 rows.

**Binding labels, never drop them:** +0.0895 IS v1 (`model − LOO oracle`), never
corroboration of it. The `√(m/(m−1))` step assumes MAD scales as SD — say so
wherever 4.4558 or 4.3804 appears. The CI travels with the bracket (0.059 vs
0.5045, **8.6× narrower**). §3's denominator is a **normaliser** — "closed X% of
the gap to a per-player constant", not "X% of what is achievable", because the
features are weekly and live inside σ²w. **Never compare 4.8062 with the R&D
rig's 4.757** — different harness and population.

Labelling: **60.3836** is sample total variance `SST/n`; **60.3945** is
`σ²b + σ²w`. Scripts: `ceiling_mae.py`, `ceiling_mae2.py`, `ceiling_mae3.py`.

Related: [[a-benchmark-is-not-a-ceiling]],
[[gridiron-noisy-estimate-is-not-a-ceiling]],
[[a-recovery-fraction-needs-both-denominators]].
