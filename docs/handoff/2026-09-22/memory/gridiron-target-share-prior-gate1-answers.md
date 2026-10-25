---
name: gridiron-target-share-prior-gate1-answers
description: "Model evidence audit's gate-1 answers (16:33Z) on the target-share prior unit, tree bf48214f: legacy-vs-fitted de-biased gain, DNP-inclusive non-significance, QB-0 structural, no-power-check admission, incumbent reachability, NULL espn_id rig note"
metadata:
  type: project
  modified: 2026-09-22T16:36:08.174Z
---
Answers to the Auditor's gate-1 questions on the target-share prior unit
(tree **bf48214f**, guarded run in progress, draft PR refresh to follow,
held for Auditor ruling). See [[a-low-projection-is-an-accidental-availability-hedge]]
for the level/information framing this extends.

- **(iv) legacy vs fitted, de-biased.** Legacy `0.06` prior mean signed error
  **−0.9764**; fitted (per-position measured mean) **−0.3165**, both on weeks
  played. De-biased gain: **+0.1273 [+0.0965, +0.1573]** conditional (weeks
  played), **+0.0482 [+0.0249, +0.0713]** DNP-inclusive. Both significant —
  the prior carries real information once the level is stripped out.
- **(iii) DNP-inclusive headline is NOT significant.** Raw (non-de-biased)
  DNP-inclusive change: **−0.0136 [−0.0499, +0.0225]**, spans zero — versus
  the pre-registered primary metric's **+0.1044 [+0.0661, +0.1460]**
  (weeks-played only). **Finding:** a systematically low projection is an
  accidental availability hedge; the missing-availability term is masking as
  a level effect on the DNP-inclusive metric, not a real model difference.
  Routed to Planner as a plan-no-build item — availability needs its own
  term, not a rider on this prior fix.
- **(ii) QB arm is 0, and it is structural, not a bug.** `projections.js:578`
  has no QB target-share term at all; the fitted-vs-legacy comparison cannot
  move the QB arm because there is nothing there to move.
- **(v) No power check was declared in advance.** Recorded as a miss against
  the pre-registration, not retrofitted. Post-hoc SE: **0.0243** (conditional
  arm), **0.0220** (DNP-inclusive arm).
- **(vi) Incumbent is reachable.** `shrinkSafe(…, 0.06, n, K.share=6)` with
  `sharePrior: 'legacy'` is a live, reachable code path — the comparison is
  against a real incumbent, not a strawman.
- **Rig note:** this rig's `players.espn_id` is NULL for all 1,483 rows
  ([[scratch-rig-espn-id-null-disables-qbr]] applies) — consistent with (ii):
  the QB arm has no target-share term to disable in the first place, so the
  NULL id doesn't change this particular verdict, but any QB figure from this
  rig elsewhere is still invalid per that rule.
- **CI:** #68 (this unit's draft PR) shows CI red — same main regression as
  every other open PR (`routes/trades.js`, see [[gridiron-main-red-archetype-guard-collision]]),
  not this unit's fault. Commented on #68 saying so.

Relayed to Auditor 16:35Z for ruling.
