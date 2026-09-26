---
name: gridiron-n-is-not-raw-opportunities-2026-09-22
description: projections.js documents the efficiency k in "raw opportunities" but n is recency-weighted at ~0.31 of raw, with a 27x spread across players — and that ratio is the factor-of-three in the fitter's k.
metadata:
  type: project
---

Package #21, 2026-09-22 (Auditor rotation item a). Record
`/mnt/project-files/NRATIO-SPEC.md`, script `nratio.mjs`. Measurement only,
nothing edited.

**The K block at `projections.js:50-66` says `yards_per`/`catch_rate`/
`td_rate`/`int_rate` live in RAW OPPORTUNITIES. They do not.** `n` is
accumulated at `:495` through `rowWeight` (`:176-181`) under
`RECENCY = {seasonDecay: 0.35, weekHalfLife: null}` (`:162`).

Measured, through 2024, production-faithful rig:

    weighted/raw ratio   mean   median   p10     p90
      targets            0.307  0.242    0.028   0.748
      carries            0.319  0.256    0.032   0.740
      attempts           0.299  0.269    0.028   0.683

**The spread is the finding, not the mean. p10 to p90 is 27x.** It tracks
career length: 1 season of history -> median ratio 1.000; 3 seasons -> 0.126.
**The same constant is ~8x stronger against a third-year player than a rookie.**
So one k in raw-opportunity units cannot mean the same evidence for any two
players. `K.yards_per = 34` is effectively 110.8 raw targets at the mean ratio
and 1,207 at p10.

**THIS IS THE FACTOR-OF-THREE IN THE FITTER'S k.** `shrinkage-fit.js:323`
builds `effW` and never passes it (`:355-373`), so the fitter estimates k
against RAW weights while production applies it against WEIGHTED n. Scaling the
fitter's output by 0.307: ypt WR 168.33 -> 51.7, ypt TE 128.98 -> 39.6, ypa QB
333.86 -> 102.5, against the 34 in the file. A 5x discrepancy becomes ~1.2-1.5x
for the receiving metrics. #18 recorded this as an unexplained gap; it is now
quantified.

**Does NOT change #18's conclusion** — `K.yards_per = 34` still should not be
raised; that was measured on the repo's own weekly MAE.
[[gridiron-yards-per-34-stands-2026-09-22]]

**Depth is bounded, not a confound.** On a fixed population the ratio by window
length is 1.000 / 0.639 / 0.445 / 0.348 / 0.307, marginal effect halving each
time, converging near 0.27-0.28. Production's ratio is ~0.27-0.31 whatever its
DB depth.

**NOT about the volume metrics** — they accumulate under `WEEKLY_ROLE_RECENCY`
(seasonDecay 0.05, weekHalfLife 5) and their k is documented in
recency-weighted games, so those units already agree.

Highest-value follow-up is the **documentation** fix at `projections.js:50-66`,
since that block is what every future session reasons from.

Related: [[gridiron-offline-measuring-rig-2026-09-22]].
