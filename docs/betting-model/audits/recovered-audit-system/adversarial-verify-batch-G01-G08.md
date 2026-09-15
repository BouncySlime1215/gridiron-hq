# Adversarial verification — audit-system gaps G01–G08 (practice-truth lens)
Read-only pass, 2026-09-12. All DB reads via `node:sqlite` readOnly:true on server/data.sqlite.

## G01 — forward packet price-blind — NOT REFUTED (with wording correction)
- server/services/nfl-quote-tape.js:61-66: `const receipt = receivedAt ?? requestedAt; const clockSource = receiptClockSource ?? (receivedAt ? 'response_completion' : 'legacy_request_time_only');`
- server/services/book-feeds.js:417 `ingestQuoteSnapshot(payload, { provider:'free-book-feeds', requestedAt: at, markets:..., sourceRef:'book_feeds' })` — no receivedAt.
- server/services/line-shopping.js:66 `ingestQuoteSnapshot(data, { requestedAt: at, markets, sourceRef: 'snapshot_lines' })` — no receivedAt.
- server/services/nfl-t60-packet.js:214-216 realClock = `receipt_clock_source === 'response_completion'`; receivedByCutoff filters realClock only.
- Live DB: `SELECT receipt_clock_source,COUNT(*) FROM nfl_quote_batches GROUP BY 1` -> legacy_request_time_only 1342 (only value). free-book-feeds 1174 (latest 2026-09-12T07:44Z), the-odds-api 168.
- SF@LAR (only frozen observation, nfl_t60_observations id bfa3e97…, cutoff 2026-09-10T23:35Z): 18,810 spread quote rows in the kickoff window, all legacy -> receivedByCutoff = 0.
- CORRECTION: `captureCurrentQuoteTape` (nfl-quote-tape.js:127-137) and `backfillHistoricalQuoteTape` (:164) DO stamp response_completion; they require ODDS_API_KEY and have produced no batch in this DB. Accurate phrasing: no producer that actually runs stamps a receipt clock, so 100% of live batches are permanently ineligible.

## G02 — frozen packet content discarded, non-canonical hash — NOT REFUTED
- t60-runner.js:127-129 UPDATE sets packet_hash only; the packet object is never persisted.
- t60-runner.js:141-143 `packetHash = sha256(JSON.stringify(packet))` — insertion-ordered, no key sort.
- nfl-t60-packet.js:332 packet carries `computation_started_at` (= wall clock at capture, t60-runner.js:108) -> two captures of identical evidence hash differently.
- migration 034_t60_runner_ledger.js:33-58 — nfl_t60_observations has no payload/packet_json column.
- t60-runner.js:249-258 runT60Pass returns counts; `captured[].packet` is dropped.
- server/betting/nfl/contracts/forecast-packet.js:167-216 canonicalize/packetHash/sealForecastPacket exist; grep shows the only importer is test/forecast-packet-contract.test.js:20. No producer, no consumer.

## G03 — Week 1 decisions not on an append-only tape — NOT REFUTED (evidence overstated)
- Live DB: nfl_decision_runs 0, nfl_decision_events 0. nfl_t60_observations: 1 row (SF@LAR) vs 16 scheduled week-1 games.
- t60-runner.js has no import of nfl-decision-tape.js; grep: recordDecisionRun called only at nfl-execution-pipeline.js:128 (manual) and routes/nfl-market.js:323.
- scheduler.js:697-703 -> nfl-auto-picks.js:208-217 persistPickDecisions is an UPSERT (mutable), 16 rows for 2026 wk1, all `eligible=0 / calibration_not_proven`, recorded_at 2026-09-12T05:36Z.
- CORRECTION: "SEA-NE absent from every ledger" is false — `NE at SEA` IS in nfl_pick_decisions (recorded 2026-09-12, i.e. 3 days AFTER its 2026-09-09 kickoff, via UPSERT) and has 6 shadow_decisions rows. It is absent from nfl_t60_observations and nfl_decision_runs. The substance (no immutable per-observation tape run; denominator is not the declared schedule) stands.

## G04 — shadow ledger records finished games — NOT REFUTED (evidence numbers wrong)
- shadow-ledger.js:22-31: eventKey/modelVersion built from board policy version + controller; existence check `WHERE sport='NFL' AND event_key=? AND market=? AND model_version=?` — no kickoff, no score guard anywhere in recordNflShadowBoard (lines 10-51).
- Live: event_key 2026:1:SEA:NE has 6 rows. The pair with model_version `…@1.2.0…` was captured 2026-09-10T23:36:01.906Z; kickoff 2026-09-10T00:20Z; final SEA 13-10; both settled with result 'Push', clv_points 0. Policy 1.1.0 pair was captured 2026-09-02 (legitimately pre-kickoff) — i.e. the policy bump re-recorded the same game after it ended, exactly as claimed.
- settleNflShadowDecisions (shadow-ledger.js:59-105) settles anything with a score; no post-kickoff guard.
- CORRECTION: "200/216 rows" does not match the DB (6 rows for that event). Also, the post-kickoff rows are decision='abstain', so they are NOT currently counted by validationFirewall().forward (nfl-evidence.js:114-123 counts decision='observe' only; live forward = 61 decisions, 0 settled). The defect is live but currently latent for the forward count: the moment any decision is eligible, the same unguarded path writes an 'observe' row for a finished game.

## G05 — historical audit grades a forecast that is not served — NOT REFUTED
- nfl-replay.js:225 `ensembleLine(season, g.week, g.home, g.away, { includeEvidence: false, ...modelOptions })`; replaySeason's modelOptions defaults `{}` (nfl-replay.js:186).
- nfl-ensemble.js:1221 `blendMode = 'raw'` default; :1299 `margin = blendMode === 'market_residual' ? residualMargin : rawMargin`.
- nfl-auto-picks.js:83 `modelOptions = { blendMode: 'market_residual', ...modelOptions }` (the served board).
- nfl-blind-audit.js:284 `replaySeason(season, { startWeek: week, endWeek: week, markets: [market] })` — inherits raw.
- Contrast: nfl-cover-calibration.js:276 DOES force market_residual, and test/nfl-cover-identity.test.js:74 asserts it. No test asserts replaySeason's/the blind audit's blend mode. nfl_replay_runs stores `config`/`label` (schema nfl-n-to-z.js:418) but holds 0 rows; "spec_json/spec_hash" in the should_be is a naming nit, the substance (record the blend mode with the run) applies.

## G06 — stale candidate finding aborts the season-end cycle — NOT REFUTED
- nfl-candidate-findings.js:209-211: assertSeasonRoleAvailable + assertRuleUnchanged run OUTSIDE the try; only proposeAdjustment is wrapped (:214-218).
- :280-284 loop over eligibleForHoldout with no per-finding try/catch.
- nfl-model-growth.js:256 `detail.candidate_findings = runCandidateFindingsForSeasonEnd(season);` bare; :302-307 catch marks run 'error' and rethrows.
- Recomputed identity: codeIdentity(['services/nfl-replay.js','services/stats-util.js','services/nfl-policy.js'],'nfl-candidate-finding-predicate') -> 186 files, complete:false; segmentRuleHash -> bfc269cc8cbd827e… vs stored 4303bbce23f0c7d6… (nfl_candidate_findings id 1, state 'discovered', 5 discovery seasons 2021-25). Mismatch confirmed.
- Renewal impossible: segment_key is derived (`dimension|segment`, :71) and UNIQUE (migration 024:31); recordDiscoveryFlag :157-159 returns `already_past_discovery` for any non-pending existing finding and never rewrites rule_definition_hash. Only a human `rejectFinding` unblocks, by discarding.
- Tests: no test/ reference to recordHoldoutTest; runCandidateFindingsForSeasonEnd is exercised only via the blind-audit deferral path (test/nfl-candidate-findings.test.js:174-177).
- Note: "identity = manifest of predicate files only" is a design opinion; the versioning + per-finding isolation halves are standard.

## G07 — historical CLV/ROI record is a beat-the-close exercise — NOT REFUTED
- nfl-replay.js:191-193 slate selects `gl.spread AS home_spread` (and :203 `gl.open_spread`); :224-226 market margin = -home_spread.
- gamescript.js:42-99 writes game_lines.spread from nflverse games.csv `spread_line` (source 'nflverse') — a post-hoc schedule-file consensus, not a decision-time quote.
- Live DB, home=1: closing_spread IS NULL for 285/285 rows in every season 2021-25. |spread - open_spread| >= 0.5 in 268/285 (2021), 246/284, 231/285, 203/285, 218/285 — ~71-94%, consistent with the cited ~80%.
- nfl-ensemble.js:1310-1317 market-residual anchor is the same g.home_spread.
- Disclosure exists only as an in-file comment, nfl-replay.js:83-91 ("compares the pick to the CLOSING line — a number that does not exist yet at any point a real bet could have been placed") and :104-109; no machine-readable market_line_basis field anywhere (grep: no hits in server/).

## G08 — decisions not reproducible from stored inputs — NOT REFUTED
- nfl-execution-pipeline.js:136 hard-codes `dataIdentityStatus: 'unfrozen_live_tables'`, passes no dataHash (the in-code comment says "C11 replaces this with a real frozen packet hash").
- nfl-decision-tape.js:361 `scheduleVersion = null` default; recordDecisionRun supports `frozen_packet` + 64-hex dataHash (:371-377) — the capability exists and is never used.
- nfl_t60_observations live row: schedule_version NULL, decision_run_id NULL.
- test/nfl-decision-identity-pipeline.test.js:149-150 asserts data_identity_status 'unfrozen_live_tables' and data_hash null — the weak state is pinned by test.
