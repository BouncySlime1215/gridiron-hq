---
name: "gridiron-token-efficiency"
description: "Load at the start of every Gridiron HQ thread or coordinator turn: spend rules that keep the weekly usage cap intact without losing accuracy."
---

# Gridiron HQ token efficiency

Usage monitoring is Nick's #1 priority (2026-09-22 18:16Z). Spend is almost entirely context re-reads (99% cache hit, 92.8B tokens over 25 threads in one week), so every rule below cuts re-reads, not rigour.

## 1. Start cold, from the handoff
1. Read `/mnt/project-files/handoff/<thread>-<date>.md`, then `MEMORY.md`, then the merge-gate skill. Nothing else until a task needs it.
2. Do not re-read thread history, old state files, or PR bodies you already summarised. If a fact is not in the handoff it is worth one targeted fetch, not a scroll.
3. When your PRs land, write the handoff and stop. The coordinator restarts you as a fresh session. Never continue a session past its handoff.

## 2. One run, one read
- One guard run per tree (`npm run check`). Re-run only if `git write-tree` moved.
- Read a CI result once, when it finishes. No polling: minimum ten minutes between re-checks, prefer `git ls-remote` over REST.
- Never re-run a RED that already failed on the same assertion and tree.
- Cache what you computed in the scratchpad or handoff; do not recompute a count in a later turn.

## 3. Report by milestone
- One reply per milestone (draft up, gate green, blocker, decision). Progress goes in the status checklist.
- Reports are numbers and file:line, not narrative. Under 15 lines or it is a file.
- Do not repeat what the coordinator already knows; say what changed.

## 4. Right-size the work
- Workers for reads and runs; keep the thread's own context for decisions.
- Docs-only and ledger work may run on Sonnet 5 when Nick has allowed it; model, projection, trade, lineup work stays on the model Nick named.
- Five continuing threads maximum. A new unit needs a free slot, not a new thread.

## 5. Measure it
- Coordinator keeps `/mnt/project-files/USAGE-LEDGER.md`: each reading Nick pastes (weekly % used, reset time), burn rate, runway in days at current pace.
- Every 30-min post opens with the usage line.
- If runway is under the days to the reset, the coordinator cuts thread count first, then model tier, and tells Nick which.

## 6. Keep improving
- Any procedure repeated twice becomes a skill or a script. Propose the skill the same day; do not wait for a third repeat.
- When a rule here costs accuracy, say so and break it; then record why.