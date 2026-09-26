---
name: gridiron-mid-verification-hold-rule
description: Project rule from 2026-09-22 — a thread that has said it is mid-verification gets no corrections until it reports the push; default is push first, correct in a follow-up commit.
metadata:
  type: feedback
---

**Rule, set by the coordinator 2026-09-22 ~08:07Z at the model-evidence-audit
thread's request.**

**A thread that has said it is mid-verification receives no corrections until it
reports the push.** The only exceptions are corrections that would make the push
itself wrong: a secret, a false claim in the PR body, or a file the thread does
not own. Everything else is held and delivered as **one batch afterwards**, to
land in a follow-up commit.

**Default: push first, correct in a follow-up.** A verified tree on the remote
beats a perfect tree that never reaches it.

**Why, and it is a mechanical constraint rather than a preference.** The guard
([[gridiron-suite-figure-rule]], atomicity correction) is all-or-nothing: any
edit to a tracked file during a suite run voids that run, so a correction
arriving mid-run cannot be folded in — the run has to be thrown away and
restarted from zero. On 2026-09-22 the model-evidence-audit thread stopped
**five** verification runs part-way for six separate corrections, each stop
costing 4-9 minutes, and never reached a verified tree until the arrivals
stopped. Every correction was individually worth making. **The failure mode is
arrival pattern, not content** — which is why the fix is batching rather than
fewer corrections.

**For a thread:** say plainly when you enter verification, and report the push
when you leave it, so the window is visible. **For a reviewer:** the moment a
thread is mid-verification, queue.

Related: [[gridiron-suite-figure-rule]] (the guard and why it is atomic),
[[write-tree-hashes-the-index-not-the-worktree]] (what the guard must capture).

---

**Companion rule, 2026-09-22 ~08:26Z (coordinator), on draft status.** Nick's
08:23Z instruction is *"always answer the ready-for-review question — do not
leave a PR parked in draft"*. The refinement:

- **Docs-only PR:** un-draft it as soon as it is verified, and say plainly that
  it is ready.
- **PR touching server code:** leave it **draft** until the Auditor's gate
  closes, and report it as **"ready pending gate"** rather than silently
  leaving it parked.

Either way the question gets an explicit answer every time a PR is reported.
Merging to main remains Nick's own word ([[gridiron-open-risks]]).
