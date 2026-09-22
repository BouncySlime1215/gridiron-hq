---
name: fourth-down-rate-unit-mismatch
description: off_fourth_down_rate is a conversion rate, not an aggression/go-rate, but four consumers read it as aggression. Fix + routing status split to a linked file.
metadata:
  type: project
  modified: 2026-09-22T05:17:03.298Z
---

**Correction 2026-09-22 ~05:11Z** to this file's earlier reading (denominator
believed to include punts/FGs, computed=0.1199 on 2018-2025 data): closer
reading of nfl-pbp.js shows punts and field goals are dropped at line 215,
*before* the accumulator — so `off_fourth_down_rate` (set at nfl-pbp.js:466)
is a clean **conversion rate** (conversions / go-for-it attempts), not a
mixed ratio and not a go-rate. The rest of this entry reflects that
corrected reading.

**The bug:** `off_fourth_down_rate` measures how often a team converts once
it goes for it on 4th down. Four consumers read it as aggression (how often
a team *chooses* to go for it) instead:
- nfl-sim-policy.js:503,510 — `coachAggression`, against
  `leagueFourthDownRate = 0.20`
- nfl-sim-learn.js:52 — same 0.20 as a prior
- football-context.js:195 — user-facing trait label ("goes for it on
  fourth down" / "punts and kicks")
- td-features.js:262

**Measured** on 2022-2025 real data (syncPbpSeason-populated DB, 2,174
team-weeks, 1,602 finite): mean 0.5442, p25 0.000, median 0.500, p75 1.000,
63.2% at or above 0.40.

**Impact:** `coachAggression`'s
`clamp(-(own - 0.20) * 3.0, -0.6, 0.6)` means 63.2% of all team-weeks pin at
the -0.6 clamp floor — read as maximally aggressive coaching — silently, no
warnings or errors. 29.0% get "more conservative than league" prose for
what can be a single 0-for-1 week.

**Correction 2026-09-22 ~05:15Z:** the linked routing file previously said
the producer fix had shipped (commits 1d8f6aa/9d579e7 on branch
claude/project-thread-2oztzw). That was wrong — a coordinator mix-up with
an unrelated push confirmation from the same thread. As of ~05:14Z the
producer fix (RED 94110be, GREEN ed108b6, 7/7 mutations caught) exists
**locally only** in the "R&D integration & cleanup" thread
(cse_01AkWVQyBHMgzzCWthGU6PNw) — not pushed, not on any remote branch (UI
confirmed via grep across all 155 remote branches, zero hits for
`off_fourth_down_go_rate`/`off_fourth_down_situations`). Consumer swap is
therefore **blocked pending push**; Fantasy plan and UI were told
(~05:14Z) to hold off. See [[gridiron-fourth-down-consumer-routing-2026-09-22]]
for full status. UI's interim workaround (relabeling the
football-context.js trait line locally to describe conversion rate, in
progress): [[gridiron-fourth-down-ui-workaround]].

Fix status, consumer-routing detail, sample-size caveats, and the
chat-posting note: [[gridiron-fourth-down-consumer-routing-2026-09-22]].
Sibling finding: [[td-regression-tier-pricing-bug]]. Also referenced from
[[gridiron-dangers-inventory]].
