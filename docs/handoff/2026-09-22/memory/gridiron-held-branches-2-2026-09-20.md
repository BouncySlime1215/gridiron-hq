---
name: gridiron-held-branches-2-2026-09-20
description: Page 2 of the no-PR "-hold" branch ledger for the 2026-09-20 GitHub freeze; rows that did not fit on page 1, the 03:14Z ancestor verification per row, PR heads, and the per-thread detail links.
metadata:
  type: project
---

Continues [[gridiron-held-branches-2026-09-20]] (same rule: verify each row with `git merge-base --is-ancestor <recorded-head> <hold-branch-head>` before the morning fast-forward).

| thread | hold branch | head | fast-forwards onto | status |
|---|---|---|---|---|
| Fantasy plan (outlook fit) | claude/project-thread-f921do-outlook-fit-hold | f852e88 (docs atop; code verified at e76357b, RED c5ee2a1; 3,018/0/41, check exit 0) | ff onto #42 d68a5f3 (verified 03:14Z); migration 065 + outlook fit store + fitter script; NO consumer wired yet (page 19) | verified by thread 02:58Z |
| UI (teams page) | claude/project-thread-xiezr0-teams-basis-hold | deb492a (ls-remote verified 03:2xZ; on adopt-chip 4536340) | teams page: both prose cards carry the assumed chip, TBD coaching slots render as absence; four mutations caught | typecheck/lint clean, 3,123 tests 3,082 pass 0 fail 41 skipped, build + start:smoke clean (03:08Z) |
| Chat sync | claude/project-thread-sytruo-asof-hold | f2f321b (06:39Z; was 6ceb5c7; page 7) | #47 (off #47's head 4c624ac); archetype as-of block, three stamps, manager-archetypes.js only, reaches the card via routes/trades.js (page 24/27) | ten mutations caught (03:16Z) |
| Feature audit (trade week) | claude/project-thread-5f9c3y-trade-week-hold | eb55f1d (one commit on #57's head 7c27517) | #57 at the go; pin for selfScout week (trade-engine.js:2591, client MyTeam.tsx:233 `scout?.week ?? 1`): test/self-scout-serves-the-week.test.js 5 tests on served JSON; four injections APPLIED, each 1 pass 4 fail; no server code changed; go-list unchanged | 2,978 tests 2,937 pass 0 fail 41 skipped, check + start:smoke exit 0 (03:11Z) |
| Fantasy plan (odds calibration) | odds-calibration-hold (f921do; short name as reported 03:15Z) | 8b8e7e8 (3,025/0/41, check exit 0) | stacked on the fit store; season-sim.js untouched, no consumer; gate NOT shipped, Nick's word (page 26) | 03:15Z |
| Fantasy plan (season list) | season-list-hold (f921do; short name as reported 03:15Z) | 4202fd0 | #66 e87a3ca (#66's coreLag paragraph; body edit deferred to the go) | 03:15Z |

Verification 03:14Z (Opportunity, read-only; merge-base --is-ancestor, refs/pull heads authoritative; every hold has merge-base 791b131 with origin/main, none needs a base merge). CAUTIONS FIRST: * Fantasy plan coordinator-head-hold 8875c9b is NOT a fast-forward onto #42 (forks from main 791b131 directly; #42 has ten commits it lacks, ce3d11d..d68a5f3); it is the base of the NEW PR §10a names; never list it under "ff onto #42". * UI adopt-chip 4536340 onto #78 7b5753a YES but +46 commits (it merged #43 #46 #53 #57 #58 #60 in; fast-forwarding #78 to it would pull those PRs' commits into #78's diff; UI agreed 03:2xZ: ONE new PR from title-drill d1cc317, page 4). True ancestors: Release e6b6785 onto #35 a60858d YES +16; Opportunity ffe8363 onto #72 a6975b8 YES +2; Google sign-in f288898 onto #71 8b1a036 YES +3; Wiring map usage-coverage 2626712 new PR, carries #66 e87a3ca, YES +1; Wiring map route-gate aede8b3 onto #36 252c896 YES +5; Trade Brain 21b449a onto #41 45323ce YES +5; Scheduler bec666d new PR on #77 3902ba7 YES +4; Audit 813d084 onto #68 aac5c75 YES +2; Fantasy plan outlook-fit-hold f852e88 onto #42 d68a5f3 YES +3 (different shape from coordinator-head-hold; keep separate). PR heads at 03:14Z: #35 a60858d, #36 252c896, #41 45323ce, #42 d68a5f3, #66 e87a3ca, #68 aac5c75, #71 8b1a036, #72 a6975b8, #77 3902ba7, #78 7b5753a.

Continues (rows updated 03:15Z+, detail links): [[gridiron-held-branches-3-2026-09-20]].
