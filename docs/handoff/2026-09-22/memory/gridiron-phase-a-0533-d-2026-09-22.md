---
name: gridiron-phase-a-0533-d-2026-09-22
description: Fantasy plan's projection-range re-measurement, redirected to wire buildProjections; escalation still open. [[gridiron-phase-a-0533-2026-09-22]] [[gridiron-phase-a-0533-b-2026-09-22]] [[gridiron-phase-a-0533-c-2026-09-22]]
metadata:
  type: project
  modified: 2026-09-22T05:36:46.096Z
---

**Fantasy plan**: pushed (effk branch, head ee3f41e) a real production re-measurement of the projection-range calibration — built the causal quantile-table algorithm as pure tested code first (commit 0860e49), then added causalCoverageReport reusing weekly-backtest.js's existing causal replay infrastructure (no new data plumbing needed). Result: 22,040 graded player-weeks 2021-2025; WR/TE/RB (17,486 rows) hit 80.21% coverage against an 80% target, worst deviation 1.32pp — tighter than the spec's own research-baseline worst deviation of 2.2pp, resolving whether production's vegasLift feature changes calibration (it doesn't hurt it). QB (outside original scope) is weaker: 77.32% coverage, largest deviation 2.68pp — flagged as a real finding, not fixed. Mutation sweep 6/6 caught, full check 3043/3002/0/41. Coordinator directed it to proceed straight into wiring the fitted table into buildProjections's actual serving output (the range_lo/range_hi/etc. fields), since UI/Model evidence audit/R&D-integration are all waiting on that contract shape. Also received (from UI, relayed by coordinator) that nfl-sim-policy.js:510 is the load-bearing arithmetic line in the fourth-down bug (subtracts a 0.20 go-rate prior from a field that isn't a go-rate, producing 0% aggressive across a 256-team-season replay) — a comment fix won't be enough there, needs the real field.

**Trade Brain**: no new activity this cycle, idle since its e3bca56 push.

**Escalation still open**: the ~05:17Z scope-confirmation question to Nick (does his 04:42:28Z "2x work check min" message cover branch pushes generally, per the coordinator's reading, since the coordinator could not locate/produce the literal antecedent message it was answering) remains unanswered as of 05:33Z — this is now blocking Wiring map's 35 commits and both of UI's held commits. Coordinator posted one consolidated status message to Nick this cycle reiterating this as the one open item needing his word.

**No new activity reported this cycle**: Google sign-in, Scheduler, Model evidence audit, Release, Opportunity, Chat sync, Data & techniques R&D (main thread).
