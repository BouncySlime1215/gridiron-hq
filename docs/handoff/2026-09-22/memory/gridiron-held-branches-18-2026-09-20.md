---
name: gridiron-held-branches-18-2026-09-20
description: Page 18 of the no-PR "-hold" branch ledger for the 2026-09-20 GitHub freeze; heads from 11:20Z on (fantasy plan memo-key 00b4c28, snap-guard assertion note, Google sign-in 511eed8, scheduler 89cdb3a, feature audit season-weeks b048c86 and the unpushed inbox-stop hold).
metadata:
  type: project
---

Continues [[gridiron-held-branches-17-2026-09-20]]. Merge order: /mnt/project-files/hold-branch-sweep-2026-09-20T1115Z.md (the ONE source until the go sweep).

| Thread | Branch | Head | Lands how | Notes |
|---|---|---|---|---|
| Fantasy plan | claude/project-thread-f921do-memo-key-hold | 00b4c28 (11:20Z; 0b26f20 = merge of e53ff1a, 00b4c28 = the swap; was 761af34, 9fce773) | ONE PR from this head for the avail-basis/memo-key pair, after Opportunity's wiring-names PR; moves once more after the `unvouched` merge (11:27Z) | 2,979 / 2,938 / 0 / 41 on the exact tree; ancestry e53ff1a / 9732f83 / 761af34 / a7ac178 confirmed; DEFAULT_ACTIVE_PROBABILITY swap done, test pins the import LINE (both constants 0.92, failure mode 116); WIDENED: a present row with no number was served the default under its own basis → now basis `unrecognised` + source (to become `unvouched`, Opportunity's third consumer arm); evidence docs/tdd/availability-uncovered-constant.tdd.md (re-aimed row 6/6, base 9c639848757d); memo-fit full-check line stale (2,966), refresh with hash next commit |
| Fantasy plan | claude/project-thread-f921do-snap-guard-hold | 3f9c048 (off main) | new PR off main | docs/tdd/snap-share-ingest.tdd.md, 9 tests in test/snap-share-ingest.test.js; TABLE = ASSERTION until re-run with hashes (predates the hash column; S4's pattern matched twice, failure mode 114); re-run before the go; Model audit does not grade it yet |
| Google sign-in (#71) | claude/project-thread-n4052e-league-sync-creds-hold | 1e8dddd → a2e7f97 (11:41Z, p20) | #71 8b1a036, ff | §6 states the check on 1171d66: 2,985 / 2,944 / 0 / 41, re-measured at c986b80 and da8ec48; carries the part-5 clause (a figure names the commit it was measured on, the parent of the commit printing it); body still /mnt/project-files/pr-71-body-da8ec48.md until re-cut; outlook patch re-cut pending (§7 amended) |
| Scheduler | claude/project-thread-o3wt2p-merge-resolutions-hold | 64cb90e (11:32Z; docs-only over e852884; was 89cdb3a) | apply after #71 and #50 merge; not a ff onto either | 89cdb3a: eight per-version hashes re-derived from the repo + full-check line 3,054 / 3,013 / 0 / 41 measured on e852884; 64cb90e: both injections quoted as exact before/after text from a re-applied clean checkout (A comment at index.js:10 → cba65447, B duplicate registration at :87 → 63084efe); nothing owed |
| Feature audit (NEW) | claude/project-thread-5f9c3y-season-weeks-hold | b048c86 (11:26Z; pushed) | STACKED on 64-hold 1b66a80; new PR after #64 | D11: season_delta_weeks (int), season_delta_basis ('weeks_remaining' | 'full_season_default') per side; seasonWeeksLeft(lg, week) exported; 2,972 / 2,931 / 0 / 41; printers TradeCard.tsx:109 (UI) and trades.js:929 (Trade Brain) told 11:29Z |
| Feature audit (NEW) | claude/project-thread-5f9c3y-inbox-stop-hold | afeee33 → b104fab PUSHED (11:46Z, p21) | new PR off main; green only with the wiring map's 4389a7a on the combined tree | publisher stop; 2,955 / 2,908 / 6 fail / 41: two expected (decision-inbox.test.js 269/271, removed by 4389a7a), four in test/lineup-diff-urgency.test.js :104 :141 :187 :200 (a third file pinning the publish; feature audit fixes in its own commit); isMine left accepted-unused (callers in routes/trades.js), removal a follow-up; push when whole-suite green |

Continues: [[gridiron-held-branches-19-2026-09-20]] (Coach 4e93e98, Model audit ea24afe, chat sync 22bbd45).
