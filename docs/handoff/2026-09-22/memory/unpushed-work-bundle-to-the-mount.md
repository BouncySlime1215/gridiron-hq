---
name: unpushed-work-bundle-to-the-mount
description: While push authority is revoked, git-bundle held commits to /mnt/project-files and restore-test the bundle by fetching it — a container restart on 2026-09-22 made the risk concrete.
metadata:
  type: feedback
---

**The container restarted at ~12:05Z on 2026-09-22.** Everything survived — repo,
local commits, `/tmp/claude-0`, memory — because it was a restart rather than a
reclaim. That was luck. The environment notes say the repo is cloned fresh on
container start and the container is reclaimed after inactivity, so **anything
unpushed is one reclaim from gone.**

**Why this bites right now:** Nick's 09:42Z revocation holds all pushes, so
verified work accumulates locally. At the restart I was holding four commits on
one branch plus two single-commit corrections on two others, and another thread
was holding one the same way — including two 2x-verified trees at ~13 minutes of
check time each.

**How to apply.** While pushes are held, bundle every held branch to the shared
mount as soon as it is committed, not at the end of the session:

    git bundle create /mnt/project-files/<name>-<sha>.bundle <base>..<branch-ref>

**The right-hand side must be a NAMED ref**, not a sha — `git bundle create f
A..B` with two shas fails with "Refusing to create empty bundle", which reads
like the range is empty and is not.

**Restore-test it; `git bundle verify` is not enough.** Verify only checks the
prerequisites are reachable *in the repo you are standing in*. The real test is
a fetch into a throwaway clone:

    git clone -q --bare . /tmp/bundletest && cd /tmp/bundletest
    git fetch -q /mnt/project-files/<name>.bundle 'refs/heads/*:refs/bundle/*'
    git log --oneline -N refs/bundle/<branch>
    git show refs/bundle/<branch>:<a file the commit added>

Check both the commit list and a file's contents come back, then delete the
clone. Same rule as everywhere else in this project: a backup nobody has
restored is a claim, not a fact. See [[measure-the-seam-do-not-read-it]].

**A bundle is a backstop, not a branch.** It needs someone to fetch it and it
does not outlive the mount. When work is piling up unpushed, say so upward —
the revocation costs durability, not just latency, and that is a tradeoff the
person holding the authority should make knowingly.

**Shallow-clone bundles (2026-09-22 12:30Z, [[gridiron-state-1160-2026-09-22]], [[gridiron-state-1168-2026-09-22]]):** git bundle verify passes on a bundle made from a shallow clone that cannot be cloned; the only test is a restore into a repo that already has the prerequisite (fetch, never clone); range bundles from a pushed tip are small (89 KB vs 9.3 MB).

Never fetch main from another shallow clone on the box (shallow roots cannot be updated); fetch main --depth=1 from the GitHub remote, then the bundle.

A full self-contained bundle can trip a session's safety classifier as bulk data leaving the repo; a narrow range bundle from a pushed tip does not (Model evidence audit 12:48Z).

Never delete a superseded sibling bundle (different base, not an ancestor); mark its sidecar SUPERSEDED pointing at the new one (Trade Brain 12:59Z).
