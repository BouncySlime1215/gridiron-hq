---
name: "gridiron-token-efficiency"
description: "Load at the start of every Gridiron HQ thread or coordinator turn: spend rules that keep the weekly usage cap intact without losing accuracy."
---

> ARCHIVED 2026-09-23 5:25 PM ET: superseded by docs/handoff/local/RULES.md. Does not bind.

# Gridiron HQ token efficiency

Usage monitoring is Nick's #1 priority (2026-09-22 18:16Z). Spend is almost entirely context re-reads (99% cache hit, 92.8B tokens over 25 threads in one week), so every rule below cuts re-reads, not rigour.

## 1. Start cold, from the handoff
1. Read `~/gridiron-local/wt/handoff/docs/handoff/local/PASTE-TO-RESUME.md`, then `MEMORY.md`, then the merge-gate skill. Nothing else until a task needs it.
2. Do not re-read thread history, old state files, or PR bodies you already summarised. If a fact is not in the handoff it is worth one targeted fetch, not a scroll.
3. When your PRs land, write the handoff and stop. The coordinator restarts you as a fresh session. Never continue a session past its handoff.

## 2. One run, one read
- The guard run is CI on Node 22 on the exact head; locally run only the unit's targeted tests, and re-run only if `git write-tree` moved.
- Read a CI result once, when it finishes. No polling: minimum ten minutes between re-checks, prefer `git ls-remote` over REST.
- Never re-run a RED that already failed on the same assertion and tree.
- Cache what you computed in the scratchpad or handoff; do not recompute a count in a later turn.

## 3. Report by milestone
- One reply per milestone (draft up, gate green, blocker, decision). Progress goes in the status checklist.
- Reports are numbers and file:line, not narrative; anything longer than a screen goes in a file.
- Do not repeat what the coordinator already knows; say what changed.

## 4. Right-size the work
- Workers for reads and runs; keep the thread's own context for decisions.
- Docs-only and ledger work may run on Sonnet 5 when Nick has allowed it; model, projection, trade, lineup work stays on the model Nick named.
- Three build loops plus one R&D loop at a time (paced by `~/gridiron-local/bin/capacity.py`). A new unit needs a free slot, not a new loop.

## 5. Measure it
- Coordinator keeps `~/gridiron-local/wt/handoff/docs/handoff/local/METER-LOG.md`: each `get_usage` reading (5-hour and weekly %, reset times), burn rate, runway at current pace.
- Every 20-minute status opens with the usage line.
- If runway is under the days to the reset, the coordinator cuts thread count first, then model tier, and tells Nick which.

## 6. Keep improving
- Any procedure repeated twice becomes a skill or a script. Propose the skill the same day; do not wait for a third repeat.
- When a rule here costs accuracy, say so and break it; then record why.