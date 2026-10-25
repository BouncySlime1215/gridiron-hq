---
name: gridiron-phase-transition-plan-no-stop-rule
description: At every phase boundary (Foundation/0 -> A -> B -> C -> D), post Nick a synthesized plan for the next phase, but do not pause for his reply before continuing the work.
metadata:
  type: feedback
  modified: 2026-09-22T03:29:21.492Z
---

**Nick's words, 2026-09-22T03:28:38Z**
(cmsg_01YAsw8AnFv4ioRMQw8dfPmTDGjnLfcy54XP63pupq9ZSX), verbatim, typos kept:

> "after one phase going to the next u need to gimme a plan - synthsized from
> the docs and then ill let you know but dont top after each just keep going"

**Plainly:** at every phase transition — Foundation/Phase 0 -> A -> B -> C -> D,
per PLAN UPDATE v2 — the coordinator posts Nick a plan for the upcoming phase,
synthesized from the governing docs (the plan v2 messages). He may respond
whenever he gets to it. The coordinator does **not** wait for that response
before moving on. Threads keep going into the next phase's work regardless;
the posted plan is for his visibility, not a go/no-go gate.

**How to apply:**
1. When a phase closes out (e.g. Phase 0's items all DONE/CLOSED), before or
   as work starts on the next phase, write a short plan for that next phase —
   what its items are, drawn from the plan v2 docs — and send it to Nick.
2. Immediately after sending it, proceed with briefing/starting that next
   phase's work. Do not block on a reply. Do not treat silence, or a delayed
   reply, as a reason threads should have paused.
3. This repeats at each boundary: 0->A, A->B, B->C, C->D.

**Why this is a distinct rule, not a relaxation of the hard rule:** the
existing HARD RULE — that destructive/outward GitHub actions (push, PR,
merge, deploy, settings/secrets changes) need Nick's own explicit words
answering that specific action first — is UNCHANGED and still stops the
thread until that confirmation arrives. See
[[check-the-authorisation-not-just-the-plan]] for why even a "go" must be
checked against what it was actually answering, and
[[threads-report-to-coordinator]] for the routing rule this plan-posting
fits inside (thread -> coordinator -> Nick, one voice, one queue).

This 2026-09-22 03:28Z instruction is about ordinary phase-to-phase planning
communication only: it says keep moving, post the plan as you go, don't stop
to wait for a reply on the plan itself. It says nothing about, and does not
loosen, the confirmation requirement for destructive/outward actions. A
future reader should not read "don't stop after each phase" as license to
skip the authorization check on an irreversible action inside that phase —
those are two separate gates, and only one of them was ever optional.
