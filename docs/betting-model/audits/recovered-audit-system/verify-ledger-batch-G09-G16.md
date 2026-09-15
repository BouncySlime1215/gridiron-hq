# Adversarial verification, practice-truth lens — G09..G16
Repo read-only. DB reads via node:sqlite readOnly:true.

## G09 CLV never persisted / default book set includes execution book
- nfl-execution-clv.js:232-234 `executionClvReport` reads accepted+settled opportunities; :317-353 returns JSON; no INSERT anywhere in the file (grep: no run()/db write imported — only `rows`, :35).
- :48 CLV_GRADING_VERSION, :59 DEFAULT_CLOSING_BOOKS=null, :178/:350 declared_books='all_books_present_in_tape' — the "declared reference book set + period (:60 GRADED_PERIOD='full_game')" principle is ALREADY met.
- routes/nfl-market.js:390-392 `res.json(executionClvReport())` — never passes `books`.
- DB: `SELECT status,count(*) FROM nfl_execution_opportunities` -> [] (zero rows). Report is empty today.
- :293-294 already computes closing_quote_ids per position; they are discarded with the response.
- Recompute-on-read is not reproducible-by-construction: :82-83 kickoffForEvent reads game_lines (mutable), and the default book set is defined as "whatever is in the tape now".
- Sub-claim "reference excludes the execution book" is NOT a standard — the most common CLV definition grades against the close at the book you bet, or a declared sharp book. Opinion.
- Abstains: shadow_decisions already stores abstains (shadow-ledger.js:39) with lines, so an all-game series exists on THAT path, but not on the quote-tape/execution path.

## G10 settlement overwrites + shadow close = mutable ESPN spread
- shadow-ledger.js:99-100 `UPDATE shadow_decisions SET settled_at,outcome_json,result,clv_points`; :83 `closingLine = game.spread` (live column), :90 `closingLine = game.total`.
- forward-ledger.js:149-156 comment + :154-155 `closing_spread ?? spread` — the sibling ledger already documents that the live column is unsafe after kickoff. :179-181 UPDATE in place, selected at :137 `WHERE result IS NULL`.
- gamescript.js:124 `spread=excluded.spread` (NOT coalesced) — live in-game numbers overwrite; :152-158 + :226-229 closeStmt writes closing_spread ONLY when `preKickoff`.
- Neither ledger has FINALITY_BASES nor a correction path; nfl-execution-lifecycle.js:156-161 + :391-410 already implement exactly that shape for the accepted-ticket ledger.
- Scores are only written when final (gamescript.js:177-178 `isFinal ? int(score) : null`), so premature settlement from a live score is NOT possible — that part of the risk does not apply.

## G11 funnel/attribution read the uncorrected settled row
- nfl-execution-lifecycle.js:417-421 `netRealizedUnits` sums state IN ('settled','settlement_correction').
- :470-476 lifecycleFunnel JOINs `e.state='settled'` and sums `e.realized_pnl_units` from that one row -> ignores corrections (:400-408 stores the DELTA on the correction row on purpose).
- nfl-execution-attribution.js:116 `const settled = opportunity.events.find(e => e.state === 'settled')`; :127-128 reports `settled.realized_pnl_units`.
- Latent today (0 opportunities), but it is a direct contradiction of the file's own authoritative accessor.

## G12 blind-audit freeze scope inverted
- Cited line numbers are WRONG. Actual: external tables read at nfl-blind-audit.js:673-679 (nfl_odds_archive, nfl_nfelo_games, nfl_external_ratings) inside historicalOpenerReplay; shadow_decisions read at :758-759.
- INPUT_TABLES :40-51 contains none of those four; it DOES contain `nfl_ensemble_fit_artifacts` (:44) with no scope branch in :106-147 -> hashed `all_rows` (:152-153).
- nfl-ensemble.js:951-962 withEphemeralEnsembleArtifacts sets _artifactPersistenceEnabled=false; :993-995 skips the artifact read; :1206 skips the write. nfl-blind-audit.js:854 wraps the whole week compute. So the frozen table is provably never read during an audited week.
- The unfrozen reads reach the hash: :878 `result.lookback = weekLookback(...)` -> :885 resultHash = sha(JSON.stringify(result)) -> :886 chainHash.
- DB confirms the failures: retries rows — run 21 "model input data changed after preregistration (nfl_ensemble_fit_artifacts)", run 28 "(nfl_teams)". nfl_teams has since gained a scope branch (:118-128); nfl_ensemble_fit_artifacts has not.

## G13 weekly_input is council output
- weeklyInput defined at :615-640 (gap cited :420-449 = aggregate(), wrong); called at :867 with the same in-memory expertCouncil produced at :855.
- Its cells are specialist forecast_residual/uncertainty/missing_reason, coordinator, combined_decision, production_pick — all model OUTPUT. Only :631 evidence_cutoff/market_margin are input-ish.
- The forward path has a real packet with an availability-claim vocabulary: nfl-t60-packet.js:43 PACKET_VERSION 'nfl-t60-packet-v3-c11', :55-60 AVAILABILITY_CLAIMS ('received_by_cutoff' etc.), and the file's own example of retrospective weather rows fetched 2026-09-02 for pre-2026 games.
- Partial mitigation: inputDataState hashes whole tables, so the read set is reconstructible at table granularity — but not per game, and a table hash cannot express received-vs-published.

## G14 overview counting
1. win_rate_95 always [0,0]: :116 lowercases result, :125-126 stores it into allBets, :221 passes to nfl-replay.js uncertainty(), which filters `b.result === 'Won' || 'Lost'` (:44, :57-58) -> graded empty -> winRate 0 every draw; sample_warning is also always "Very small sample" (:70). Stored runs do write 'Won'/'Lost' (run 32 picks sampled).
2. Truncation invisible: :159-170 expected = min..max of OBSERVED weeks; :205 coverage_complete. DB: run 28 is `failed` with 22 of 70 scheduled weeks — 2021 w5-18, 2022 w5-12 — both spans "complete", seasons 2023-25 simply absent -> coverage_complete true. spec_json IS on the row selected at :36 and is never parsed (schedule length 70 available and unused). runManifest (:567-568) does report expected vs opened weeks, so the fact exists elsewhere.
3. Missing units: :122-123 excludes from by_market.units but :126 `units: pick.units ?? 0` -> spread_only.units (:196) and uncertainty's ROI treat unknown stake as 0; `units_known` is recorded and never read.
4. ROI denominator: :135 `units / bets` and :220 `spreadUnits / spreadBets.length` include voids and unknown-stake picks.
- test/audit-overview-counting.test.js contains zero occurrences of "roi", "win_rate_95" or "uncertainty" (grep -c = 0); :133-143 asserts missing_units and units but not roi; the coverage tests are a HOLE inside a span (:104-117), never a truncated run.

## G15 weekly-cluster bootstraps
- nfl-replay.js:43-74 uncertainty(): clusters keyed `${season}-${week}` built only from the bets passed in (:46-50) — a week with no bets contributes no cluster. Reused at nfl-neural-replay.js:97 and nfl-replay.js:700 (segment effect gate).
- Independent implementations: line-move-study.js:309-333 (own seededRandom :307), beat-the-close.js:392-413 (own seededRandom :394, needs >=2 clusters), nfl-family-contribution.js:259-297 (paired weekly delta, withRandomSeed), backtest-significance.js:57-106 (group block bootstrap over arbitrary group keys).
- All five resample only the clusters that exist in the data; none has a declared week set.
- Caveat: they estimate different things (single-arm ROI/CLV vs paired model delta), so "one implementation" is partly style; the estimand point (ROI-per-bet AND P&L-per-eligible-week) is the substantive half.

## G16 silent iid degradation
- backtest-significance.js:62 `if (groups && groups.length >= n)` ... else :83-93 plain iid resample. Return object :100-105 has no `clustered` field at all, so even a successful clustered run is unlabelled.
- test/paired-bootstrap-clustering.test.js:111-117 asserts the mis-sized-groups call returns `error === undefined` — enshrines the silent fallback; :64-67 in the same file asserts the ungrouped interval covers <0.85 at nominal 0.90.
- 70 references across 19 non-test service files.
