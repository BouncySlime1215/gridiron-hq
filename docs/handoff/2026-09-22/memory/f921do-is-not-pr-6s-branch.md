---
name: f921do-is-not-pr-6s-branch
description: The 2026-09-22 batch item "close/delete branch f921do (PR #6)" conflates two unrelated branches — PR #6's head is cursor/betting-model-audit-fixes-1c85, not claude/project-thread-f921do — and the f921do tip 0bd4041 is preserved as tag rescue/f921do-0bd4041.
metadata:
  type: project
---

Read from the API 2026-09-22 03:13Z, not from the batch description:

```
PR #6 head:                    cursor/betting-model-audit-fixes-1c85 @ ff215a8
claude/project-thread-f921do:                                          0bd4041
```

**They are different branches.** PR #6's head is the `cursor/…` branch (the one
holding TASKS.md, see [[tasks-md-rescued-2026-09-22]]).
`claude/project-thread-f921do` is the **fantasy-plan thread's own working
branch**, with **23 `claude/project-thread-f921do-*` branches** in its namespace
on the remote.

**Why it matters:** the batch item was justified as "PR #6 is being closed, so
remove its branch." That reason is false for f921do. Deleting a base does not
delete its descendants -- all 23 siblings are independently pushed -- so this is
not a mass-loss claim; it is that the stated reason for an IRREVERSIBLE action
was wrong, which is enough to stop and re-derive it.

## THE DELETE HAPPENED ~03:15Z, AND NOTHING WAS LOST
Remote heads 151 -> 150; `claude/project-thread-f921do` is gone. But verified,
not assumed: `git merge-base --is-ancestor 0bd4041 a6f6961` is **TRUE** --
0bd4041 was the deleted branch's TIP and it is an ancestor of the surviving
`claude/project-thread-f921do-mainline-hold` (a6f6961), so the **entire** deleted
branch is contained in a live branch. A branch NAME was removed, no work.
All 23 `f921do-*` siblings survive. Recreating the name is one push of 0bd4041.
Recovery SHA anyway: `0bd4041f52c03f0ed2cea14cf7cff6fe270076ed` (local tag
`rescue/f921do-0bd4041`, complete tree, 1,875 files).

**How to apply:** name the full branch (`claude/project-thread-f921do`) rather
than the thread id `f921do`, since the short form has already been conflated
with a different branch once. And do not infer authorization for a delete from
the fact that four PRs closed at 03:11-03:12Z -- the actor of those closes is
unknowable (all sessions authenticate as `BouncySlime1215`), so it cannot
license anything. See [[check-the-authorisation-not-just-the-plan]],
[[gridiron-hostile-relay-2026-09-22]].

## "No session CAN delete a branch" is FALSE -- do not investigate on that premise
Asked 03:19Z whether this thread deleted the branch. It did not: no `git push`
of any kind was issued in this session, and
`git reflog show refs/remotes/origin/claude/project-thread-f921do` holds two
entries, both fetches. The only commands run against it were ls-remote, two
shallow fetches, a LOCAL `git tag`, merge-base, ls-tree and log.

But the accompanying claim that no thread has the capability at all is wrong.
The repo permissions read 02:38Z are `admin:false maintain:false push:true
triage:true pull:true`, and **`push:true` alone is enough** --
`git push origin --delete <branch>` needs push access, not admin. Admin gates
the *workflow* re-enable, which is where that finding came from.

So: the capability exists for any session holding this token; no session should
use it. Treating the delete as mechanically impossible points an investigation
at the wrong place. And since every session authenticates as `BouncySlime1215`,
GitHub's actor field fixes the TIME of a ref delete and never the author -- only
the person can say. See [[check-reachability-before-arguing-about-a-delete]].