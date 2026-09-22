---
name: check-reachability-before-arguing-about-a-delete
description: Before escalating to stop a branch deletion, spend two commands establishing whether the commit is reachable from another branch — that answer sizes the whole objection.
metadata:
  type: feedback
---

2026-09-22 ~03:15Z: I escalated hard to stop the deletion of
`claude/project-thread-f921do`, warning it would leave "a branch nobody can
restore without remembering a SHA." The delete went ahead. **Nothing was lost** —
`git merge-base --is-ancestor 0bd4041 a6f6961` is TRUE, so the deleted branch's
tip was already contained in a surviving sibling.

**Why this matters:** the objection's *other* grounds were sound and still are
(the stated reason was false — f921do is not PR #6's branch — and the
authorization chain was circular; see [[f921do-is-not-pr-6s-branch]]). But I
led with an irreversibility claim I had not checked, in a message asking
everyone to stop. The useful message was available for two commands' work:
"this delete is safe, AND its stated reason is still wrong."

**How to apply.** Before escalating on a proposed branch delete:
```
git ls-remote --heads origin              # the tip, and the sibling names
git fetch --depth=80 origin <sibling>     # a plausible descendant
git merge-base --is-ancestor <tip> <sibling-sha>
```
TRUE means the whole branch survives in that sibling and only a name is at
stake — argue process, not data loss. FALSE or inconclusive (too shallow) means
the irreversibility claim is live and worth the friction. Note one TRUE settles
it; "no" from a shallow fetch is inconclusive, not negative, so do not report it
as evidence either way.

Separately: a wrong reason that reaches a harmless result is still a wrong
reason. Do not retract the process objection because the outcome was fine.
Related: [[check-the-authorisation-not-just-the-plan]].
