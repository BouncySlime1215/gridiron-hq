---
name: gridiron-preda-level-confound
description: Packages #13-#17-first ran through a downward-only predA multiplier; the rule for which of their results survive is by CANDIDATE direction, and nulls are void in every case.
metadata:
  type: project
---

Ruled by the auditor 2026-09-22 11:35Z, superseding the coarser 11:30Z version.

**Affected (ran through predA, multiplier downward-only):** #13 sf-test,
#14 rf-test, #15 gs/gt-test, #16 dc-test, #17 first run cs-test.
**Unaffected:** #10, #11, #12, #17-final, #18-#22 (replaySeasonWeekly).
#17's -0.0700/-0.0719 are from `cs-decision.mjs:18` on `_decision_rows`, not predA.

**Two channels.** *Compression* — a sub-1 multiplier shrinks both arms and
compresses their difference; direction-free, so it makes **every null void**.
*Level* — if predA moves the arm off its own MAE optimum, a candidate moving the
level back is rewarded and one moving it further away is penalised, regardless of
information. Evidence: #15's first run showed +0.0414 [+0.0157,+0.0763] that was
the bucket fit correcting the baseline's level — a false positive from that
channel alone.

**THE RULE — do not classify by above/below 1. PRICE the channel.**
The auditor's first matrix assumed the un-multiplied baseline sat at its own MAE
optimum; measured, it does not. For each arm compute MAE at 1.000 and at its own
MAE-optimal flat multiplier m0 (prediction-weighted median of actual/pred, grid
beside it, m0 re-estimated inside every bootstrap resample). The change in that
headroom between arms IS the level contribution, and
**total = level + information**. Report all three, never a direction.
Level share measured per arm: 41.6% (cs-test), 30.8% (#13), 32.4% (#14).
**It is not portable — price each arm on its own rows.**

Fallback direction rule where pricing is impossible, always relative to m0 and
never to 1: moving level TOWARD m0 is rewarded (helpful inflated, harmful
survives); AWAY is penalised (harmful inflated, helpful conservative);
mean-preserving is second-order; **a null is VOID in every case.**

**Condition on every re-run:** removing the multiplier only removes the level
confound if the un-multiplied baseline is near its own optimum, which per
[[gridiron-mae-optima-are-medians]] is a median question, not an assumption.

**Standing note:** two kills in this project have now been traced to the
instrument rather than the evidence — Condition B's empty tables
([[gridiron-offline-rig-evidence-line]]) and this. **No unit may be killed on a
null, or on harm from a prediction-lowering term, without a statement of what
the instrument could have shown.**

**RESOLVED 2026-09-22 11:50Z — all four re-run and priced, no verdict flipped.**
#13 total 0.0926 = level 0.0285 (30.8%) + **information 0.0641**; #14 total 0.0704
= level 0.0228 (32.4%) + **information 0.0475**. #15 a real null (info +0.0013
[−0.0040,0.0068], straddles — say "no detectable effect", never "negative"); #16
harmful and the harm is INFORMATION not level (info −0.0204 [−0.0269,−0.0139],
level straddles zero). All voids lifted.
**Plan 01 criterion 1b restated to the information share: 21.02% → 14.6%; #14's
11.2% → 7.6%.** The level part is capturable by a flat multiplier with no new
data, so it is not the feature's.
**TRAP, and the auditor nearly fell in it:** base m0 = 0.870 / 0.879 looks like a
15% over-prediction. It is not established. Per
[[gridiron-mae-optima-are-medians]] a sub-1 MAE optimum can be pure right skew.
**Measure mean(actual)/mean(pred) beside m0 before proposing any flat rescale**,
and note a rescale that improves MAE while adding mean bias costs anything needing
unbiased levels.
**Standing rule:** a direction or mechanism claim cites the APPLYING LINE, never
a write-up table — direction was misread from tables on both #15 and #16.
