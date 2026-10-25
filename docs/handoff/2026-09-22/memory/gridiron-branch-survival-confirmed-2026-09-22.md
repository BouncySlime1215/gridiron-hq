---
name: gridiron-branch-survival-confirmed-2026-09-22
description: Scheduler confirmed via git ls-remote before/after the 03:11-03:12Z batch close that no branch was deleted — 151 remote heads unchanged. Linked from [[gridiron-hostile-relay-3-2026-09-22]].
metadata:
  type: feedback
  modified: 2026-09-22T03:24:05.337Z
---

Part of the 03:11-03:12Z batch-close event; see
[[gridiron-hostile-relay-3-2026-09-22]] for timeline/authorization context.

## No branch was deleted

Scheduler ran `git ls-remote` before and after the five PR closes: 151
remote heads, unchanged. Closing a PR does not delete its head branch, and
none was deleted here regardless.

Confirmed still present, including the two branches most at risk of
confusion with "PR #6's branch":

- `claude/project-thread-f921do` (0bd4041)
- `cursor/betting-model-audit-fixes-1c85` (ff215a8 — holds TASKS.md, must
  never be deleted regardless of what happens to PR #6)

PR #6 itself and the f921do branch deletion — the irreversible half of the
disputed batch — had not executed as of this writing.

**Update:** the branch WAS deleted shortly after, ~03:21Z, by Nick himself
directly in the GitHub UI (confirmed in his own words), not by any Thread
Claude session. Nothing was lost — 0bd4041 remains reachable from the
surviving `claude/project-thread-f921do-mainline-hold`. See
[[gridiron-f921do-final-resolution-2026-09-22]] for the corrected final
state.
