---
name: gridiron-phase-a-feature-verdicts
description: Five deep-predictive features tested 2026-09-22 and all declined with evidence — routes run, red-zone inside the 10, practice participation, depth-chart change, OL-vs-DL; team pace dropped unrun.
metadata:
  type: project
  modified: 2026-09-22T04:39:01.532Z
---

Phase A lift proofs (five features), run 2026-09-22 by the model-evidence-audit thread against
origin/main 654ff93. **Do not re-run these five; read the evidence first.**
All under `docs/evidence/2026-09-22/`.

| feature | verdict | why |
|---|---|---|
| routes run | declined | real signal, statistically indistinguishable from snap share (`nfl_snaps.offense_pct`) |
| red-zone touches inside 10 (and 20) | declined, RECLASSIFIED 04:24Z to item 14 (luck) | absorbed by targets + snap share — [[red-zone-reclassified-to-luck]] |
| practice participation | declined | carries availability info, NOT production info; already modelled correctly |
| OL-vs-DL matchup | declined | the line matchup itself carries nothing (own protection +0.0004 CI [-0.0009,+0.0016]). Opponent-side terms DID detect pooled (pass EPA allowed +0.0110 CI [+0.0073,+0.0147], 4 seeds, correct sign, shuffled control passes) but are NOT claimed: pass-rush is absorbed by general opponent EPA, and BOTH fail split-half (pass EPA +0.0061 in 2018-21, -0.0018 in 2022-25). REOPENED 2026-09-22 -- 'already built' is false for fantasy. See [[gridiron-phase-a-baseline-caveat]]. |
| team pace / play volume | dropped unrun | third volume proxy against a saturated channel |
| depth-chart change | declined | rank separates hugely in raw data (rank1 10.91 PPR, rank2 5.73, rank3 4.23) yet adds nothing — already inside targets + offense_pct. Pooled +0.0031 PPR CI [-0.0022,+0.0086]; change-events-only subgroup also null. Rank changes just 5.50% of weeks. |

Harness: purged walk-forward by season-week, 2018-2025, 25,523 out-of-sample
player-weeks, target PPR from `scoring.js` weights, paired bootstrap resampled
BY PLAYER, fixed feature divisors so no test statistic leaks through scaling.
Power demonstrated each run (a deliberate same-week-targets leak reads +1.1615
PPR; prior targets +0.0184). Ridge regression only — no numpy/pandas/sklearn in
the cloud container, so tree interactions are NOT ruled out (coordinator
decided 2026-09-22 to skip a pure-Python GBM).

**Superseded by the real explanation: [[gridiron-weekly-ceiling-2026-09-22]].**
The model sits at 98.9% of a hindsight oracle, so all four were competing for
+0.0037 R2 total. Read that memory first; it says which feature class to test
next (week-specific only).

**The narrower earlier finding, still true: the volume channel is saturated.**
`targets` + `offense_pct` already carry opportunity volume. Weekly PPR R2 sat at
0.3218 and nothing moved it past 0.3226, which is why "team pace and play
volume" was dropped from the queue unrun.

**Open question above this thread:** the weekly ceiling may be noise-limited
rather than feature-limited, in which case the deliverable is a stated
confidence interval on every projection rather than a bigger feature set.

Two traps found here, worth not repeating: MAE is degenerate on a zero-inflated
count target (touchdowns average 0.2651/player-week, 22.1% non-zero) so use
squared error there; and a positive control must be something the baseline does
NOT already contain — prior TDs is near-collinear with prior PPR and correctly
shows nothing. See [[gridiron-five-questions-rule]],
[[gridiron-free-data-first-rule]].

Baseline caveat and the recommended next job: [[gridiron-phase-a-baseline-caveat]].

Sibling bug on the same PBP: [[td-regression-tier-pricing-bug]].
