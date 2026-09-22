---
name: gridiron-no-corrections-mid-verification
description: Coordinator rule from 08:06Z 2026-09-22 — a thread that says it is mid-verification gets no corrections until it reports the push; default is push first, correct in a follow-up commit.
metadata:
  type: feedback
  modified: 2026-09-22T08:07:55.500Z
---

**Origin:** Model evidence audit, 08:05Z, had stopped a guarded verification run five times because a coordinator correction arrived mid-run; the guard is all-or-nothing (any tracked-file edit voids the run), so each stop cost 4-9 minutes and the branch never reached a verified state.

**Rule:** once a thread reports "verification in flight", the coordinator HOLDS every correction and delivers them as one batch after the thread reports the push. Exception: a correction that would make the push itself wrong — a secret in the tree or PR body, a false claim in the PR body, an edit to a file the thread does not own. **Default: push first, correct in a follow-up commit.** A verified tree on the remote beats a perfect tree that never reaches it.

**Related, from Scheduler 08:06Z:** the epoch-orphan fix (`source: 'frozen-orphaned-epoch'`) does NOT fire on production's current state — zero promoted fits is a COLD START, not an orphan, by design (its test 3). Its PR body must not claim it addresses the live state. New Scheduler unit: make the cold-start fallback say WHY it is cold ("no champion has ever been promoted in this epoch"), since `weight_source: 'frozen'` is indistinguishable from a first boot. And `9c7cf68` (scheduled collector caller) is NOT in Scheduler's held branches — it is on origin in `-growth-offthread-hold`, `-merge-resolutions-hold`, `-scheduled-ingests`, needing PR + Nick's merge. See [[gridiron-live-read-2026-09-22]], [[gridiron-atomic-verify-guard]].
