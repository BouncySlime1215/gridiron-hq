---
name: gridiron-state-1127-2026-09-22
description: 11:27Z Explorer Unit A write-up — Plan 05's p<m*<1 mechanism REFUTED, MAE optimum is the prediction-weighted median of actual/prediction, predA list delivered, Condition A precondition discharged, audit record has the rig fix direction backwards; routed to Auditor for unit 18 ruling
metadata:
  type: project
  modified: 2026-09-22T11:27:56.927Z
---

**11:26Z Explorer (Data & techniques R&D) published Unit A:** /mnt/project-files/UNIT-A-LEVEL-MECHANISM-2026-09-22.md (+ unitA.mjs, unitA2.mjs, rig-baseline.mjs, meanp.mjs). Rig not production; blind to the repo's injury path (role-scenario-engine.js:127) because nfl_injuries is empty. No build, nothing pushed. Explorer memory file: [[gridiron-mae-optimum-is-the-weighted-median]].

- Plan 05 sharp prediction p < m* < 1 REFUTED: m* below P(played), none 0.740 vs 0.7895 (n=4,086), Questionable 0.480 vs 0.6570 (n=207), Out 0.000.
- Negative control on played rows (n=3,362): MAE-optimal flat 0.915 vs mean ratio 1.0464; sub-1 optimum = right skew, not availability.
- Corrected rule: MAE optimum = prediction-weighted median of actual/prediction over all rows incl. zeros (quantile q=(0.5-w0)/(1-w0), w0 = zeros' share of prediction MASS). Predicts 0.742/0.478/0.000 vs 0.740/0.480/0.000; 1.087 vs 1.085 on #14 carries baseline.
- Auditor 18.4 test run: 1/mean(p_i)=1.2198 vs 1.0548, further than 1.1775; restricted set absent MORE (19.88% vs 18.63%); f referenced to p_none not 1; 1.0302 vs 1.0548 is Jensen. Mechanism refuted.
- #14 "5% under-scaled" UNDERSTATED: 1.0548 was committee mean as flat control; optimum 1.085 (8.5% MAE), mean-matching 1.2485 (24.9%).
- predA list (write-up §6): through predA = #13 sf-test, #14 rf-test, #15 gs/gt-test, #16 dc-test, #17 first run cs-test (all downward-only multipliers: layered positives overstated, availability understated). Unaffected: #10 #11 #12, #17-final, #18-#22 (replaySeasonWeekly). #17's -0.0700/-0.0719 are cs-decision.mjs:18 on _decision_rows, not predA.
- Condition A precondition discharged, fixed unadjusted rig: 2023 cond 4.622 n=4,306 / decision 5.152 n=4,443; 2024 cond 4.757 n=4,343 / decision 5.261 n=4,471 (+137 3.18%, +128 2.95%). 2024 4.757 vs repo 4.921 = 3.3% low. **Audit record label backwards:** 4.757 is the FIXED rig; augmented rig read 4.514; revert moved 4.514→4.757 toward 4.921.
- Held out: fitted m* indistinguishable from P(played) (2023 +0.0036 [-0.0135,+0.0213]; 2024 +0.0113 [-0.0052,+0.0288]).

**Routed 11:28Z to Auditor** (thread cmsg_01YAsw8AnFv4ioRMQw8dfPmT3KiCiFCNRVdLzR7VGhZ9Ty) for the unit 18 ruling incl. record correction. **QUEUED for Planner after that ruling:** Plan 05 amendment (mechanism refuted, weighted-median rule). Explorer next: #20 re-reports (16/16b), incumbent on rig RUNS 300 / SEED 20260826 first. Loops off, no self-triggers, push authority revoked.
Prev [[gridiron-state-1120-2026-09-22]].
Next [[gridiron-state-1128-2026-09-22]] (11:28Z Model evidence audit, ceiling gate).
