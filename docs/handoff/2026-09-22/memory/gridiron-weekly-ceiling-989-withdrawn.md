---
name: gridiron-weekly-ceiling-989-withdrawn
description: The "98.9% weekly ceiling / +0.0037 R² headroom" figure is WITHDRAWN (2026-09-22); corrected to model at 82.7% of a 0.3854 ceiling, headroom +0.0668 R².
metadata:
  type: project
  modified: 2026-09-22T08:01:07.340Z
---

**MEMORY.md's index still records "98.9% ceiling canonical" (05:02Z entry). Superseded.**
Withdrawn by the coordinator 07:50Z; figures fixed by the auditor ruling 07:59Z after
Model evidence audit's re-derivation.

**CARRY THESE:**
- player-level ceiling **R² 0.3854** (ANOVA components σ²b 23.2744, σ²w 37.1200,
  n₀ 8.8445, Var(y) 60.3944)
- model 0.3186 = **82.7%** of it; **headroom +0.0668 R²**
- within-player week-to-week share **61.5%**, not 54.5%
- two independent methods bracket the ceiling at **0.385–0.401**

**Do not re-quote:** 98.9% / +0.0037 (original), nor the auditor's intermediate
70.1% / +0.1362, which used the in-sample 0.4548 as if it were the true ceiling.

**Why 0.4548 was wrong.** `SSB/SST` is the R² of the *in-sample* season mean — it saw the
week it scores — so it is biased up by σ²w/n₀. The identity closes:
(23.2744 + 37.1200/8.8445)/60.3944 = 0.4549 vs the reported 0.4548. Mean scored weeks per
player-season is 8.8449 (24,801 rows / 2,804 seasons), read from the counts.

**Process failure worth remembering:** `docs/spec/projection-range.md` §7 (lines 203-212)
already carried this correction — raw 45.48% → ANOVA 38.54% — then line 218 exempted the
ceiling document from it "as an empirical benchmark". The project had the right number in
its own spec and carved out the one place it mattered. Strike that exemption.

**Still holds:** the four measured feature declines; the depth-chart-rank observation;
"ship a range, not a point"; and "aim at the week, not the player", which gets STRONGER
(61.5% pool, not 54.5%).

**How to apply:** (1) never quote the withdrawn figures; (2) any argument citing the old
headroom needs re-deriving — `opponent-defence-the-oracle-was-the-player.md` §5 does, and
it also measured a *week-specific* feature against a *player-level* budget; (3) the "drop
the player-descriptive remainder" recommendation is SUSPENDED.

**Two transferable rules:** a headline figure cited from another document as the basis of
an argument is a gate on that document, not a citation. And a consistency check that closes
because two substitutions compensate is worse than no check — it manufactures confidence.

Source: `docs/evidence/2026-09-22/weekly-ceiling-the-model-is-already-there.md` (6f4f6ba3);
re-derivation 9962f82f / 910ef1a9 / 82720d1c. Audit record
`/mnt/project-files/audit-unit-4-weekly-ceiling-2026-09-22.md` (its 0.4548 figures are
superseded by this file). See [[gridiron-auditor-thread-standing-2026-09-22]].
