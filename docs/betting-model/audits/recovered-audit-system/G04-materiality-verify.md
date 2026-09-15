# G04 adversarial verification (lens = materiality)

Claim under test: "Shadow ledger records finished games as forward predictions and settles them as forward evidence."
Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). DB: server/data.sqlite via node:sqlite readOnly.

## Mechanism — CONFIRMED
- shadow-ledger.js:28-31 existence check is `(sport, event_key, market, model_version)` only; no kickoff or score guard.
- shadow-ledger.js:25 model_version embeds `policy.id@policy.version` and the reliability-controller version, so a policy bump (1.1.0 -> 1.2.0, commit 8d950b0 2026-09-10 13:17 -0400) creates a new key.
- evidence-daemon.js:125 `recordNflShadowBoard(season, week)` runs for the WHOLE week whenever any window in that week is due (windows grouped by season:week at :98-103). Week 1 still had 14 unscored games on 2026-09-12, so Thursday's finished game keeps getting re-boarded.
- The ensemble slate has no score filter: nfl-ensemble.js:1353-1354 `SELECT team AS home, opponent AS away FROM game_lines WHERE season=? AND week=? AND home=1`; nfl-auto-picks.js:97-98 prices likewise `FROM game_lines WHERE season=? AND week=?`.
- DB: daemon run 2149 started 2026-09-10T23:35:53Z (due=2 windows, week 1) -> rows 200/216 for 2026:1:SEA:NE captured 23:36:01Z, kickoff 2026-09-10T00:20Z (evidence_capture_windows.event_at), quote_at '2026-09-10 23:02:55', line 3 == closing_spread -3 -> clv 0, result Push. Score already existed: rows 15/31 for the same game settled at 2026-09-10T04:03Z (settlement needs team_score, shadow-ledger.js:74-75).
- Whole-ledger scan (189 rows, kickoff = gameday+gametime ET): exactly 2 rows captured at/after kickoff — ids 200 and 216. Both `decision='abstain'`, reason `calibration_not_proven`.

## Materiality — what changes if closed
Numbers derived from shadow_decisions and where Nick reads them:
1. validationFirewall().forward (nfl-evidence.js:114-119) filters `decision='observe'`. Current: decisions=61, settled=0. Rows 200/216 are abstain -> EXCLUDED. Readers: Training.tsx:315-320, ModelOperations.tsx:110, ProfitabilityControl.tsx:255, nfl-research.js:178-179 gate `untouched_holdout`, nfl-profitability.js:151-152/184. Delta from closing G04: **0**. `untouched_gate_passed` stays false (0 >= 200) either way.
2. shadowLedgerSummary (shadow-ledger.js:107-121) -> nflModelGrowthStatus.labeled_examples (nfl-model-growth.js:130-136) -> ProfitabilityControl.tsx:134 "Frozen game labels" = settled/independent. Current 8/189; `settled` counts abstain rows too (:117-118 no decision filter). Quarantining 200/216 -> 6/187 (or 6/189 with invalidation rows that keep the raw rows). Tone stays 'good' (settled>0). **This is the only displayed number that moves.**
3. nfl-signal-reliability.js:85-93 frozenExamples dedupes to one row per game preferring candidate then earliest captured_at; for SEA:NE the order is id 31 (Sep 2, Won) before 216 -> row 216 never selected. No effect on the reliability multiplier.
4. ModelOperations.tsx:44 types shadow_ledger but never renders it (only occurrence in file).
5. No consumer of `selected_for_observation` / abstain counterfactual outside shadow-ledger.js (grep).

## Refutation of the CURRENT wording
"settles them as forward evidence" is false for the cited rows: forward evidence = observe-only distinct keys (nfl-evidence.js:114-119). The two post-kickoff rows are abstentions; they land in the label count, not the forward count.

## Why it is not fully dead (latent)
- beat-the-close.js:172-176 (`slateSignals` skips `kickoff <= now`) — the only live producer of `observe` rows IS kickoff-guarded, so a BEAT_THE_CLOSE_VERSION bump does not re-freeze finished games.
- The ensemble writer is NOT guarded; today every ensemble row is abstain (`calibration_not_proven`, 128/128). The day calibration is proven (nfl-auto-picks.js:156 `calibration_eligible`), ensemble rows become `observe` and the next version bump mid-week would insert post-game observe rows with a post-game quote and clv 0, and shadow-ledger.js:57-104 would settle them into forward.settled. Cheap guard; real but not-yet-realized.

## Side observation (out of scope, affects the same numbers more)
beat-the-close.js:277-301 settles its observe rows at kickoff+close with `result=null` when scores are absent (rows 63/64/91/92), and shadow-ledger.js:58-59 only revisits `settled_at IS NULL` -> btc observe rows never receive Won/Lost/Push, so forward.settled is structurally stuck at 0 for the only observe producer. That, not G04, is why "Forward settled 0/200" reads zero.

## Verdict
Downgrade (partial refute). Mechanism real and cheap to close; today's impact is 2 abstain rows moving one informational tile from 8/189 to 6/187; zero effect on any gate, decision, or forward-evidence number; forward record validity not currently compromised.
