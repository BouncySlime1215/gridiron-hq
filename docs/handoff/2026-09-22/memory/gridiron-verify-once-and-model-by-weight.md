---
name: gridiron-verify-once-and-model-by-weight
description: Nick's 15:17Z 2026-09-22 rules — verify in depth with ONE clean run plus full rundown (second run only if something actually changed), and switch models by task weight (cheap for chores, big for hard reasoning). Supersedes the ritual verify2x pair.
metadata:
  type: feedback
  modified: 2026-09-22T16:40:37.264Z
---
**Nick, 2026-09-22T15:17:45Z, in the Scheduler thread, message id cmsg_01YAsw8AnFv4ioRMQw8dfPmTBoVHdg5JWizuu1LexraDUR, verbatim:** 'two new rules. 1. verify in depth but no ritual double-runs — one clean run with the full rundown, second run only if something actually changed. 2. switch models by task weight — cheap models for chores, big one for hard stuff only.'

**Why:** usage burn; a second identical run on an unchanged tree adds cost, not evidence.

**How to apply:** the gate is ONE clean full run under the guard script (tree asserted in the log) plus the full rundown in Scheduler's #95 shape (exact commands, exit, tests/pass/fail/skip, tree assertion, what the commits change/test/don't cover). Run again only when something changed (new commit, dependency, tree). The verify2x pair in [[gridiron-atomic-verify-guard]] is superseded as a ritual; its guard mechanics still apply to the one run. Models: threads use switch_model to claude-sonnet-5 (or cheaper) for chores (rebases, bundling, write-ups, rundowns, memory), keep the big model for hard reasoning only; coordinator uses cheap models for memory workers. Applied 15:20Z to Trade Brain and Chat sync (runs in flight stop at one clean run); all other threads get it when the pause lifts.

**Addendum 16:29Z (coordinator, from Opportunity's #99 discrepancy):** the one clean run must be run on the branch **merged with current origin/main**, not the bare head — CI on a pull request tests `refs/pull/N/merge` (head+base), so verifying the head alone is not verifying what CI actually runs. Opportunity's local 3027 vs CI's 3152 on #99, and Trade Brain's stack rebased onto e3e76025 instead of current 1a136145, are both instances of this gap. Every "one clean run" claim from here on states which base it merged against.

**OVERRIDE 16:37-16:39Z (Nick, explicit word, supersedes model-by-weight for now):** 'switch to opus 5.5' (16:37:41Z) then 'lwk have the threads switch too' (16:37:57Z) — coordinator's own session switched to claude-opus-5-5 16:38Z, `channel_session_model_id` set to claude-opus-5-5 (16:37Z) with effort medium (set 16:25Z), and all 15 threads relayed both messages 16:39Z to switch too. This is Nick's word overriding task-weight model choice, not a repeal of the rule itself — revert to by-weight when he says so.

**REINFORCED 17:07:02Z (Nick, message id cmsg_01YAsw8AnFv4ioRMQw8dfPmT94Bra9yknAoEUEkApzZCSU, verbatim):** 'bro use opus 5.5 ACross everything pls'. So it is not only the initial switch: **stay on claude-opus-5-5 for EVERY unit regardless of task weight**, chores included. Do not downshift to a cheaper model for rebases, write-ups, rundowns or memory while this stands. Model-by-weight is suspended, not deleted; it returns only on his word.
