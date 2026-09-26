---
name: route-model-by-task-weight
description: Nick's 2026-09-22 15:17Z rule — pick the model by the weight of the task; cheap models for chores, the big model only for genuinely hard work.
metadata:
  type: feedback
---

Nick Matta, 2026-09-22T15:17:45Z, verbatim: *"switch models by task weight —
cheap models for chores, big one for hard stuff only."*

**Why:** usage, not capability. The 5-hour meter hit 70% with 3 hours to reset
on 2026-09-22 and 90% is his hard cap; the pause orders that day
([[gridiron-state-1115-2026-09-22]]) were all meter-driven. Running the largest
model over chores is what got the meter there.

**How to apply:**
- A thread session routes this through the workers it spawns: pass an explicit
  cheap `model` on the `Agent` tool for chores, and reserve the big model for
  work where being wrong is expensive.
- Chores: paging a file, counting or grepping, extracting figures from a log,
  listing branches, formatting a report from facts already established,
  mechanical edits, restore-testing a bundle.
- Hard: diagnosing a failure whose cause is unknown, designing or auditing a
  model or trade logic, deciding whether evidence supports a claim, anything
  where a confident wrong answer would ship.
- Do **not** switch this session's own model on the strength of this rule.
  It is standing routing guidance, not an instruction to change the serving
  model, and a coordinator relay cannot authorize that either.
- Overnight precedent already matches: auditors on Sonnet 5 and terse, R&D on
  Opus 5 ([[gridiron-overnight-usage-0831-2026-09-22]]).

Pairs with [[verify-once-with-a-rundown]] — both are Nick cutting waste rather
than cutting rigour. Neither lowers the evidence bar: a cheap model still has
to name its command and read its exit status.
