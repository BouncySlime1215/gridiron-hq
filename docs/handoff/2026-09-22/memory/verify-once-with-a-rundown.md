---
name: verify-once-with-a-rundown
description: Nick's 2026-09-22 15:17Z rule — one clean verification run plus a full rundown, not a ritual 2x pair; rerun only if something actually changed.
metadata:
  type: feedback
---

Nick Matta, 2026-09-22T15:17:45Z, verbatim: *"verify in depth but no ritual
double-runs — one clean run with the full rundown, second run only if something
actually changed."*

This **retires the standing 2x-verify pair** as a default. One clean run is the
gate. What replaces the second run is depth of reporting, not repetition.

**Why:** the second run was burning a full suite (~5-9 min of compute and a
slice of the usage meter) to re-measure a tree that had not changed. It bought
almost nothing: in every pair run on 2026-09-22 the two runs agreed exactly
(e.g. `19f4b35` measured 2999/2958/0 twice). Nick's own complaint on #95 was
the opposite problem — `"3009/0" is a bare number, doesn't count` — so the
value is in the rundown, not the repeat.

**How to apply:**
- Run the check ONCE on the tree actually being pushed. Read the exit status
  from `$?`, never infer it.
- Then produce the full rundown, which is now the deliverable: the exact
  commands (the whole chain `npm run check` expands to, each banner quoted from
  the log), pass / fail / skip / cancelled / todo, an independent
  `grep -c '^not ok'`, what the skips are and whether any of them cover the
  change, the added tests reconciled file by file against the baseline, and
  **what the change is not covered by**. See
  [[pr-95-rundown-shape]] for the shape Nick accepted.
- A second run is justified only when something changed: a new commit, a
  different tree, a dependency install, or a failure you are trying to
  reproduce. "For confidence" is not a change.
- The tree binding still matters — [[real-means-the-check-ran-on-the-pushed-tree]].
  Get it from a printed assertion in the run itself where you can, rather than
  buying it with an extra run.

**An unfinished run is not a clean run.** The `-child-flush` unit is the worked
example: its run 1 was killed mid-test-phase at test 2616 (no TAP footer, the
`build` and `start:smoke` banners never printed), because `TaskStop` on the
watching monitor took the driver's process group with it. That needs a run when
work resumes — it is not a ritual repeat this rule excuses. Kill the watcher
with the run detached from it, or accept that stopping the watcher stops the run.
