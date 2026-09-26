---
name: gridiron-held-branches-2026-09-20
description: The single list of no-PR "-hold" branches pushed during the 2026-09-20 GitHub freeze, each with its PR target and head, to fast-forward when Nick says go.
metadata:
  type: project
  modified: 2026-09-22T02:05:26.449Z
---

Freeze 01:58Z 2026-09-20: no pushes to PR branches, no new PRs, no comments. Work preserved on -hold branches with no PR. On Nick's go, fast-forward each PR branch to the hold head, then delete the hold branch only on coordinator word. Before the morning fast-forward, verify each row with `git merge-base --is-ancestor <recorded-head> <hold-branch-head>`: a content-identical commit that is not an ancestor passes cat-file and ls-remote and still breaks the fast-forward (wiring map, 03:01Z).

| thread | hold branch | head | fast-forwards onto | status |
|---|---|---|---|---|
| Release | claude/release-train-2yv3x6-hold | c117daa (06:06Z; was e6b6785) | #35 (a60858d), clean ff, ancestor confirmed 06:10Z | COMPLETE; item 8 = registry job (page 4) |
| Opportunity | claude/project-thread-w45mur-cascade-grade-hold | ffe8363 | #72 (a6975b8; PR branch now TWO commits behind: 7dd4690 mutation verification + ffe8363 retraction; push both before anyone reads #72's diff against its body) | verified vs remote 03:09Z; #72 a6975b8, #15 31f841f |
| Google sign-in | claude/project-thread-n4052e-league-sync-creds-hold | c986b80 (07:03Z; was f288898; page 8) | #71 (8b1a036; docs-only correction + callback comment, no behaviour change) | 2,976/0/41, check exit 0 (03:09Z) |
| Feature audit | claude/project-thread-5f9c3y-{55,62,64,74}-hold (page 3) | FINAL go-list: #55 d3eb62d → 9d44431 (1 commit, 2914/2955); #62 25d911c → b61b557 (3, 2923/2964); #64 7eb5118 → 1b66a80 (1, 2926/2967); #74 6457d97 → b5f3996 (2, 2923/2964, tradelab:154 guard); #57 7c27517 and #67 305c612 final on origin. Order #57 → #64; #62 → #67 | #62 #64 #55 #74 | final 02:45Z; ls-remote 03:17Z |
| Wiring map | claude/wiring-map-8f96ur-usage-coverage-hold | 2626712 SUPERSEDED (07:53Z, p13) | new PR after the go (off main, carries #66 e87a3ca by merge, nflverse.js untouched) | verified by thread 02:27Z |
| Wiring map (#36) | claude/wiring-map-8f96ur-route-gate-hold | caac88a (07:12Z; was 807ef47; page 9) | #36 (252c896); the ONLY #36 target (page 22) | verified 06:10Z |
| UI * | claude/project-thread-xiezr0-adopt-chip-hold | 4536340 (3,118/0/41) | base of the UI stack (ledger page 4): ONE new PR from title-drill d1cc317 after #43 #46 #53 #57 #58 #60 #78 merge lands all three; step 4 chip on six surfaces (page 20) | verified 06:10Z |
| Trade Brain | claude/project-thread-3xqh5l-accessor-hold | f4aadf0 (06:36Z; was e51f23f; page 6) | #41 (remote 45323ce; a066001 02:11:38Z and 45323ce 02:22:03Z pushed after freeze); + as-of block (page 22) | verified by thread 03:02Z |
| Scheduler | claude/project-thread-o3wt2p-growth-offthread-hold | 8709ec6 (06:33Z; was 3d4ca74; page 6) | CORRECTED: "report the sweep that paused, and drop what nothing reads" (base #77 3902ba7) — NOT live-tier, no migration 066 | verified 06:10Z |
| Audit | claude/project-thread-w0gpjt-hold | ef7244f (06:36Z; was a891ae4; page 6) | #68 (aac5c75; 6a899da 02:14:06Z and aac5c75 02:28:17Z pushed after freeze); ff at the go; + promotion consumer check (page 21) | verified 06:10Z |
| Fantasy plan * | claude/project-thread-f921do-coordinator-head-hold | 8875c9b (NOT a ff onto #42; forks from main 791b131) (docs atop; code verified at 42bbbc3, RED dce4665, base 791b131) | new PR after the go (the :571 half of F1); #42 d68a5f3 pushed 02:24Z crossing | verified by release 02:43Z (grep 3); named in §10a |

Verified 03:14Z and again 06:10Z by Opportunity (13 rows, all clean ff, all merge-base 791b131); * rows: coordinator-head-hold = NEW PR off main, not a ff onto #42; UI three holds = one linear stack, ONE new PR. More rows, PR heads, links: [[gridiron-held-branches-2-2026-09-20]].

**Correction 2026-09-22:** 8709ec6 alone doesn't add migration 066 (9c7cf68 does, in its ancestry); neither is live-tier (that's a9511f6/3902ba7 → 3ef535b on 654ff93, unpushed). PR #84 (head 8709ec6) DOES carry 066 via 9c7cf68 in its 7-commit stack — #84 stays off any deploy branch.
