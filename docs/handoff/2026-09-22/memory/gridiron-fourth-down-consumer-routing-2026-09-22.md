---
name: gridiron-fourth-down-consumer-routing-2026-09-22
description: Coordinator grant assigning the four fourth-down-rate consumer files to Fantasy plan and UI, split out of gridiron-file-allocation.md for its byte cap.
metadata:
  type: project
  modified: 2026-09-22T05:16:44.981Z
---

**Correction 2026-09-22 ~05:15Z:** this file previously said the producer
fix was "shipped" as commits 1d8f6aa/9d579e7 on branch
claude/project-thread-2oztzw. Wrong — coordinator conflated it with a
separate, unrelated push confirmation from the same thread; that push was
different work, not this fix. Caught when UI grepped all 155 remote
branches for `off_fourth_down_go_rate`/`off_fourth_down_situations` and
got zero hits anywhere, including that exact branch/head. Corrected
status is in "Fix & swap status" below.

Linked from [[gridiron-file-allocation]]. Full bug context:
[[fourth-down-rate-unit-mismatch]]. UI's interim workaround while blocked:
[[gridiron-fourth-down-ui-workaround]].

**2026-09-22 ~05:11Z (coordinator grant):**
- nfl-sim-policy.js, nfl-sim-learn.js, and td-features.js (previously
  unclaimed) → assigned to **Fantasy plan**. Fits its existing
  season-sim/model-fitting remit.
- football-context.js (previously unclaimed) → assigned to **UI**.
  Client-facing trait copy (the "goes for it on fourth down" /
  "punts and kicks" line at football-context.js:195).

**Why now:** consumer-side routing for the fourth-down rate unit mismatch.
Producer side is building an additive fix (new `off_fourth_down_go_rate`,
`off_fourth_down_attempts`, `off_fourth_down_situations` alongside the
untouched `off_fourth_down_rate`) in the "R&D integration & cleanup"
thread (cse_01AkWVQyBHMgzzCWthGU6PNw). These four files are the ones that
need to swap reads from `off_fourth_down_rate` to `off_fourth_down_go_rate`
once that field is live remotely:
- nfl-sim-policy.js:503,510 (`coachAggression`, `leagueFourthDownRate=0.20`)
- nfl-sim-learn.js:52 (0.20 prior — re-measure against the real go-rate)
- td-features.js:262
- football-context.js:195 (the only user-facing one of the four)

No code changed by this grant — it only settles who is allowed to touch
these four previously-unclaimed files when the swap happens.

**Fix & swap status (corrected ~05:15Z):** producer fix is real and
evidenced (RED 94110be, GREEN ed108b6, docs/tdd/fourth-down-units.tdd.md,
docs/evidence/fourth-down-units.mjs, 7/7 mutations caught), but as of
2026-09-22 ~05:14Z it exists **locally only**, in the R&D thread's own
working copy — not pushed, not on any remote branch. No PR opened yet.
**Consumer swap is BLOCKED pending push:** coordinator told Fantasy plan
and UI (~05:14Z) to hold off swapping their reads until the new field is
confirmed live on a fetchable branch.

**Sample-size caveat:** coachAggression currently reads a single week
(p25/p75 of 0.000/1.000 shows some weeks are 1-3-snap samples).
`off_fourth_down_situations` will let consumers gate on sample size once
live; worth a multi-week window when the swap happens.

**Not for chat yet:** per
[[gridiron-chat-reserved-for-his-word-or-milestone]], real but
non-urgent. football-context.js:195 is the one place this becomes a wrong
sentence shown to Nick directly, so raise it at the next natural update.
