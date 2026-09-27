---
name: gridiron-phase-a-0502-2026-09-22
description: Detail for 04:47-05:02Z cycle, part 1 (six pushes: R&D integration nflsavant kill, Fantasy plan ICC, Model evidence audit win-rate correction + canonical ceiling). Part 2: [[gridiron-phase-a-0502-b-2026-09-22]].
metadata:
  type: project
  modified: 2026-09-22T05:04:23.185Z
---

**SIX PUSHES this cycle**, all under 2x-check push-delegation rule, none opened as PRs (pending Nick's word).

**R&D integration**: pushed 13 commits to `claude/project-thread-2oztzw` (route-splits table+loader+feature-store wiring, red-zone TD-pricing fix, comment fix). Full check green (3009/2968/0-fail). Then measured nflsavant vs nflverse for route-splits source and KILLED the nflsavant sync: nflverse's participation file strictly dominates (500 receivers vs 106, 78% more labelled routes, 99.9% coverage-shell coverage vs sparse). Updated its own intake gate (docs/RD-HANDOFF-CONTRACT.md) to require checking existing sources before syncing a new one — this is how the gap happened. nflsavant code stays but is never called.

**Fantasy plan**: pushed twice — effk branch now at 9e2f079, both the ESPN waiver/FAAB/trade-deadline field fix (ccca336) AND a new ICC (intraclass correlation) field added to shrinkage-fit.js's fitK() (RED 014441e/GREEN 9e2f079, full check +6/+6/0/0 vs baseline). Next: fuller persisted reliability table + fitting job + backtest ablation gate (R&D's original ask, scoped separately from the one-line ICC change).

**Model evidence audit**: pushed 22 commits to `claude/project-thread-w0gpjt` at c58c20e1. Caught+fixed a stale section of docs/spec/projection-range.md BEFORE pushing (an already-retracted win-rate table that would've gone out fetchable/quotable w/ a commit hash). Corrected win-rate curve for UI: on full enumerated universe restricted to startable pairs (both proj ≥8.0), TIE_THRESHOLD 1.5 holds (52.9%), CLEAR_THRESHOLD 4.0 buys 72.6% (not 72.8%), 80% call needs ~7.15pts (not 6.0); no threshold reaches "near-certain" (85% needs 9.57, covers 0.04% of real decisions). Recommends showing measured win rate rather than a relabeled threshold. Also found+escalated a possible live prod bug (part 2).

**CANONICAL CEILING** (coordinator decl.): Model evidence audit's number — 2018-2025, 24,801 player-weeks, model R2 0.3186 vs oracle 0.3223 = 98.9% — is canonical for citing "the ceiling" project-wide. R&D's separate number (2022-2025, 10,755 player-weeks) stands on its own sample, not to be conflated.
