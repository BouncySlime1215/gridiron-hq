---
name: gridiron-state-0837-2026-09-22
description: 08:37Z 2026-09-22 — Explorer package #19 graded availability multiplier clears its gate (at Auditor); rig now sees absences (add-absences.mjs mandatory); #17 REFUTED; #87 closed; Chat sync b04c1ad accepted; Evidence Auditor unit 3 closed.
metadata:
  type: project
  modified: 2026-09-22T08:37:45.238Z
---
- **#19 (GRADED-AVAILABILITY-SPEC.md):** graded availability multiplier beats boolean Out (role-scenario-engine.js:127) on repo weekly MAE via rig: 2023 −0.0635 [−0.0813,−0.0470] n=6,084; 2024 −0.0860 [−0.1088,−0.0662] n=6,011; fit 2022, held out; Questionable ×0.8624 is the whole effect. Normalisation control mandatory (unreported row = 1.0; raw (none)=0.6745 overstated 4x). Untested: overlap with production's downstream fitted P(active). At Auditor final gate; candidate vector for Plan 01.
- **Rig fix:** add-absences.mjs (11,250 rows from free weekly_rosters: on roster that REG week, ACT/INA, no usage row) MUST run after load-rig.mjs. Volume-k win now reproduces at −0.3630 [−0.4246,−0.3004] / −0.4090 [−0.4716,−0.3462] (was −0.074/−0.149) → Auditor condition A (magnitudes) up for re-ruling. #18 k conclusion unchanged.
- **#17 committee split REFUTED** on fixed rig (2023 +0.0479 [0.0264,0.0714]; firing +0.8958; 2024 +0.0398; firing +0.8449). Planner told not to spec. Negatives: #15, #16, #17. Withdrawn: #8, #11.
- Explorer next: opponent-adjusted efficiency.
- Feature audit #87 closed at 081f309 evidence (docs/tdd/feed-zero-averages.tdd.md); next trend-exploits.js. Memory it wrote: network-egress-nflverse-releases (github.com release downloads reachable, api.github.com blocked).
- Chat sync b04c1ad pushed (3,052/3,011/0/41, tree 836d0813); Opportunity sample 3/3 clean; next league-chat-sync.js:105.
- Evidence Auditor unit 3 closed (8ddf620 + edc154b accept; record audit-unit-3-8ddf620-close-2026-09-22.md); on write-only-evidence sweep.
- **Auditor unit 10** (snap-share forecastability): sound, direction accepted; REDIRECT: oracle likely in-sample → re-derive split-half; rename 'best per-player constant'; state alpha 0.4 is repo constant; naives differ (1.4898 vs Explorer 1.5674) so percentages not comparable. Plan 02 rule: lags 1-4 partial first; persists → EWMA alpha 0.4; lag-1 only → stay lag-1. **Evidence Auditor write-only sweep:** 7 instances total; new: freeze-baseline.mjs baselines JSON, joint-score-report.mjs JSON (→ Wiring map queue). Chat sync next: sample 3 rows of Wiring map inventory at eea4447.
- Release: #102 opened; 46 open PRs; board at docs/board/pr-board-2026-09-22-0800Z.md; updated order incl. scheduler PRs requested.
