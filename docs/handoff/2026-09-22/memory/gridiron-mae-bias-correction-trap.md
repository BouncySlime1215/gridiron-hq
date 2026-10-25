---
name: gridiron-mae-bias-correction-trap
description: A multiplicative bias correction fitted to match means DEGRADES an MAE score when the target is spiky at zero (absences) — measured 2026-09-22 by Data & techniques R&D package #15.
metadata:
  type: project
  modified: 2026-09-22T07:59:54.926Z
---

**Finding (Data & techniques R&D, 2026-09-22 07:56Z, package #15):** multiplying every participation prediction by 1.1838 to remove a mean-level bias made MAE WORSE on both halves (5.0125 vs 4.9715 plays; 1.0212 vs 0.9959 carries). MAE rewards the conditional MEDIAN, and ~17% of player-weeks are absences (zero), so the distribution is spiky at zero and a mean-matching scale factor moves predictions away from the median.

**Why it matters:** the graded injury multiplier is applied to every player including the ~88% with no report row, scaling all predictions down by ~0.88. A downstream fit that "corrects" that level will look like signal. Package #15's first run reported game script as "+0.0414, significant" — it was this recalibration wearing a game-script label. Tell: six bucket multipliers clustered within 0.07 in no particular order.

**How to apply:** before any build "fixes the bias" of a participation or volume term, check which loss the gate uses. Under MAE/CRPS, do not mean-correct; report the level bias as a limit. If a spread/total/game-script bucket fit shows flat, non-monotone multipliers, it is correcting level, not measuring the feature.

**Also settled by #15:** pre-game spread does NOT forecast rushing participation (−0.0036 [−0.0097,+0.0019] on-field rush plays; carries +0.0003, both indistinguishable, n 11,355, eval 2024-25). Game script matters to what happens and does not help predict it. Remaining candidates for the rushing 89%: committee split (coaching property), in-game injury (unreachable), realised game state; `total_line` untested. See [[gridiron-247-threads-rule]].
