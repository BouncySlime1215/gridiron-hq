---
name: pr6-split-into-five
description: PR #6 was split into five stacked PRs on 2026-09-19 and all of the code is now on main; what is still open (the corpus question) and why none of the five branches may be deleted.
metadata:
  type: project
  modified: 2026-09-19T21:36:00.000Z
---

**Still live, read this first.**

**PR #6 is still open.** All of its *code* is on `origin/main` at `791b131`;
only the 63 MB research corpus is unique to its branch
(`cursor/betting-model-audit-fixes-1c85`). Closing it and rehoming the corpus
is Nick's call, not a thread's — [[gridiron-research-corpus-home]] has what
the corpus is and the second-private-repo recommendation. Nothing was deleted
from that branch and its history is intact.

**Delete NO branches in the `claude/project-thread-3ldl77*` stack.** Roughly
fourteen open PRs are based on `claude/project-thread-3ldl77-docs` (#15, #17,
#18, #21, #22, #23, #25, #26, #36, #37, #38, #39, #40, #42), and #24 is based
on `…-server`. Closing a PR keeps its branch; deleting the branch strands
every PR stacked on it. They must be retargeted to main first — the release
thread's job. Verified after closing #9–#12 that all five branches are still
on the remote.

**What the split was.** Five stacked draft PRs, each based on the one before:
**#7** `claude/project-thread-3ldl77` (CI fixes) → **#9** `…-deploy` (fly.toml,
Dockerfile, HOST bind, db mkdir) → **#10** `…-server` (the engine) → **#11**
`…-client` (UI teardown) → **#12** `…-docs` (markdown). PR #13 was based on
the cursor branch and would have been stranded, so its commits were replayed
onto `…-server` and reopened as **PR #24** — which is why the stack forks
at #10.

**Method:** each path's state was taken from the cursor branch head rather
than replaying its 375 commits, so corpus blobs never entered the new
history. **Proven seam:** `git diff` from the top of the stack to that head
listed ONLY `docs/betting-model/`, non-markdown under `docs/evidence/`,
`data/line-history/availability_predictions.csv`, `index.ts` and
`.cursor/environment.json`. Every line of code landed. Code was 9% of #6's
lines and 46% of its files; the rest was corpus.

**Outcome, 2026-09-19 21:30Z.** #7 was merged. The other four were never
merged as PRs: the release train (`claude/release-train-2yv3x6`, PR #35)
carried their commits onto main, so all five branch heads are ancestors of
`origin/main` at `791b131`. #9–#12 were therefore closed as **superseded, not
pending** — merging them would have been a no-op — each with a comment naming
its head SHA. Signature files verified present on main, betting UI gone,
corpus and `index.ts` and the CSV still absent.

The five CI defects this split uncovered: [[gridiron-ci-blockers]]. See also
[[fly-deployment-outside-repo]].
