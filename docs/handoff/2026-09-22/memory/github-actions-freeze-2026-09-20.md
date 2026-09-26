---
name: github-actions-freeze-2026-09-20
description: Nick's GitHub Actions limit was hit at 2026-09-20 01:04Z — a hard freeze on pushes, new PRs and anything that triggers CI, until the coordinator lifts it.
metadata:
  type: project
  modified: 2026-09-20T01:10:00.000Z
---

**Relayed from Nick via the coordinator at 2026-09-20 01:04Z: his GitHub
Actions limit is hit.** The coordinator was cancelling queued and running
workflows and disabling workflows on the repo.

**FROZEN until the coordinator says otherwise:**
- no `git push`
- no new pull request, and no marking an existing one ready
- no workflow re-run, no base-branch change, nothing that triggers CI

**Local work only.** Committing locally is fine and is the right way to hold
work — it triggers nothing. Do not confuse "committed" with "pushed" when
reporting state.

**What the feature-audit thread is holding:** commit `89bbf68` on
`claude/project-thread-5f9c3y-byerisk-honest`, branched off #62's head — the
`roster-risk.js` bye-risk honesty fix plus `test/bye-risk-not-modelled.test.js`.
Suite green locally, 2,961 / 0 failed. Not pushed, no PR.

**Already pushed before the freeze, so untouched by it:** #55, #57 (head
`aca74f9`), #62 (head `25d911c`), #64 (head `7eb5118`). #64's workflow may have
been cancelled mid-run; a cancelled run is not a failing run and must not be
re-run while the freeze holds.

See [[feature-audit-shipped-prs-55-57]].
