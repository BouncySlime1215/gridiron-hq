---
name: gridiron-github-freeze-2026-09-20
description: Nick's hard GitHub freeze of 2026-09-20 01:58Z — no new PRs, no pushes to any branch that has one — and the -hold branch convention that replaces pushing during it.
metadata:
  type: feedback
  modified: 2026-09-20T02:40:00.000Z
---

**Nick ordered a hard GitHub freeze at 01:58Z on 2026-09-20.** Relayed by the
coordinator at 02:29Z (and by session message at 02:13Z and 02:25Z).

**Why:** every push to a branch that has a pull request, and every new pull
request, emails him. He is asleep. This is not about the code.

**Until his go in the morning, none of these:**
- a new pull request
- a push to any branch that already has a pull request
- a comment on a pull request
- marking anything ready for review

**What to do instead:** commit locally, and to preserve work push **only to a
new branch in your own namespace with no pull request, suffixed `-hold`**.
Then send the coordinator the branch and head by session message. The head is
the record; nothing on GitHub is.

**I opened #77 at 02:23:14Z, after the freeze**, because the order had not
reached this session — the coordinator's two earlier session messages never
arrived and the 02:29Z relay was the first of it. That is a fact about
delivery, not an excuse: it emailed him.

**The lesson worth keeping past tonight.** A thread that is working well is
exactly the one that will keep shipping through a stop order, because it is
mid-flight and the order arrives between turns. When a restrictive instruction
turns up from any direction — coordinator relay, session message, a note in a
digest — comply first and reconcile afterwards. There is no cost to holding a
push for a few hours and there is a real one to sending it.

**It does not apply to:** reading GitHub, committing locally, pushing to a
`-hold` branch, subscribing to PR activity (no email), memory, or the thread's
own status checklist and replies.

Actions minutes are a separate constraint that outlives this one:
[[gridiron-actions-limit-2026-09-20]] — CI off until 2026-10-01, every push
preceded by a full local check. Branch and head record:
[[gridiron-tdd-evidence-sweep-o3wt2p]],
[[gridiron-asset-universe-cannot-go-offthread]].
