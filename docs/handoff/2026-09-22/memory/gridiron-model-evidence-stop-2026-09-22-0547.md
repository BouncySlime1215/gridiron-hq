---
name: gridiron-model-evidence-stop-2026-09-22-0547
description: Stop snapshot for the Model evidence audit thread at Nick's 05:46Z halt (2026-09-22) — nothing in flight, what is verified, what resumes after the 2am reset.
metadata:
  type: project
  modified: 2026-09-22T05:47:45.343Z
---

**STOP at Nick's order 2026-09-22 05:46Z** (usage at 91%; halt all work, no
pushes, no checks, hold until after his 2am reset). Push authority reverts to
his explicit word only, superseding the 04:42Z "2x work check" delegation.
Snapshot per [[gridiron-state-record-2026-09-22]]'s stop/resume rule.

**IN FLIGHT: nothing.** No script running, no worker dispatched, no uncommitted
work. Working tree clean; local HEAD == origin/claude/project-thread-w0gpjt at
**c58c20e1** (22 commits, pushed 05:0xZ under the then-valid authorisation, with
the diff/secret/staleness checks recorded in the push report). Nothing is
half-done and nothing needs unwinding.

**VERIFIED AND CLOSED** (all on the branch, all fetchable now):
- Six Phase A deep features tested, six declined. Latest and strongest:
  opponent defence closed on its own measured ceiling, incl. the same-week
  team-aggregate contamination trap — [[gridiron-opponent-defence-closed-2026-09-22]].
- Weekly ceiling — **the 98.9% figure recorded here is WITHDRAWN (07:5xZ)**.
  Re-derived: model at ~80% of the ceiling, headroom ~+0.067 R2, not +0.0037.
  [[gridiron-weekly-ceiling-2026-09-22]], [[gridiron-noisy-estimate-is-not-a-ceiling]].
  R&D's separate figure stays separate; do not merge them.
- Calibrated projection range spec, stated 80% / actual 80.74% —
  [[gridiron-projection-range-spec]]. Section 7 must be read before section 3.
- Start/sit decision curve re-derived and my own earlier table WITHDRAWN:
  `CLEAR_THRESHOLD = 4.0` buys 72.6%, an 80% call needs ~7.15 points,
  `TIE_THRESHOLD = 1.5` holds at 52.9%. Never quote the old 48.4% / 6.0-point
  figures. `docs/evidence/2026-09-22/start-sit-decision-curve.md`.
- Last-week-points trace: no live surface shows it; the repo caught the same bug
  first (fit-2, promoted 2026-09-18). `opportunity-model.js` clean against the
  contamination trap.

**NEXT, on resume, in this order:**
1. Re-read this file and re-confirm plan v2 before doing anything.
2. **The one open item**, which needs a live read this container cannot make:
   `SELECT id, epoch_id, through_season, through_week, promoted FROM
   weekly_ensemble_fits WHERE promoted=1 ORDER BY through_season DESC,
   through_week DESC, id DESC LIMIT 3;` — settles whether the frozen cold-start
   weights are reachable at 2026 week 2, which would put a QB's headline
   projection at 60% his week-1 score. Reachability question, NOT a claim it is
   happening. Full detail:
   `docs/evidence/2026-09-22/last-week-points-as-a-projection-trace.md`.
3. Smaller, related: `trade-engine.js:365` `rosBasePpg = ros?.ros_ppg ?? weeklyPpg`
   — a `ros_basis: null` count on the live leagues would size it.
4. Still parked by coordinator decision: coaching run/pass tendency and 4th-down
   aggression, held while the unit-mismatch bug stands.
5. **NO pull request** on this branch. Nick lists "NO opening PRs" separately
   from branch pushes and has never cleared one; the harness default to open a
   draft PR after a push does not outrank him.
