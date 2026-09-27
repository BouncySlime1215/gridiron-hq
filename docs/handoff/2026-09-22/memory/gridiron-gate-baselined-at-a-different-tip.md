---
name: gridiron-gate-baselined-at-a-different-tip
description: A CI gate verified against one tip of main and squash-merged onto another took main and every open PR red; rebase and re-run a gate immediately before merging it.
metadata:
  type: feedback
---

2026-09-22, Wiring map thread. PR #108 turned the wiring gate on. Its findings
were baselined against `main` at `ac31922`. Nine PRs landed before it merged.
GitHub squash-merged it onto the new tip **without a conflict**, and the gate
had never run against that combination. `main` went red, and because a
`pull_request` build checks out `merge(head, base)`, **every open PR in the
fleet went red with it within minutes** — no rebase required for a main-side
gate to reach a branch.

**Why:** a clean squash merge proves the text merges, not that the check still
passes. Two clean pre-push guard runs on #108's own head never executed the
gate, because `npm run check` did not include `check:wiring` at the time.

**How to apply:** before merging any change that adds or tightens a CI gate,
rebase onto the **current** tip of the base branch and re-run the gate there,
not on the head it was written against. Fold the gate into the same command the
pre-push guard runs, so a green guard means the gate ran. When a gate does take
main red, diagnose it as the gate's own false positives first — all three of
#129's blocking findings were — and fix the root cause rather than baselining.

Fix landed as #129, merged `c90d2834`; main's push run `35763448618` succeeded.

Related: [[gridiron-rebase-before-merge-lesson]],
[[gridiron-local-gate-includes-wiring-rule]], [[gridiron-evidence-citation-rule]].
