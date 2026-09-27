---
name: gridiron-k-yards-per-too-small
description: SUPERSEDED AND WRONG — this said K.yards_per=34 is too small; measured on the repo's own weekly MAE the opposite is true. See gridiron-yards-per-34-stands-2026-09-22.
metadata:
  type: project
---

**This memory's conclusion was overturned on 2026-09-22 and must not be acted
on.** It recorded that `K.yards_per = 34` (`projections.js:97`) is too small and
that a larger value (~100 ypt / ~150 ypc) should be adopted, from packages #8
and #11.

**That is wrong.** Both packages measured **yards MAE at the player's actual
opportunities**, a proxy. On **the repository's own weekly MAE**, run through
its own replay harness and its own projection code, every larger k is *worse*,
monotonically, in both 2023 and 2024, with intervals excluding zero. Spearman
degrades too. `projections.js:88-92` was right all along.

Both packages now carry withdrawal banners
(`/mnt/project-files/EFFICIENCY-K-SPEC.md`, `KWALK-SPEC.md`).

**The transferable lesson, which is why this file is kept rather than deleted:**
a proxy metric that is *honest about not being the real metric* is still not
evidence about the real metric **when the two disagree in sign**. Here they did.
Gate a constant on the metric the product ships, using
[[gridiron-offline-measuring-rig-2026-09-22]].

Current truth: [[gridiron-yards-per-34-stands-2026-09-22]].
