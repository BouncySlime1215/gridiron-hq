---
name: gridiron-plan-items-1-25-verbatim-part3
description: "VERBATIM PART 5 list (Nick's approved plan items), part 3 of 3: Phase D items 21-25, the four GLOBAL RULES, the NOT APPROVED line and the execution-order line; parts 1-2 hold items 1-20"
metadata:
  type: project
---

Source: PART 5 — Nick's approved additions, cmsg_01YAsw8AnFv4ioRMQw8dfPmTRwtoUfvgWYLwXAcxCgATNx, 2026-09-21T19:58:42Z. Verbatim, typos kept. Also at /mnt/project-files/PLAN-ITEMS-1-25.md.

Part 1 [[gridiron-plan-items-1-25-verbatim-part1]]; part 2 [[gridiron-plan-items-1-25-verbatim-part2]].

**PHASE D — ROBUSTNESS & STRATEGY**
21. PIPELINE FRAGILITY FIX (Nick: yes, we need a fix). ESPN changes, cookies expire, scrapers break at 2 AM. Monitoring with alerts, graceful degradation per source, automatic fallback ordering. Nothing rots silently ever again.
22. ONE-LEAGUE OVERFITTING FIX (Nick: ofc). Per-league models on global priors — hierarchical. A new user's league starts smart from global patterns and gets sharper as their data accumulates. Nothing that only works in Nick's league ships as a general feature.
23. DESKTOP + MOBILE (Nick: both). Full parity. Sunday morning with bad data on a phone is the primary battlefield — design for it first, desktop second, but both complete.
24. COMPETITIVE TEARDOWN (Nick: ofc). FantasyPros, 4for4, Establish The Run, FantasyPoints, ESPN/Sleeper built-ins: pricing, strengths, and the verified wedge. Our wedge is "we show our work and learn weekly" — verify nobody else can honestly claim it.
25. KILL LIST (Nick: agree — carefully insane). Standing composer authority to DELETE: dead features, decoration metrics, vibe-producing threads. Cutting is half the job. Careful = everything cut gets a one-line obituary (what it was, why it died, what replaced it) so nothing gets re-built blindly.

GLOBAL RULES FOR EVERY BRANCH: Make each one INSANE, best-in-class or don't ship. NO ASSUMPTIONS, everything measured or explicitly labeled as a guess, Tested-or-Guessing on every number. GET CREATIVE, if the standard approach is weak invent a better one then prove it with data. SCHOLARLY GROUNDING FIRST before executing EACH branch.
NOT APPROVED — DO NOT BUILD: multi-platform league import, offseason product, monetization model, banning narrative features.
Execute Phase A → B → C → D in order. Within a phase, parallelize where threads don't touch.
