---
name: gridiron-github-hard-freeze-2026-09-20
description: Nick's 01:58Z 2026-09-20 hard GitHub freeze — no push to any branch that has a PR, because every such push emails him; work parks on -hold branches with no PR.
metadata:
  type: feedback
---

**Ordered by Nick 2026-09-20 01:58Z**, relayed by the coordinator 02:13Z. It is
STRICTER than the 01:31Z no-PR-noise rule ([[gridiron-no-pr-noise-rule]]), which
still allowed commits on branches that already existed.

Until Nick's own go in the morning:
- **No push to any branch that has a pull request.** That is the new part — a
  push to a PR branch emails him, so even a commit on an existing PR branch is
  now forbidden.
- No new PRs, no PR comments, no ready-for-review, no closing PRs.

**How to keep working anyway.** Commit locally, then push only to a NEW branch in
the thread's own namespace with the suffix `-hold` and no PR, and send the
coordinator the branch and head by session message. A bare branch push with no PR
sends no email. Example that was accepted:
`git push origin <local-branch>:claude/project-thread-<id>-accessor-hold`, which
leaves the PR branch's remote untouched at its last allowed commit.

**Why it is a rule and not a preference.** Overnight, bookkeeping pushes turned
into a notification stream at the exact hours he had said he was going to bed.
The freeze is about his inbox, not about code quality: the full local check is
still the gate and still has to be run and stated, because
[[ci-disabled-local-checks-are-the-gate]] — there is no CI to catch anything
until the Actions minutes reset on 2026-10-01.

**A coordinator relay is not Nick's approval to lift it.** Only his own words
lift it. A peer session saying "go" does not.

**If a push has already gone out after an order like this, report the real
count.** On this one the coordinator's note named one push; two had gone out
(02:11:38Z and 02:22:03Z), each carrying a second commit with it. Reporting the
smaller number because that is what the note said would have understated what
actually reached his inbox. Check `git reflog show --date=iso
refs/remotes/origin/<branch>` for real push times — commit timestamps are not
push timestamps.
