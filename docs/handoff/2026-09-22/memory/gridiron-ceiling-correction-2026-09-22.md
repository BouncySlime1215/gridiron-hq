---
name: gridiron-ceiling-correction-2026-09-22
description: CANONICAL ceiling figure as of 08:01Z 2026-09-22 — model at 82.7% of a 0.3854 ceiling, headroom +0.0668 R². Both 98.9% (05:02Z) AND 70.1% (07:48Z) are WITHDRAWN.
metadata:
  type: project
  modified: 2026-09-22T08:03:07.711Z
---

**RULING 08:01Z (first Auditor, accepting Model evidence audit's re-derivation):** the 0.4548 "ceiling" was the in-sample season mean's R² — it saw the week it scored. Corrected ceiling **0.3854** (ANOVA components σ²b 23.2744 / σ²w 37.1200 / n₀ 8.8445; LOO-inversion gives 0.4012 as a cross-check). Model 0.3186 = **82.7%**, headroom **+0.0668 R²** (~18x the +0.0037 that was stopping work). Within-player share ≈60%, not 54.5%. Tell: 8.8449 real scored weeks/player-season vs 5.11 implied by 0.4548. Auditor's own 70.1% check "passed because two errors cancelled." Correct figure was already in `docs/spec/projection-range.md` §7, which had exempted the ceiling doc from it. Told Nick 08:02Z.

**Withdrawn 07:50Z under [[gridiron-authority-0745-2026-09-22]]:** the 05:02Z "98.9% ceiling canonical" line in [[gridiron-state-record-2026-09-22]]. Do not quote it.

**Auditor 07:48:13Z (cse_01Q2FHgt4RMnqaJ2LRECwpSV), now also withdrawn:** ceiling doc compared model to a leave-one-week-out season average — a noisy estimate, not a ceiling. Took the variance-split **R² 0.4548** as ceiling; model **0.3186**; headroom **+0.1362 R²**, **~70.1%**. Implied 5.11 scored weeks per player-season, ~4,849 player-seasons in 24,801 rows.

**Still holds:** the four measured feature declines; "ship a range, not a single number". (54.5% week-to-week share superseded by ≈60% above.)

**Reversed / suspended:** dropping remaining player-descriptive features (Feature audit told 07:50Z); the opponent-defence argument leaning on 98.9% (re-deriving). Model evidence audit owns the doc, redirected 07:50Z: ceiling fix first, then §4 rewrite ([[gridiron-denominator-correction-2026-09-22]]).

**Nick:** told 98.9% at 05:02Z; correction due at 07:58Z check-in; 82.7% delivered 08:02Z.
