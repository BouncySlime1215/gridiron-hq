---
name: opportunity-graded-population
description: The nflverse source ceiling proves the rebuild's usage table is complete, so the promotion gate's graded n on live can only come back equal or smaller, never larger.
metadata:
  type: project
  modified: 2026-09-19T21:20:00.000Z
---

Live `player_week_usage` 2025 holds 8,857 rows; the rebuild the O1 numbers were
measured on holds 6,037 (2023: 5,801, 2024: 5,864). **The gap is fully explained
and it does not threaten the promotion vector.**

**Counted directly from the nflverse source files** (`stats_player_week_{season}
.csv`, REG only, downloaded 2026-09-19):

| season | QB/RB/WR/TE rows | distinct | K rows | all other positions |
|---|---|---|---|---|
| 2023 | 5,801 | 577 | 543 | 11,462 |
| 2024 | 5,864 | 589 | 543 | 11,723 |
| 2025 | 6,037 | 610 | 543 | 11,960 |

The rebuild holds 5,801 / 5,864 / 6,037 at 577 / 589 / 610 — **identical, i.e. at
the ceiling. Nothing is missing from it.** 2025's non-fantasy bulk is LB 2,939,
CB 1,987, DT 1,526, SAF 1,455, DE 1,408 and similar.

**Mechanism, verified in source:** `syncWeeklyUsage`
(`nflverse.js:255-265`) has **NO position filter** — it writes every REG row whose
`gsis_id` matches a row in `players`, so the filter lives in `players`, not the
writer. The rebuild's `players` is 8,294 and already fantasy-only (WR 3,250 +
RB 2,452 + TE 1,584 + QB 1,008), hence zero non-fantasy rows and zero orphans;
live's is 965 ESPN-sourced rows including 58 K and 32 DEF, and that surplus is its
extra usage rows. `history()` (`projections.js:292` and `:300`) filters
`p.position IN ('QB','RB','WR','TE')` on BOTH branches and `replaySeasonWeekly`
grades by iterating the projection map, so non-fantasy rows never reach the grader.

**Therefore the gate's graded `n` on live can only be equal or SMALLER than the
rebuild's, never larger** — the writer cannot exceed the source, and the rebuild
already has all of it. n tracks fantasy rows in weeks 5-18 nearly 1:1 (rebuild
2025: 4,623 rows → n = 4,468, 96.7%; the rest lack prior in-season history).
- at or just below **4,361 (2024) / 4,468 (2025)** → proceed.
- materially below → live's `players` lacks fantasy players who played those
  seasons; the walk-forward fit ran thinner than validated. Understand before the write.
- above → impossible against this source; a premise is wrong. Stop the write.

**Method lesson (cost two wrong messages tonight):** a difference between two
aggregates cannot explain itself. Go to the input. One CSV download settled what
two rounds of estimating did not.

Written up as section 3b of the findings doc and the "Read the graded n" note in
the promotion runbook (PR #15). See [[shrinkage-promotion-execution]],
[[gridiron-player-universe-real]].

## READING THE MORNING REPORT: verified vs inferred (22:10Z)
The dry run is a **morning event**: it runs only from Nick's terminal.

**The gate's code is byte-identical between the tree these numbers were measured
on (`9db53ff`) and shipped main (`791b131`)** — verified by diffing all six files
that determine its output: `promote-volume-shrinkage.mjs`, `weekly-backtest.js`,
`projections.js`, `shrinkage-fit.js`, `backtest-significance.js`,
`weekly-ensemble.js`. So the numbers describe the code that will run.

**VERIFIED:** the vector (re-derived on 791b131, identical to 16 figures); the
caller/guard split; live `shrinkage_fits` 0/0 and `shrinkage_k` 0; live QBR
2025:540, 2026:34, nothing 2021-24; the n *ceiling* (counted from the nflverse
source files, so live cannot grade MORE).

**INFERRED — do not treat as evidence:** that live's n will actually BE 4,361 /
4,468. That is the rebuild's number; live's `players` is 965 rows against the
rebuild's 8,294, so the population can be SMALLER. **The n check is the test of
that inference, not support for it.** A gate that passes on an n well below 4,361
is passing on a thinner population than anything measured, and looks identical to
a clean pass. Also inferred: that a 2021-24 QBR backfill flips condition 3 —
measured three ways on the rebuild, never on live.
