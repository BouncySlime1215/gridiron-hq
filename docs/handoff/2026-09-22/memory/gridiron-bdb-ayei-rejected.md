---
name: gridiron-bdb-ayei-rejected
description: BDB 2026 Air Yards Efficiency Index is rejected — it is built from the ball's actual landing spot and then validated against completion, which is circular; weights are asserted, not fitted.
metadata:
  type: reference
---

Read 2026-09-22 from the pulled notebook source (Kaggle notebooks are open
unauthenticated, see [[gridiron-kaggle-open-access-2026-09-22]]). Local copy:
scratchpad `bdb-notebooks/src/nfl-big-data-bowl-2026-air-yards-efficiency-index.txt`
(scratchpad, not durable).

**What it is.** AYEI scores a player's movement while the ball is in the air:
`0.50 * path_efficiency + 0.30 * closing_efficiency + 0.20 * acceleration_timing`.

**Why it is rejected, in order of severity.**

1. **Circular validation.** `path_efficiency` is the straight-line distance
   from the player's position at throw to `ball_land_x / ball_land_y` divided
   by the path he actually ran. `ball_land` is where the ball came down —
   knowable only because the throw happened and landed there. A receiver who
   catches it is, by construction, at that point on the last frame; one who
   does not, is not. The notebook's only validation is then a correlation and
   t-test of AYEI against `is_complete` on those same plays (Part 9,
   `analyze_outcome_correlation`). The metric partly encodes the outcome it is
   scored against. That is not evidence.
2. **Asserted weights.** 0.50 / 0.30 / 0.20 are never fitted, tuned or
   ablated. No out-of-sample split anywhere in the notebook; no week or season
   holdout; no player-level repeatability.
3. **No repeatability test.** Nothing checks whether a player's AYEI in one
   week predicts his AYEI in the next. By our own law — usage repeats,
   efficiency does not — an unvalidated per-play efficiency composite is the
   least likely thing to carry week to week.
4. **Data we do not have.** It needs player tracking at 10 fps. Our only free
   route to that is accepting the BDB 2025/2026 Kaggle competition rules,
   which is still on Nick.

**Salvageable idea, for the record:** path efficiency measured to the
receiver's *intended* spot rather than the ball's landing spot would not be
circular. We cannot compute it without tracking data, so it stays parked.

**The transferable lesson, which does apply to us:** a metric computed from an
outcome's own coordinates cannot be validated against that outcome. Check what
a candidate feature is derived from before believing its correlation. Same
family as [[a-band-ratio-is-not-an-effect-size]] and
[[verify-the-consumer-not-the-producer]].
