---
name: gridiron-state-1120-2026-09-22
description: 11:20Z Auditor rulings after reset — unit 12 (#17 stays spec-only, Auditor withdrew its own n-ordering objection) and weekly ceiling (variance result confirmed, +0.3141 MAE headroom contested, within-player MAE bracket gate)
metadata:
  type: project
  modified: 2026-09-22T11:22:24.983Z
---

**Auditor (thread cmsg_01YAsw8AnFv4ioRMQw8dfPmT3KiCiFCNRVdLzR7VGhZ9Ty) 11:20Z, two rulings. Heartbeat still off pending Nick's usage answer.**

**Unit 12 (Explorer's answers):** three of four conditions cleared; nothing promoted. #17 selection question closed in Explorer's favour (week+1 team-mate index fix predates the -0.0700/-0.0719 result, not post-hoc). #17 STAYS SPEC-ONLY: population effect ~0.04% on a rule firing on 3% of rows. Auditor withdrew its own n-ordering objection: 6,084/6,011 were augmented-rig counts; production-faithful conditional counts 4,306/4,343, decision metric larger by 137/128 as expected. Plan 01 gate number unchanged: graded-beats-boolean -0.0180 / -0.0164. Routed to Explorer (Data & techniques R&D) 11:22Z.

**Weekly ceiling (Model evidence audit):** R-squared/RMSE work sound, LOO oracle fixes in-sample bias, all figures reproduce. CONTESTED: MAE headroom +0.3141 is assumed (oracle MAE scaled by RMSE ratio; needs shape invariance; the two predictors disagree 1.6% on that ratio; Gaussian shape gives -0.055, i.e. already past floor; swing 0.37). Every section 3 share is a share of that number: DO NOT QUOTE until gate clears. GATE: measure floor MAE directly as within-player deviation on the 25,323 predictions, bracketed in-sample vs leave-one-out. Routed to Model evidence audit thread (cmsg_01YAsw8AnFv4ioRMQw8dfPmT7SXDS8LvnSNmvMsRPdPPrw) 11:22Z, non-pushing; asked for the bracket in one message.

Supersedes the 0.3141 line in [[gridiron-state-0909-2026-09-22]]. Previous state [[gridiron-state-1115-2026-09-22]].

**Auditor full record:** /mnt/project-files/audit-unit-12-disposition-and-ceiling-mae-floor-2026-09-22.md. Binding: decision metric adds +137/+128 rows (3.18%/2.95% of base), state that count beside any decision-metric figure; quoting graded-flat (-0.1386/-0.1528) for the graded vector PROHIBITED (87-89% of it is flat-to-boolean); 3-5x rig-vs-production gap STILL OPEN, k lead 1.2-2.2x cannot alone explain it. Ceiling: +0.3220 RMSE headroom and 61.5% within-player share SAFE TO CITE; MAE bracket = mean|y - player-season mean| (low) to LOO 4.7167 (high); Gaussian sensitivity floor 4.8612.

**11:20Z Evidence Auditor: PR #107 (tree 3dd4334) VERIFIED, all clean** (RED f4500b7 8/8 fail, GREEN c476c1a 11/11 pass, nine-vs-eight correction in all four places, five questions present). Routed to Scheduler 11:23Z. Waits only on Nick's authority.

**11:20Z Planner delivered:** PLAN-07-n-units-doc-and-effw-2026-09-22.md (projections.js :54-64 doc false, both units weighted, games vs opportunities under rr :453 vs r :471; effW gate = five k + both MAE deltas; harm removed 98.0%/63.4% never "~90%"; fourth RED test pins a volume k); Plan 05 amended (§3a adjustment-direction rule, #19 multiplier purely downward so under-scaled baseline UNDERSTATES availability; §3b predA list required deliverable; Unit B plan-no-build); Plan 06 amended (§3b incumbent re-run first, RUNS 300 SEED 20260826 2023-24 on rig, ~0.775 = draw setting, ~0.761 = rig; §3c reproducing recorded 2025 grades incumbent and spends no holdout). Routed 11:23Z: Plan 07 + 06 §3b/c → Fantasy plan; Plan 05 + 06 §3c premise → Explorer (predA list next unit). Planner idle, no trigger. QUEUED until Nick's usage answer: Auditor confirmation of Plan 05/06 amendments.
