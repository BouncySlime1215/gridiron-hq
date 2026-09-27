---
name: gridiron-committee-reallocation-real-2026-09-22
description: Committee reallocation is a SMALL real positive on the rows where it fires, on the production-faithful rig and decision_including_dnp; spec it only behind the graded availability multiplier.
metadata:
  type: project
---

Package #17, 2026-09-22. Record `/mnt/project-files/COMMITTEE-SPEC.md`, script
`/mnt/project-files/cs-test.mjs`. Fit 2022-2023, eval 2024-2025, n = 2,797
backfield player-weeks, paired bootstrap clustered on player, 2,000 resamples,
seed 20260922.

**The finding, narrow version:** on the 12.9% of backfield player-weeks where a
team-mate carries an injury designation, reallocating his share to the backs
still standing cuts carry MAE by **0.4445 [0.6356, 0.2602]** against a
level-matched control — and that flat control is *harmful* on those same rows
(+0.1537). Helps only where it fires; its untargeted twin of identical
magnitude hurts. That pattern is what separates a signal from a recalibration.

Raw population: **−0.0372 [−0.0647, −0.0099]** = 15.7% of the 0.2371-carry
headroom. Level-controlled: −0.0090 [−0.0403, +0.0224], not established.

**The model:** `pred_i = predA_i x (den0/den)`, `den = SUM_j s_j p_j` over the
backfield with this week's reports, `den0 = SUM_j s_j p_none`. **The `den0`
anchor is load-bearing** — without it the factor is a uniform 1/0.80 inflation
wearing a committee label, the same bias as
[[mae-punishes-a-mean-matching-bias-correction]].

**TRAP:** routing the forecast through `share x team volume` over the same 3
weeks is **algebraically the baseline**: `(ownSum/bfSum) x (bfSum/3) = ownSum/3`.
It returns ~0.0000 and reads as a clean null. A null whose two arms are the same
equation is not evidence.

**Wiring:** `nfl_injuries` already ingested (`nfl-advanced.js:335-410`);
`projections.js` has **no participation term for skill players at all**;
`role-scenario-engine.js:127` gates on `report_status !== 'Out'` as a boolean —
the crude version of this. Not proposed, not approved.


## DEFINITIVE — production-faithful rig, `decision_including_dnp`

With #19's graded availability multiplier applied to BOTH arms, so the committee
factor is tested on top of the prerequisite it needs:

    2023 all rows (n=4,443)  5.1579 -> 5.1556  -0.0022 [-0.0039, -0.0004] BETTER
      firing rows (n=141)    5.7851 -> 5.7150  -0.0700 [-0.1236, -0.0182] BETTER
    2024 all rows (n=4,471)  5.2660 -> 5.2642  -0.0018 [-0.0037,  0.0000] marginal
      firing rows (n=113)    5.9236 -> 5.8517  -0.0719 [-0.1409, -0.0023] BETTER

**Small, real, worth about a tenth of what my own baseline suggested.** Spec it
only behind [[gridiron-graded-availability-clears-2026-09-22]], which is larger,
better established, and its prerequisite. Script `cs-decision.mjs`.

**I gave this FOUR verdicts in one session and only the last was on the right
instrument:** real (-0.4445, my own baseline) -> not tested (blind rig) ->
refuted (+0.89, augmented rig + `point.model.mae`) -> small positive. The lesson
is not about committees. **Pick the metric and the data the product actually
uses before running anything**, or every verdict is a fact about the instrument.

**Mandatory for any team-mate lookup:** index the roster at **week + 1**, built
from the previous week's appearances. A player ruled Out has no usage row that
week, so a current-week index drops exactly the team-mate being tested for.

**STRAND CLOSED.** Rushing participation candidates: spread null (#15), total
null (#15), depth rank negative (#16), committee reallocation real but narrow
(#17). The remainder of the 89% is in-game injury, ejection and realised game
state — unreachable pre-game by construction. The question is answered, not
open.

Related: [[gridiron-injury-report-forecasts-snaps-2026-09-22]],
[[gridiron-depth-rank-rejected-2026-09-22]],
[[gridiron-game-script-does-not-forecast-snaps]],
[[gridiron-participation-not-target-rate-2026-09-22]].
