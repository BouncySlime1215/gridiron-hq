---
name: gridiron-model-audit-2026-09-20
description: The opportunity number Gridiron HQ shows is significantly WORSE than the player's own season-to-date average as shipped, and beats it with the unpromoted shrinkage fit — measured 2026-09-20 on 4,828 paired player-weeks.
metadata:
  type: project
  modified: 2026-09-20T01:35:23.755Z
---

Audit of `origin/main` at **791b131** answering Nick's "is this tested or are we
guessing". Page: https://claude.ai/artifact/WVQqxZwa1FsvXyzir2fsLr ·
**draft PR #68** (`claude/project-thread-w0gpjt`), docs + one script, no server
file. Local on that head: **2,950 tests, 2,909 pass, 0 fail, 41 skipped**; lint
and typecheck clean. Evidence:
`docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md` — **on the branch, not on
main**, so reading `main` will not find it.

## The result the repo did not have

`params.targets` / `params.carries` — the "6 tgt · 12 car" on `News.tsx:149-153`
— graded directly against **the player's own season-to-date average**.
2024+2025, weeks 5-17, **4,828 paired player-weeks**, paired bootstrap clustered
by player. MAE; interval on `baseline − model`, so positive means the model wins.

| | baseline | shipped k=6/10 | fitted k |
|---|---|---|---|
| 2024 tgt | 1.773 | **2.006** [-0.298,-0.174] | 1.749 [+0.008,+0.039] |
| 2024 car | 1.626 | **2.003** [-0.465,-0.295] | 1.600 [+0.003,+0.052] |
| 2025 tgt | 1.768 | **1.901** [-0.198,-0.074] | 1.735 [+0.017,+0.050] |
| 2025 car | 1.602 | **1.943** [-0.421,-0.268] | 1.575 [+0.011,+0.044] |

**All eight intervals exclude zero. The sign flips on the promotion.** So the
volume shrinkage promotion is not merely "better MAE on points" — it is the
difference between an opportunity figure that loses to an average a manager
could do in his head and one that beats it. Say it that way to Nick.

**Third arm added 2026-09-20, same 4,828 rows — the repo's own strongest
baseline, an EWMA of the player's recent games at alpha 0.4
(`opportunity-model.js:350`).** MAE: 2024 tgt 1.804, 2024 car 1.606, 2025 tgt
1.770, 2025 car 1.588. Shipped loses to it in all four cells (every interval
clear of zero). Fitted k BEATS it on targets both seasons ([+0.034,+0.076],
[+0.016,+0.056]) and ties on carries. So the promotion is the difference between
machinery that is worse than the simplest predictor in the repo and machinery
that is modestly better than it. The EWMA is not itself better than a season
average — three cells straddle zero, one is worse. **It is the shipped model that
is the outlier.**

**The trap that had kept this hidden:** filtering the graded population on
`structural_ppg` drops ~14% of rows once the fit is active, so the two arms
measure different players and the comparison means nothing. The gate must read
**raw usage only**. `scripts/grade-opportunity-vs-baseline.mjs` (on #68) does
that and scores the intersection of both arms.

My fit reproduces the Opportunity thread's to three decimals — target_share
0.175, carry_share RB 0.081, team_pass_att 1.277, qb_attempts 0.264 — from an
independent rebuild. Two sessions, same numbers.

The other findings and their owners: [[gridiron-model-audit-open-findings]].
The live routing defect: [[gridiron-coordinator-wrong-base]]. The data that
never arrives: [[gridiron-transaction-collector-never-runs]].
