---
name: gridiron-held-branches-8-2026-09-20
description: Page 8 of the no-PR "-hold" branch ledger for the 2026-09-20 GitHub freeze; heads from 06:50Z (Opportunity wiring-names a6d00bb) and later.
metadata:
  type: project
---

Continues [[gridiron-held-branches-7-2026-09-20]] (same rule: `git merge-base --is-ancestor <recorded-head> <hold-branch-head>` before the morning fast-forward). Heads as reported by each thread, not yet re-verified by Opportunity.

| thread | hold branch | head | fast-forwards onto | note |
|---|---|---|---|---|
| Opportunity | claude/project-thread-w45mur-wiring-names-hold | a6d00bb → 9732f83 (07:32Z, p11) | new PR off main 791b131 after the go; shares nothing with #72 | check exit 0, 2,953 tests / 2,912 pass / 0 fail; docs/tdd/durability-prior-substitution.tdd.md; one name per row builder: buildSeasonRows → buildOpportunityRows in opportunity-model.js (preseason-model.js keeps buildSeasonRows), two call sites updated; three exports dropped (OPPORTUNITY_STATS, SECONDARY_STATS zero references; ESPN_DESIGNATION_LABEL un-exported); `durability_prior_measured` served; annotations entry unaffected |
| Trade Brain | claude/project-thread-3xqh5l-accessor-hold | 7f6a48e → ef3164e (07:36Z, p12) | #41 45323ce | 2,987 tests / 0 fail, four injections caught; nine exports without production consumer, nothing dead, seven seams annotated; :934 roster-context call NOT landed (lands after roster-read is in main; no hold on a hold); valuation_map in progress (07:06Z, build now); route-handler deletions gated on the clean head |
| UI (NEW) | claude/project-thread-xiezr0-delete-pages-hold | b502852 (06:59Z; on number-roll ce66060, resolved 07:11Z) | UI stack; ONE PR from the tip (page 9) | typecheck clean, 3,146 tests / 3,105 pass / 0 fail / 41 skipped, build 2.55 s, smoke passed; mutation APPLIED, 7 runs all red; six page files gone, two palette rows removed, routes stay as redirects; StatTable.tsx the one knowingly unimported client file until the new design-system table lands |
| Google sign-in | claude/project-thread-n4052e-league-sync-creds-hold | c986b80 → da8ec48 (11:00Z, p15) | #71 8b1a036 (untouched; morning ff = #71's branch from c986b80, carrying the #48 and #51 work unchanged) | full check on the exact pushed tree exit 0: 2,985 tests / 2,944 pass / 0 fail / 41 skipped + typecheck, lint, build, start:smoke on an isolated DB; evidence file carries every injection with hashes, its test and a NO-OP control per sweep; nothing open; idle on the espnWeeklyRows path (routes/leagues.js:125/:160) and league-outlook.js; doc-only commit pending; patch p14 |
| Fantasy plan (NEW) | claude/project-thread-f921do-weekly-scores-hold | 1ed7b79 → 6b77382 (11:01Z, p15) | NO PR; carried by O4 803074d (p10), de-dup done 07:23Z | server/services/espn-weekly-scores.js exporting espnWeeklyRows(lg), imports nothing (pinned); check exit 0: 2,962 / 2,921 / 0 / 41; ten mutations caught; docs/tdd/espn-weekly-scores.tdd.md; retroactive-RED stated in the commit (PR body must say the same) |
| Fantasy plan (NEW) | claude/project-thread-f921do-avail-basis-hold | a7ac178 (07:06Z) | STACKED on wiring-names a6d00bb → 9732f83 by merge (07:33Z; pair, base first; R1) | 2,960 / 2,919 / 0 / 41, smoke clean, six mutations; docs/tdd/availability-basis.tdd.md; four basis values (fitted, durability_prior, default_durability, unrecognised); exports activeProbabilityFor, DEFAULT_ACTIVE_PROBABILITY, AVAILABILITY_BASES; ANCESTOR ONLY, not a PR target (07:57Z; the pair opens as ONE PR from memo-key 9fce773, p13) |
| ~~Chat sync (PENDING)~~ WITHDRAWN (R1, after 07:11Z) | ~~new -hold, name to follow~~ | ~~PENDING (after 07:08Z, R4)~~ | ~~STACKED on 1ed7b79~~ | ~~manager-signals.js:249-250 second parser~~ not a parser (last_week_margin, a scalar); no chat sync hold on 1ed7b79 |

Continues: [[gridiron-held-branches-9-2026-09-20]].
