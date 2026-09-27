---
name: gridiron-held-branches-7-2026-09-20
description: Page 7 of the no-PR "-hold" branch ledger for the 2026-09-20 GitHub freeze; heads from 06:39Z (chat sync f2f321b) and later.
metadata:
  type: project
---

Continues [[gridiron-held-branches-6-2026-09-20]] (same rule: `git merge-base --is-ancestor <recorded-head> <hold-branch-head>` before the morning fast-forward). Heads as reported by each thread, not yet re-verified by Opportunity.

| thread | hold branch | head | fast-forwards onto | note |
|---|---|---|---|---|
| Chat sync | claude/project-thread-sytruo-asof-hold | f2f321b → 9ee6647 (07:36Z, p12) | #47 4c624ac | 2,983/0, nineteen mutations caught, archetype-as-of.tdd.md Parts 3-4; `stale_version_rows` on archetypesBuilt() with a reason naming both versions (as_of null, rows 0); capital_hhi RUN_SHEET_ONLY; WHY_UNSCHEDULED; Mac-only reads carry a reason; corpusStats at status() top level |
| Wiring map (#36) | claude/wiring-map-8f96ur-route-gate-hold | caac88a (07:12Z; page 9) | #36 252c896 | STOP on every route deletion project-wide (06:46Z); nine live routes retracted (scripts dial them by literal path), in-scope 85 → 63; matcher crossing bug fixed, RED by the old rule; 18 model.js routes (33 → 15) + 30 orphaned imports deleted locally, six from edge.js, gamelogs/sync deletion cancelled; corrected per-file list owed before any owner deletes |
| UI (NEW) | claude/project-thread-xiezr0-number-roll-hold | ce66060 (06:41Z) | on odds-gate-hold 22b2cb9; same ONE-PR route from the top of the UI stack | 3,142/3,101/0; 7 mutations red; useNumberRoll wired into StatBlock with an import-exists test; threshold in wire units; measured_on in the calibration footnote |
| Google sign-in | claude/project-thread-n4052e-league-sync-creds-hold | 505f094 (06:43Z; superseded by c986b80 07:03Z, page 8) | #71 8b1a036 (the branch also carries the #48 and #51 work unchanged) | 2,984 tests / 2,943 pass / 0 fail on the exact pushed tree (baseline 2,976 + 8 new), smoke on an isolated DB; revoked_at guard 1 fail, disabled_at 0 fail before the new provision-auth case; docs/tdd/uncalled-surface-audit.tdd.md; tunnel-url dialled by scripts/tunnel.mjs |
| Fantasy plan (NEW) | claude/project-thread-f921do-fit-pins-hold | 386ffe5 (06:46Z; one commit on #58's f15f871, merge-base confirmed) | #58 f15f871 (fast-forward; NOT in the O4 stack) | 2,997 tests / 2,956 pass / 0 fail; docs/tdd/projection-fit-pins.tdd.md; tradeImpact now serves `projection_basis` and `projection_fit`; 7 of 8 mutations fail, the eighth named unpinned (tradeImpact integration fixture, feature audit) |
| Feature audit (NEW) | claude/project-thread-5f9c3y-espn-market-auth-hold | 78f23ab → 0055a89 (p9) | new PR off main; MERGE BEFORE #50 | espn-market.js:31 throws a local EspnCredentialsMissing before the fetch; espnMarketFreshness serves collected/as_of/label from the table's stamps; six tests, five injections biting incl. throw-after-fetch caught by a counting fetch stub; 2,956/2,915/0 |
| Feature audit | claude/project-thread-5f9c3y-roster-read-hold | 9fc851e (p9; supersedes 857aec6) | stacked on trade-week-hold eb55f1d; onto #57 after trade-week | rosterContext exported with test; `?? 0.92` labelled availability_basis (assets, swap rows) and expected_loss_basis (roster-risk); 2,990/2,949/0; local DEFAULT_ACTIVE_PROBABILITY pair + tripwire to be DROPPED for the fantasy plan's accessor (06:49Z) |
| Feature audit (NEW) | claude/project-thread-5f9c3y-draft-chain-hold | 2692006 (confirmed 07:21Z, p9) | new PR off main | pick clock literal 90 in four places incl. the LLM prompt drafts.js:1095 (literal-forbidding test); trend-page six weights labelled, ranking + score_basis served |

Rows from 06:50Z (Opportunity a6d00bb detail and later heads): [[gridiron-held-branches-8-2026-09-20]].
