# Adversarial verification, materiality lens — gaps G09..G16
Repo read-only. DB read via node:sqlite readOnly (scratchpad/q*.mjs).

## Empirical ground truth (server/data.sqlite, 2026-09-12)
- nfl_execution_opportunities: 0 rows. nfl_execution_lifecycle_events: 0 rows. (=> executionClvReport, lifecycleFunnel, attribution all operate on nothing.)
- forward_picks: 0 rows.
- shadow_decisions (NFL): 189 rows, 14 settled with clv_points; 8 of those from the ensemble shadow board, 6 from beat-the-close-v1.1.
- nfl_ensemble_fit_artifacts: 847 rows. nfl_odds_archive 135,930; nfl_nfelo_games 1,709; nfl_external_ratings 2,368.
- Blind audit runs: 27/31/32 complete 70/70; 28 FAILED at 22/70 (2021 w5-18 = 14, 2022 w5-12 = 8); 25 failed 3/70; 30 failed 0/70.
  run25 final_json: "model input data changed after preregistration (nfl_team_cards)";
  run28 final_json: "a live scheduler job updated nfl_teams ... which the audit hashed unconditionally".
- run32 stored picks vocabulary: {"Lost":339,"Won":207,"Push":4}; 0 picks with null units; 0 voids.
- game_lines 2026 W1: spread and closing_spread both populated and currently equal; season 2025: 570 rows, closing_spread NULL on all.

## G09 CLV not persisted / book set — REFUTED (not material)
- nfl-execution-clv.js:294-310 already emits closing_quote_ids, closing_books, clv_points, clv_probability (probability space), and :341-342 grading_version + declared_books. Everything the "should_be" asks to persist is already computed and returned.
- :35 the module is a read-only projection over an append-only quote tape; :347-349 states the reason (idempotent regrade when a close lands late). Recompute over immutable rows returns the same number, so persistence changes no number.
- :59 DEFAULT_CLOSING_BOOKS=null is a DECLARED choice recorded on every report; excluding the execution book is a convention, not a correctness fix, and the main line is a mode over 15+ books (q: unibet 258k ... pinnacle 97k rows).
- 0 accepted/settled opportunities => the endpoint (routes/nfl-market.js:390-391) returns an empty report today.
- The "all-game series" the gap wants already exists in shadow_decisions (189 rows, clv_points populated) via shadow-ledger/beat-the-close.

## G10 settlement overwrites the row; shadow close = mutable column — CONFIRMED (shadow half)
- gamescript.js:219-223 writes game_lines.spread on EVERY scoreboard poll where ESPN still publishes odds (isFinal only nulls the scores at :178); :226-229 writes closing_spread ONLY when `preKickoff` (:202). So `spread` is the in-game-mutable column and `closing_spread` is the frozen close — stated at gamescript.js:147-152 and again at forward-ledger.js:149-156.
- shadow-ledger.js:71-72 does not even SELECT closing_spread; :83 `closingLine = game.spread`; :84 clv = line - closingLine; :99-100 UPDATE in place.
- settleNflShadowDecisions is driven automatically (nfl-model-growth.js:169), and it only fires once scores exist — i.e. after the window in which `spread` can have been overwritten with an in-game number.
- The shadow ledger is the project's declared untouched forward gate (nfl-blind-audit.js normalizeSpec rules: "The genuinely untouched gate is the 2026 forward shadow ledger"), and it already holds 8 settled CLV numbers.
- Partial refutation of the claim as written: forward-ledger.js:154 ALREADY prefers closing_spread ?? spread, and forward_picks has 0 rows, so the forward half is already fixed/moot. The correction-as-append half is latent everywhere (both settlers guard on result/settled_at IS NULL, so nothing is silently overwritten today).

## G11 funnel/attribution read the uncorrected settled row — REFUTED (real but unreachable)
- lifecycleFunnel nfl-execution-lifecycle.js:469-476 joins state='settled' only; totalPnl/wins/losses ignore settlement_correction deltas that netRealizedUnits (:417-421) sums. Accurate as a code reading.
- But: 0 opportunities and 0 lifecycle events exist; a divergence requires an accepted bet -> settled -> correctSettlement (:380-409, actor+reason required), none of which has ever happened.
- nfl-execution-attribution.js:112-131 (threeWayAttribution) has no caller outside test/nfl-execution-attribution.test.js — it is not wired to any route.
- Route routes/nfl-market.js:352 serves the funnel, but over zero rows it returns zeros either way.

## G12 blind-audit freeze scope inverted — CONFIRMED
- INPUT_TABLES nfl-blind-audit.js:40-51 contains nfl_ensemble_fit_artifacts but NOT nfl_odds_archive, nfl_nfelo_games, nfl_external_ratings, shadow_decisions.
- Read-but-unfrozen: historicalOpenerReplay :673-680 reads all three external tables (all populated); weekLookback :758-760 reads shadow_decisions. Their outputs land in result.lookback (:877) which is hashed at :884 into result_hash and :885 chain_hash.
- Frozen-but-unread: inputDataState :129-146 has no scope branch for nfl_ensemble_fit_artifacts, so it is hashed 'all_rows' (847 rows today), while every audited week runs inside withEphemeralEnsembleArtifacts (nfl-ensemble.js:951-962) which sets _artifactPersistenceEnabled=false so fitEnsemble :993-995 never reads the table.
- Cost is on the record: runs 25 and 28 were killed by exactly this over-freeze (final_json quoted above), and compareAuditRuns (nfl-audit-overview.js:238-271) treats any week-hash difference as "a real forecast, selection-policy, or data change occurred" — a claim the unfrozen look-back inputs can falsify.
- Correction to the claim: the shadow_decisions component is inert for historical runs (it is queried with the AUDITED season/week, 2021-2025, and shadow_decisions only holds 2026 rows); the live hazard is the three external-line tables.

## G13 weekly_input is council output — REFUTED (labelling, not evidence)
- nfl-blind-audit.js:866-869 -> weeklyInput(:615-638) is built entirely from the in-memory expertCouncil object plus the betting picks: per-specialist forecast_residual/status, coordinator, combined_decision, production_pick. No input row or row hash is captured.
- But the run's input attestation exists at table level: inputDataState (:95-157) hashes every INPUT_TABLE (season-scoped) at preregistration and assertFrozen rechecks before and inside the write transaction (:847, :891). Code is hashed too (repositoryState :80-93).
- No number changes, no decision changes; the honest fix is renaming the field (or adding per-game row hashes), not a new evidence pathway.

## G14 overview: win_rate_95 [0,0], blind coverage, units/voids — CONFIRMED
- nfl-audit-overview.js:116 lower-cases pick.result; :125 pushes the lower-cased value into allBets; :221 passes allBets to uncertainty(), which at nfl-replay.js:44 and :55 matches 'Won'/'Lost' exactly. Stored picks are 'Won'/'Lost' (run 32: 207/339/4). => graded.length is 0 in every bootstrap draw, winRate pushes 0 each trial, so spread_only.uncertainty.win_rate_95 is [0,0] and sample_warning is permanently the <100 string. roi_95 is unaffected (uses units).
- Coverage :159-170 builds `expected` from the OBSERVED min..max week, so a truncated run self-certifies: auditOverview(28) — a run that died at 22 of 70 weeks — sees 2021 w5-18 and 2022 w5-12, reports both complete and coverage_complete true. spec_json (loaded at :36 via SELECT *) carries schedule (normalizeSpec nfl-blind-audit.js:186) and is never referenced anywhere in the file (grep: no hits).
- :122-123 excludes missing units from the numerator but :135 roi=units/bets keeps those picks (and voids) in the denominator; :126 allBets pushes `units: pick.units ?? 0`, so spread_only.units/roi and the bootstrap treat unknown as 0. No current run exercises this (run 32: 0 missing, 0 voids).
- test/audit-overview-counting.test.js: grep finds no 'win_rate_95', no 'uncertainty', no 'roi', no truncation case. Evidence line holds.
- Surfaced at routes/nfl-betting.js:385.

## G15 weekly-cluster bootstrap, five implementations — CONFIRMED (modest magnitude)
- nfl-replay.js:43-50 builds clusters from the supplied bets only; reused by nfl-neural-replay.js:97 (summarize), the segment effect gate nfl-replay.js:668-672 (roi_95 bound vs MIN_EFFECT_ROI decides which segments are declared real), and nfl-audit-overview.js:221.
- Four more, none sharing code: line-move-study.js:309-332 (clvSummary), beat-the-close.js:394-412 (weeklyRead — its interval writes nfl_rule_state and RETIRES rules, :417-430), nfl-family-contribution.js:254-296 (pairedDelta), backtest-significance.js:57-104.
- All five build the cluster list from rows that exist; a declared-but-empty week is never a cluster, and no module reports P&L-per-eligible-week. Adding empty weeks widens roi_95 (more empty draws per resample), which moves a published interval and the segment gate that reads its bound.
- Weakest part of the claim: for ROI-per-bet the omission is close to neutral in expectation; the sharp defect is the missing eligible-week denominator, not "five implementations".

## G16 paired bootstrap degrades silently — REFUTED (no live call site trips it)
- backtest-significance.js:62 `if (groups && groups.length >= n)` else the ungrouped branch :83-93; the return object has no `clustered` field at all. test/paired-bootstrap-clustering.test.js:64-67 proves the ungrouped interval covers <0.85 at nominal 0.90, and :111-117 then blesses the silent fallback.
- n = min(valuesA.length, valuesB.length), and every call site inspected builds groups in lockstep with the values array (fantasy-coordinator.js:536-537, nfl-props.js:465-476, nfl-prop-player-heads.js:248-249, nfl-team-strength.js:341-352, draft-abstention-audit.js:405-407, nfl-offseason-change.js:297), so groups.length < n does not occur today and no reported interval is currently wrong.
- The adjacent exposure the gap does NOT state is the reachable one: groups LONGER than n passes the `>=` guard and silently misaligns by index — e.g. offseason-model.js:1497 and :1149 pass `groups: p.groups` while valuesA is `pooled.v1_shipped.errs`, a pooled array that can be longer when a challenger was skipped for a season (the optional-challenger catch at :1485). That, plus the absent `clustered` flag, is the version worth fixing.
