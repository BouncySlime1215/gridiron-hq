# Integration intake: what happens when a build comes in

Nick (2026-09-22 ~20:20Z): "the most important thing with the builds is that when it comes in we look at what it uses and routes to — see if there's anything else to be done there — it's the integration." In the cloud project the coordinator did this by hand and it was token-heavy. Here it runs as a fixed procedure: a script does the mechanical tracing for free, one small agent makes the judgment calls, and the result is logged with the handoff.

## Trigger

Every PR that merges through `~/gridiron-local/bin/gate-merge.sh` (it runs step 1 automatically). The heartbeat runs step 2 for any card whose verdict is still `_pending_`. For a PR opened by a build workflow but not yet merged, step 1 can run on the open head (`integration-card.sh N` handles both).

## Step 1: integration card (script, 0 tokens)

`~/gridiron-local/bin/integration-card.sh N` writes `docs/handoff/local/integration/PR-N.md`:
- files changed;
- every symbol touched (exported or enclosing a changed hunk), where it is defined, and every caller on origin/main (a symbol with 0 references left after a removal means the removal was clean; an export with no callers is a candidate orphan);
- routes added or changed, and the client files that call them;
- tables written and read, scheduler jobs added, env flags read, migrations.

## Step 2: intake verdict (one agent, medium effort, up to 3 cards per agent)

The agent reads the card(s) and answers, with a grep or command behind every line:
1. **Upstream:** does the new code use the canonical producers (one number, one producer), or did it compute its own copy of something that exists?
2. **Downstream:** is every caller of every changed symbol still correct? Did any consumer get left on the old behaviour?
3. **Reach:** does the new output reach a page Nick uses (route → client file → page)? Does the page's text still describe what the code does?
4. **Links:** who else should consume this output and doesn't yet (A should feed B)? Any duplicate it now makes redundant (remove one of two Bs)?
5. **Plan:** does it close a plan item's bar, unblock or obsolete a queued unit, or change another unit's acceptance test?
6. **Follow-ups:** each needed change becomes a unit `INT-<pr>-<n>` (one PR, files, acceptance test), added to the queue and the board.

The verdict replaces `_pending_` in the card. Units go into `WORK-QUEUE.md` section 7 and onto the plan board. Plan-item status changes go onto the board.

## Step 3: synergy review (about every 5 merges)

`~/gridiron-local/wf/synergy-review.js` looks across all cards since the last review: cross-cutting links, duplicates, and stale older work. Its verified proposals become units the same way.

## Why this shape

- The script makes the expensive part (grepping callers and routes across ~900 files) free and repeatable.
- The agent sees only the card plus targeted greps, not the whole thread history.
- Everything lands in the handoff folder, so a new session picks up the integration state without re-deriving it.
