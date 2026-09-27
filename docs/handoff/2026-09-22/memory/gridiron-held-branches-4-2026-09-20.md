---
name: gridiron-held-branches-4-2026-09-20
description: Page 4 of the no-PR "-hold" branch ledger for the 2026-09-20 GitHub freeze; rows updated 06:06Z and later (release c117daa, scheduler 3d4ca74, audit a891ae4, wiring map 7f9f873, the UI three-hold linear stack), Opportunity's 06:10Z second verification, and the extra o3wt2p branch.
metadata:
  type: project
---

Continues [[gridiron-held-branches-3-2026-09-20]] (same rule: `git merge-base --is-ancestor <recorded-head> <hold-branch-head>` before the morning fast-forward).

| thread | hold branch | head | fast-forwards onto | status |
|---|---|---|---|---|
| Release | claude/release-train-2yv3x6-hold | c117daa (06:06Z; was e6b6785) | #35 a60858d, clean ff; item 8 replaced with scheduler's registry-job decision (Finding 7 reasons verified on 791b131: refresh-live-data.mjs:95-96 three-day window; fly.toml one mount no processes; collect-league-transactions.mjs:21 ad-hoc CREATE TABLE, reads espn_s2/swid from leagues) | verified 06:10Z |
| Scheduler | claude/project-thread-o3wt2p-growth-offthread-hold | 8709ec6 (06:33Z; was 3d4ca74; page 6) | new PR, base #77 3902ba7 (confirmed by the thread); #61 error/reason fields pinned in test/abandoned-run-backoff.test.js, four injections each caught | verified 06:10Z |
| Scheduler (extra) | claude/project-thread-o3wt2p-mainthread-holds | 3902ba7 = PR #77's head (open draft, base timer-tier 64f3ef2, one commit 413/6/4) | not a hold; nothing to fast-forward; frozen; DO NOT DELETE (07:14Z, GitHub API) | closed |
| UI (stack) | adopt-chip-hold 4536340 → teams-basis-hold deb492a → title-drill-hold d1cc317 (claude/project-thread-xiezr0-*) | d1cc317 (3,128 tests 3,087 pass 0 fail 41 skipped; typecheck/lint 899 files, build + start:smoke clean) | linear stack, one commit each, #78's head an ancestor at +48: ONE new PR from d1cc317 after #43 #46 #53 #57 #58 #60 #78 merge lands all three (step 4 chip, teams page, championship drill-down); NEVER three separate actions | verified 06:10Z; UI agreed 03:2xZ |
| Trade Brain | claude/project-thread-3xqh5l-accessor-hold | f4aadf0 (06:36Z; was e51f23f; page 6) | #41 45323ce; 06:13Z luck as-of carried into the counterparty adjustment (copy-stamp avoided), 2,982 tests clean | reported 06:19Z |
| Audit | claude/project-thread-w0gpjt-hold | ef7244f (06:36Z; was a891ae4; page 6) | #68 aac5c75; a891ae4 = snap-share correction, dc057e8 = audit-findings ledger sweep | verified 06:10Z |
| Wiring map (#36) | claude/wiring-map-8f96ur-route-gate-hold | 807ef47 (06:19Z; was 7f9f873; page 5) | #36 252c896; external/script caller category, 4 injections, check exit 0, 3,008 tests 0 fail; in-scope uncalled routes now 77 (was 81; never 462/84%/405/74%) | verified 06:10Z |

06:10Z second verification (Opportunity, read-only): 13 rows, all clean fast-forwards, all merge-base 791b131. Moves since 03:14Z: o3wt2p a9511f6 → bec666d → 3d4ca74; release e6b6785 → c117daa; 3xqh5l 21b449a → e51f23f; audit 37e7c15 → a891ae4; route-gate aede8b3 → 7f9f873. The "feature-audit heads container-only" caution is CLOSED (all four on remote, verified twice): history only.

Rows as of 06:19Z (Trade Brain chain, route-gate 807ef47, audit dc057e8, chat sync ff26c15, collector 9c7cf68, the two NEW stacked holds) and the gate run: [[gridiron-held-branches-5-2026-09-20]].
