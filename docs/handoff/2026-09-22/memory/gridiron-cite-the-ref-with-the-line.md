---
name: gridiron-cite-the-ref-with-the-line
description: Gridiron HQ threads work on ~26 parallel branches, so a bare file:line in a handoff between sessions is wrong more often than right — four times on 2026-09-19 alone.
metadata:
  type: feedback
  modified: 2026-09-19T21:15:50.971Z
---

**Every code citation between threads must name the ref, not just the line.**

Four handoffs on 2026-09-19 carried a wrong line number, each correct for the
tree its author had read:

- `contingency.js` `:117` / `:835` / `:836` — the same position filter, cited
  three ways by three threads.
- `season-sim.js` `:92` / `:105` — the same slot skip.
- `trade-engine.js` `:181` / `:346` — the same `?? 0.92`.
- `trade-engine.js` `:49` / `:123` — the same comment above `SCORED`.

**Why:** ~26 branches are open at once and most threads read their own. A
receiving session that trusts a bare line either reads unrelated code and
concludes nothing is there, or reads the right code and doubts the sender.

**How to apply:** cite as `path:line (branch or PR)`. When you receive a bare
line, grep for the symbol rather than seeking to the number, and say which tree
you read when you answer. `scripts/wiring-map.mjs` prints this as a limit on
every run; it is really a project convention, not a tool detail.

## The other half of the same lesson
**Verify before relaying, and relay what you verified.** Twice that day a
session's tool was right and its prose was wrong (`manager_archetypes`'s writer;
`season-sim.js:226` reported as a live K/DEF defect when the roster is filtered
25 lines earlier). Both were caught by the thread that owned the code, not by
the author. A finding is a lead to read, never a fact to pass on.

**And some categories must never become a check.** `PLAYOFF_WEEKS` (a wrong
default the league payload could answer) and `SCORED` (a deliberate modelling
scope with its reason in a comment above it) are the same shape to any static
tool and opposite verdicts. A rule that cannot read the comment files the
correct decision as a defect, and the cost is the tool's credibility rather than
a wasted minute. Leave that category to people, on purpose, and say so.

See [[gridiron-wiring-map]] and [[gridiron-availability-constant-0-92]].
