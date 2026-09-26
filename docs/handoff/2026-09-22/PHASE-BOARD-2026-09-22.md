# Gridiron HQ — Phase Scoreboard, 2026-09-22 (as of 18:30Z; item titles verbatim from PART 5, see PLAN-ITEMS-1-25.md)

Formula: **% merged = merged items / total items.** **% weighted** = same, but an item whose
work is in an open PR (draft or ready, CI green-or-pending) counts as 0.5 toward the
numerator. "Built not pushed" / "in progress, no PR" counts 0. An item that is not
PR-shaped (item 1 report, item 7 deploy) counts as merged once done; the PR-only figure is
shown beside it.

**Sources:** PR board 17:14Z (gridiron-pr-board-2026-09-22.md, states 1250-1252), live
GitHub PR list (merged_at confirmed for every PR listed as merged below), plan text
(gridiron-go-plan-2026-09-22.md; PART 5 verbatim in PLAN-ITEMS-1-25.md and memory
gridiron-plan-items-1-25-verbatim-part1..3).

**Resolved since 16:25Z:** the #89/#91 "closed, merged:false" conflict is gone — GitHub
`merged_at` now reads 15:42:47Z (#89) and 15:31:32Z (#91). Both are merged.

**Deploy:** live = c5ee3b54 (#99 tree), scheduler ON since 17:08Z. #115, #119, #117 merged
after that tree and are NOT deployed, as are the eight merges since 17:56Z (#129, #124, #92,
#137, #72, #85, #122, #123). Next deploy is Nick's word. Main is now 7a9982d4; the check:wiring
gate fix landed as #129 c90d2834 (wiring check in `npm run check`), which ends the 17:10Z
HOLD-MERGES.

## Foundation (Nick's GO, items 1-7)

| # | Item | Status | Thread | Evidence |
|---|------|--------|--------|----------|
| 1 | Wiring map stopped + panel rewrite | done (report, no PR) | Wiring map | MEMORY.md "DONE 01:11Z" |
| 2 | 24-job live-tier stall table | open PR #98 (draft) | Scheduler | #98; #95 (jobs off request thread) MERGED eb861feb |
| 3 | Freshness registry + banner-kill (same PR) | **merged** #86 7eca9a8b; follow-ups #96, #104 open | Scheduler + UI | #86 merged 16:59Z |
| 4 | Trade-acceptance outcome logging contract | open PR #94 (full local run, held) | Trade Brain | #94 951c70f1; stack #103, #120 |
| 5 | Honest-inventory contract | **merged** #99 c5ee3b54 + #108 eb19f475 | Opportunity + Wiring map | 881-row inventory on main; #116 follow-up open |
| 6 | Open-PR triage | **merged** #102 140d436b (docs) | Release | #102 merged 16:49Z |
| 7 | Deploy sequence | done — deployed c5ee3b54, scheduler ON 17:08Z | Coordinator / Nick | PR board 17:14Z "live = c5ee3b54" |

Merged: items 1, 3, 5, 6, 7 → 5/7 → **71% merged** (PR-only: 3/7 = 43%).
Weighted: 5 + items 2, 4 at 0.5 → 6/7 → **86% weighted**.

Foundation hardening merged today that carries no item number (counted nowhere, listed
for honesty): #91, #89, #111 (trade-path reads say what measured them / archetype read
failure reported), #112 (depth-chart zero-row guard), #113 (unowned ESPN slot counted),
#110 (test temp-dir race), #87 (feed-zero sentinel guard), #109 + #117 (paid-run opt-in
guards), #119 (failed download no longer reports ok), #114 (docs, dead target_share output).

## Phase A — items 1-3 (PART 5 verbatim titles; full text in PLAN-ITEMS-1-25.md)

| # | Item | Status | Thread | Evidence |
|---|------|--------|--------|----------|
| 1 | LEAGUE CONFIG AUTO-INGEST | open PR #93 (draft) | Fantasy plan | #93 "League-ingest field contract + ESPN credential shared-slot lock-in fix" — title maps directly |
| 2 | DEEP PREDICTIVE FEATURE SET | in progress; evidence merged (#68, #114, #122 5cca6f2e), feature work in open PRs #88, #106, #121 | Model evidence audit / Fantasy plan / R&D | #68 26a5002a MERGED (target-share fix, default-off, 1.90→1.80 MAE = "prove predictive lift" bar); #114 docs; #88/#106 shrinkage-eff-weighting + ranges; #121 pre-reg; #122 evidence-only MERGED 18:xxZ (docs: strike trade-engine/waiver-brain crash finding) |
| 3 | BEAT REPORTER SOURCE MAP | open PR #90 (draft); #82 open; Coach suspension unit unpushed (RED 03da7fd6) | Coach | #90 beat-reporter trust scoring — title maps directly |

Merged: 0/3 → **0% merged** (no item complete; item 2's evidence half is on main).
Weighted: 0.5 + 0.5 + 0.5 → 1.5/3 → **50% weighted**.

## Phase B — items 4-11 (PART 5 verbatim titles)

Not started — blocked by design (order rule: A → B → C → D). No merged or open PR maps
to any B item by title or WORKLOG. #94/#103/#120 (trade-outcome ledger) are Foundation
item 4 and feed item 6's "let the logging make it strong" clause, but they are counted
once, under Foundation.

| # | Item | Status | Thread | Evidence |
|---|------|--------|--------|----------|
| 4 | WAIVER WIRE SYSTEM | not started | — | #123 7a9982d4 MERGED (docs: roster-risk/waiver-brain negative result) is a NEGATIVE bug-hunt on waiver-brain, not item work |
| 5 | DEFENSIVE ADDS + KICKER DENIAL | not started | — | — |
| 6 | TRADE ACCEPTANCE PROBABILITY | not started (logging prerequisite = Foundation item 4, #94) | — | Trade Brain's acceptanceBand() already says "not calibrated" (no midpoint stored) |
| 7 | TRADE TIMING | not started | — | — |
| 8 | THREE-TEAM TRADES | not started | — | — |
| 9 | PLAYOFF PROBABILITY ENGINE | not started | — | — |
| 10 | WEEKLY OPERATING RHYTHM | not started | — | — |
| 11 | PUSH NOTIFICATIONS / GAME-DAY MODE | not started | — | — |

Merged 0/8 → **0%**. Weighted 0/8 → **0%**.

## Phase C — items 12-20 (PART 5 verbatim titles)

Not started — blocked by design. Adjacent work exists but no PR implements an item:
the Independent/Evidence Auditor gates, holdout rules (R40 default-off flag, "control
NOT promoted" R46) and the rig-caveat rule are coordinator process, not a shipped standing
gate (item 12) or shipped Goodhart guard (item 18). #91/#89/#111 (trade page says which
data measured each number) is provenance, not a "why" for a recommendation (item 20).
No record shows #94 logging considered-but-not-proposed trades, so item 17 is not credited.

| # | Item | Status | Thread | Evidence |
|---|------|--------|--------|----------|
| 12 | BEAT-THE-DUMB-BASELINE GATES | not started (process gates only, no shipped standing gate) | — | — |
| 13 | DECISION POST-MORTEM LOOP | not started | — | — |
| 14 | LUCK DECOMPOSITION | not started | — | — |
| 15 | CAUSAL NEWS IMPACT | not started | — | — |
| 16 | INJURY RESPONSE, NOT PREDICTION | not started | — | — |
| 17 | SELECTION-BIAS FIX FOR TRADE LOGGING | not started (considered-not-proposed logging not evidenced in #94) | — | Phase 0 gate item 7 names it; unbuilt |
| 18 | GOODHART / ACCURACY-THEATER GUARDS | not started (Auditor practice only) | — | — |
| 19 | UNCERTAINTY UI | not started (projection-range spec docs/spec/projection-range.md + #88 ranges are model-side; no calibrated-interval UI shipped) | — | — |
| 20 | THE "WHY" ENGINE | not started | — | — |

Merged 0/9 → **0%**. Weighted 0/9 → **0%**.

## Phase D — items 21-25 (PART 5 verbatim titles)

Not started as a phase (order rule). Item 21 has merged hardening work that maps by
title ("nothing rots silently ever again"); it is shown, but D has not "started" and
item 21 is not complete (no monitoring with alerts, no per-source fallback ordering).

| # | Item | Status | Thread | Evidence |
|---|------|--------|--------|----------|
| 21 | PIPELINE FRAGILITY FIX | partial — silent-failure fixes MERGED: #86 (banner reads real rows), #112 (depth-chart zero-row guard), #113 (unowned ESPN slot counted), #119 (failed download no longer reports ok), #115 (no injury data ≠ healthy), #87 (feed-zero sentinel guard), #89/#91/#111 (read failures reported, not swallowed); #124 9f0b5b66 (liveDraft fail-closed, Chat sync); OPEN: #96, #104, #98 (freshness contract / stall table), Scheduler epoch-fallback-loud + refresh-lastline (no PR yet) | Scheduler / UI / Chat sync / Trade Brain / Feature audit | merged_at confirmed on the PR board 17:14Z |
| 22 | ONE-LEAGUE OVERFITTING FIX | not started | — | — |
| 23 | DESKTOP + MOBILE | not started | — | — |
| 24 | COMPETITIVE TEARDOWN | not started | — | — |
| 25 | KILL LIST | not started (Foundation item 6 triage #102 wrote obituaries — counted under Foundation, not here) | — | — |

Merged 0/5 → **0%** (item 21 incomplete). Weighted: item 21 at 0.5 (open PRs) → 0.5/5 → **10%**.

## Phase table (recomputed 18:30Z — unchanged from 17:50Z; no item completed by the 18:xxZ merges)

| Phase | Items | Merged | Weighted |
|-------|-------|--------|----------|
| Foundation | 1-7 (7) | 5/7 → **71%** | 6/7 → **86%** |
| A | 1-3 (3) | 0/3 → **0%** | 1.5/3 → **50%** |
| B | 4-11 (8) | 0/8 → **0%** | **0%** |
| C | 12-20 (9) | 0/9 → **0%** | **0%** |
| D | 21-25 (5) | 0/5 → **0%** | 0.5/5 → **10%** (item 21 hardening; D not started as a phase) |

Not mapped to any item (hardening with no plan number): #110 (test temp-dir race),
#109 + #117 (paid-run opt-in guards — cost safety, not pipeline fragility), #102/#114
(docs), #118 (wording); since 17:56Z: #129, #92, #137, #72, #85 (see unmapped merges below). Note: WORKLOG 16:22Z "Phase B ~25%" is superseded by this board.

## Features added today (merged)

- The trade page now says which data measured each number and what was missing, instead of guessing (#91, #89, #111).
- The "data is fresh" indicator checks the actual rows, so it cannot show healthy while the data is stale (#86).
- Heavy data-refresh jobs run off the web thread, so pages stay responsive while data updates (#95, deployed).
- A complete, code-generated inventory of which features are actually wired up and reachable (#99, #108).
- Injury availability now says "no injury data" rather than assuming a player is healthy (#115).
- The fantasy model was audited; unsupported claims were retracted and a target-share correction shipped behind a flag, about 5% more accurate on unseen data (#68).
- Scripts that could cost money refuse to run without an explicit opt-in (#109, #117).
- Silent failures fixed: unowned ESPN roster slots are counted (#113), a failed data download no longer reports OK (#119), an empty depth chart is caught (#112), bad sentinel plays no longer skew averages (#87).

## Features in flight

- Trade outcome ledger: what we predicted next to what actually happened, so advice can be graded (#94, #103, #120).
- League settings pulled in automatically (scoring, lineup, waiver, FAAB, playoffs, keeper) so projections use your league's rules (#93).
- A freshness contract that asks whether a table holds current rows, not just whether a sync ran (#96, #104, #98).
- Coach: ask the app a question and get an answer with the row it came from, plus beat-reporter trust scoring (#90, #82; suspension handling unpushed).
- Projection ranges, reliability, and graded injury-report availability in the model (#88, #106); R&D cleanup incl. route splits as a scheduled job (#92 MERGED 6e722719).
- UI fixes (QB target-share wording #118, ceiling-lineup fix at Auditor), Release deploy workflow, Wiring map check:wiring fix, Scheduler epoch-fallback / refresh-lastline.

## Waiting on Nick (terminal or his word only)

1. Next deploy (#115/#119/#117 and later are not in c5ee3b54) — his word.
2. Key rotation — Fly token + Anthropic key, both exposed, zero of 5 credentials rotated.
3. Rollback-image confirmation (`deployment-01M2VZ9JRYSXVHCRWJ83V360QH`) — his word only.
4. ESPN cookie (his own account) — needed for real trade-outcome rows and the transactions pipeline.
5. Auto-mode permission classifier ("Modify Shared Resources") — his claude.ai environment settings.

## File ownership (gridiron-file-allocation.md)

Unchanged from 16:25Z: `nfl-model-growth.js`, `nfl-advanced.js`, `football-context.js`,
`nfl-player-value.js`, `nfl-roster-strength.js`, `scripts/build-manager-archetypes.mjs`
remain **unallocated** in gridiron-file-allocation.md. `ceiling-lineup.js` → UI (16:59Z).

## Unmapped merges (since 17:56Z, no plan item by title or WORKLOG)

#129 c90d2834 (gate fix: wiring check in `npm run check` — unblocks main, not item work),
#92 6e722719 (Planner: R&D cleanup / route splits), #137 bd903669 (CONTRACT.md 169/225 fix,
docs), #72 3ceb7047 (Opportunity cascade null-multiplier passthrough), #85 c0a051bd
(Opportunity). #124, #122, #123 are noted on items 21, A-2 and B-4 above; none completes an item.

## Changelog

- 18:30Z — merged #129, #124, #92, #137, #72, #85, #122, #123 (main 7a9982d4); no item completed, percentages unchanged (Foundation 71/86, A 0/50, B 0/0, C 0/0, D 0/10); HOLD-MERGES ended by #129; deployed tree still c5ee3b54.
