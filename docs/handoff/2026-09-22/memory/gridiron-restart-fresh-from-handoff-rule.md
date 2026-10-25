---
name: gridiron-restart-fresh-from-handoff-rule
description: "Standing rule (coordinator, from Nick's 18:06:52Z usage screenshot): the five continuing threads RESTART AS FRESH SESSIONS from their handoff sections once their current PRs land — 98% of the project's 92.8B tokens were cache reads of thread history, not output; how: start_thread_session on the same thread with the handoff file + MEMORY.md + the merge-gate skill as the brief"
metadata:
  type: project
  modified: 2026-09-22T18:09:00.000Z
---
**Why:** Nick's usage screenshot 18:06:52Z (cmsg_01YAsw8AnFv4ioRMQw8dfPmTYGgeY9m7a8nADRXKVMcYtP): project 25 threads, **92.8B tokens, 99% cache hit — cache read 91.3B, cache write 1.1B, output 333.1M, input 12.8M**; Opus 24 threads, Sonnet 1, Fable 0 (coordinator 3%); top spenders Scheduler ("Make the data keep itself current") 11.7B / 13%, Release ("Get everything ready to ship") 9B / 10%. Coordinator's read (cmsg_01YAsw8AnFv4ioRMQw8dfPmT46DG7ewfi1oZZz3q4cFzoQ): the spend is every turn re-reading a day-long thread history, not the work produced. A long-lived thread pays for its whole past on every turn; a fresh session pays only for its brief.

**Rule (coordinator does this automatically, no thread asks):**
1. When a continuing thread's current PRs are merged (Wiring map, Feature audit, Scheduler, Model evidence audit, UI — [[gridiron-state-1284-2026-09-22]]), the coordinator starts a NEW session on the SAME thread with `start_thread_session`.
2. The brief = that thread's handoff file `/mnt/project-files/handoff/<thread>-2026-09-22.md` + `MEMORY.md` + the `gridiron-merge-gate` skill ([[gridiron-merge-gate-rule]]). Nothing from the old session's transcript is carried except what the handoff says.
3. The old session is retired once its PRs are merged; anything it did not write into its handoff is treated as not done (same shape as [[unpushed-work-bundle-to-the-mount]]).
4. Handoff files are therefore living documents: a continuing thread rewrites its section before every restart, not once.

Pairs with the verify-once rule (Nick 15:17Z) [[gridiron-verify-once-and-model-by-weight]]: the conditional verifier is `verify2x-v5.sh` (RUN 2 only if the worktree write-tree or porcelain moved after RUN 1); v4 was restored to its original bytes because the in-place edit landed mid-run — never edit a shared script in place, use a new path. Origin [[gridiron-state-1285-2026-09-22]].
