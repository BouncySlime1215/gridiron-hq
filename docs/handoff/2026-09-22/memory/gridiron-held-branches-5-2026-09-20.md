---
name: gridiron-held-branches-5-2026-09-20
description: Page 5 of the no-PR "-hold" branch ledger for the 2026-09-20 GitHub freeze; heads as of 06:31Z (Trade Brain f4aadf0, route-gate b4b67ab, audit ef7244f, chat sync f2f321b, collector 9c7cf68), two NEW stacked holds (odds-gate 99c198a, roster-read d38f676), the Coach hold fc1426b, and the wiring map's gate run over every hold.
metadata:
  type: project
---

Continues [[gridiron-held-branches-4-2026-09-20]] (same rule: `git merge-base --is-ancestor <recorded-head> <hold-branch-head>` before the morning fast-forward). Heads below are as reported by each thread at 06:19Z, not yet re-verified by Opportunity.

| thread | hold branch | head | fast-forwards onto | note |
|---|---|---|---|---|
| Trade Brain | claude/project-thread-3xqh5l-accessor-hold | f4aadf0 (06:36Z; page 6; chain e51f23f → 56a02f1 → eaa91ef → 251f266 → 41fb2af → f4aadf0) | #41 45323ce | eaa91ef: luck as-of into the counterparty adjustment, copy-stamp avoided, 2,982 tests; 251f266 (RED 2af8721): Part 4 archetypeIndex defect, 2,983 tests, 3 injections caught; 41fb2af: switch note in the evidence file. Switches to archetypesBuilt only at merge (symbol absent on its base); field priced_as_of, never as_of |
| Wiring map (#36) | claude/wiring-map-8f96ur-route-gate-hold | caac88a (07:12Z; page 9; was b4b67ab) | #36 252c896 | 807ef47 was the gate-run map version; b4b67ab: fork/Worker/spawn/execFile-by-URL + npm scripts as roots, four orphan rows retracted, 80 in-scope uncalled routes, gate clean 60/60 |
| Audit | claude/project-thread-w0gpjt-hold | ef7244f (06:36Z; page 6) | #68 aac5c75 | a891ae4 = snap-share correction; dc057e8 = audit-findings ledger sweep, docs/evidence/2026-09-20/AUDIT-FINDINGS-LEDGER.md; fbfb39d = A8 closed, A12 sharper, D29 new, check clean |
| Chat sync | claude/project-thread-sytruo-asof-hold | f2f321b (06:39Z; page 7) | #47 4c624ac | shared accessor archetypesBuilt (Trade Brain and Coach read through it) |
| Scheduler | claude/project-thread-o3wt2p-growth-offthread-hold | 8709ec6 (06:33Z; page 6) | new PR on #77 3902ba7 | collector job: migration 066, JOBS.league_transactions metered 30 min offThread (Finding 7 fix) |
| Fantasy plan (NEW) | claude/project-thread-f921do-odds-gate-hold | 99c198a | stacked on odds-calibration-hold 8b8e7e8; new PR in the stack after odds-calibration | odds gate; NOT shipped, Nick's word |
| Feature audit (NEW) | claude/project-thread-5f9c3y-roster-read-hold | 9fc851e (p9) | stacked on trade-week-hold eb55f1d; onto #57 after trade-week | routes/trades.js:161 three-state roster read |
| Coach (NEW) | claude/coach-grounded-4l8hno-hold | fc1426b → 73e0760 (07:33Z, p11) | new PR off main after the go | full check exit 0, 2,980 tests / 2,939 pass / 0 fail, npm ci first; 31 mutations applied and killed across three slices |
| UI (NEW) | claude/project-thread-xiezr0-odds-gate-hold | 22b2cb9 | stacked on the UI chain, same ONE-PR route | odds-gate UI state, inert until the payload appears; 3,138/3,097/0; 15+2 mutations red; docs/tdd/odds-gate.tdd.md |

claude/project-thread-o3wt2p-mainthread-holds is PR #77's own head branch (3902ba7), not a hold pointer; the freeze applies to it.

**Gate run (wiring map, 06:16Z; /mnt/project-files/gate-run-hold-branches.md):** map 807ef47 copied into all 19 trees, baseline main 791b131 (2,141 findings), betting excluded. Seven clean (release-train, route-gate, audit, coordinator-head, #62, #64, #74); 13 build-failing across six branches (cascade-grade 1, title-drill 1, growth-offthread 1, outlook-fit 4, odds-calibration 5, #55 1). One NEW merge collision: league-sync-creds f288898 × growth-offthread on test/league-roster-schedule.test.js (ec0739e credentials assertion vs bec666d off-thread test shape); scheduler reconciles. Stale heads at run time (accessor, route-gate) corrected on pages 1, 3, 4.

Rows from 06:32Z (audit ef7244f, scheduler 8709ec6, fantasy plan outlook-consumer d61db0a): [[gridiron-held-branches-6-2026-09-20]].
