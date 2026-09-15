# Adversarial verification — audit-system batch (code-truth lens)
Repo read-only. DB read via node:sqlite readOnly:true. 2026-09-12.

## G01 quote receipt clock — SURVIVES (with a narrowing)
- book-feeds.js:417 `ingestQuoteSnapshot(payload, { provider: 'free-book-feeds', requestedAt: at, ... })` — no receivedAt.
- line-shopping.js:66 `ingestQuoteSnapshot(data, { requestedAt: at, markets, sourceRef: 'snapshot_lines' })` — no receivedAt.
- nfl-quote-tape.js:64-65 `const receipt = receivedAt ?? requestedAt; const clockSource = receiptClockSource ?? (receivedAt ? 'response_completion' : 'legacy_request_time_only');`
- nfl-t60-packet.js:214-216 realClock filter === 'response_completion'; receivedByCutoff drawn only from realClock.
- REFUTATION ATTEMPT: nfl-quote-tape.js:127-137 `captureCurrentQuoteTape` DOES stamp receivedAt after the await and passes receiptClockSource:'response_completion'; backfillHistoricalQuoteTape:164 likewise. So the capability exists.
  But its only caller is nfl-prospective-collection.js:101, reachable only from route nfl-market.js:408 — it is NOT in scheduler.js JOBS. The two scheduled/daemon producers are snapshotLines (scheduler.js:273, evidence-daemon.js:115) and captureBookFeeds (scheduler.js:321/327, evidence-daemon.js:124), both legacy.
- DB now: 1,342/1,342 nfl_quote_batches legacy_request_time_only (1,174 source_ref=book_feeds, rest historical backfill written before the C11 change). Zero response_completion.
- ODDS_API_KEY is present in .env (32 chars), so the block is the caller wiring, not the key.

## G02 frozen packet content discarded — SURVIVES
- t60-runner.js:127-129 UPDATE sets packet_hash only; :141-143 `crypto.createHash('sha256').update(JSON.stringify(packet))`.
- Packet carries `computation_started_at: computationStartedAt` at nfl-t60-packet.js:332, and t60-runner.js:118 passes `computationStartedAt: startedAt` (wall clock) -> hash changes per attempt for identical evidence.
- migration 034_t60_runner_ledger.js:33-58: columns are id…note; no payload/packet_json column. Repo-wide grep: packet_json exists only for nfl_ai_replay_reviews.
- runT60Pass:249-258 returns counts; `captured.captured[].packet` is dropped.
- forecast-packet.js:193 packetHash / :206 sealForecastPacket / :220 contractDescription — only importer in the repo is test/forecast-packet-contract.test.js:20. No producer or consumer in server/.
- Nuance: JSON.stringify of a fixed object literal is insertion-order stable for one code version, so "non-canonical" means "not sorted-key canonical", not "nondeterministic".

## G03 decisions not on the tape — SURVIVES, one sub-claim REFUTED
- scheduler.js:697-703 refreshNflDecisionLedger -> nfl-auto-picks.js:205 persistPickDecisions, an UPSERT (`ON CONFLICT(...) DO UPDATE SET ...`) into nfl_pick_decisions: mutable, not append-only.
- t60-runner.js:245-259 runT60Pass = open/capture/missed only; state never reaches 'decided'; decision_run_id never written.
- recordDecisionRun callers: nfl-execution-pipeline.js:128 (manual, observation identity literally 'unscheduled-manual-invocation' at :121) and route nfl-market.js:323. Neither is in scheduler JOBS (only nfl_t60_runner at scheduler.js:785 is).
- DB: nfl_decision_runs 0, nfl_decision_events 0, nfl_t60_observations 1 (SF@LAR, state frozen, decision_run_id NULL), nfl_pick_decisions 16 for 2026 wk1.
- REFUTED sub-claim: "SEA-NE is absent from every ledger". nfl_pick_decisions holds `NE at SEA` (eligible=0, abstention_reason calibration_not_proven), and shadow_decisions holds 6 rows for 2026:1:SEA:NE. It is absent from nfl_t60_observations and from the (empty) decision tape only.

## G04 shadow ledger records finished games forward — SURVIVES
- shadow-ledger.js:28-31 existence check `WHERE sport='NFL' AND event_key=? AND market=? AND model_version=?`; model_version at :24 embeds `board.policy.id@board.policy.version` and the controller version -> a policy bump mints a new key and re-inserts.
- No kickoff or score guard anywhere in recordNflShadowBoard; called for the whole week from evidence-daemon.js:125.
- DB: 2026:1:SEA:NE kickoff 2026-09-09 20:20 ET (= 2026-09-10T00:20Z), final 13-10. Two rows captured 2026-09-10T23:36:01.906Z under `...nfl-spread-v1@1.2.0...` (champion and candidate), settled result Push, clv_points 0. The 1.1.0 rows from 2026-09-02 are the genuine pre-kickoff ones. 32 rows total at that 23:36Z capture.
- settleNflShadowDecisions:57-104 settles anything with a final score; no invalidation concept, and the UPDATE at :99 mutates the "immutable" row.
- Nuance: validationFirewall (nfl-evidence.js:114-123) counts DISTINCT observe rows; these particular post-kickoff rows are decision='abstain', so they do not inflate the forward count today — the mechanism is what is unguarded, not the current count.

## G05 replay grades an unserved forecast — SURVIVES
- nfl-replay.js:225 `ensembleLine(season, g.week, g.home, g.away, { includeEvidence: false, ...modelOptions })`; modelOptions defaults {} (:187) and no caller sets blendMode.
- nfl-ensemble.js:1220-1221 `blendMode = 'raw'` default; :1299 `const margin = blendMode === 'market_residual' ? residualMargin : rawMargin`.
- nfl-auto-picks.js:83 `modelOptions = { blendMode: 'market_residual', ...modelOptions }` — the served board.
- nfl-blind-audit.js:284 `replaySeason(season, { startWeek: week, endWeek: week, markets: [market] })` — inherits raw.
- replaySeason's summary (:335-363) records `config: { policy, modelOptions, ... }` — an empty modelOptions, so "raw" is never written down. No market/blend basis field.
- Tests: no test/ file calls replaySeason at all; blendMode assertions exist only for ensembleLine and cover-calibration.

## G06 stale finding aborts the season-end cycle — SURVIVES
- nfl-candidate-findings.js:209 `assertRuleUnchanged(finding)` sits BEFORE the try that starts at :211 (the try only wraps proposeAdjustment).
- Loop :280-284 has no per-finding try; nfl-model-growth.js:256 `detail.candidate_findings = runCandidateFindingsForSeasonEnd(season);` is a bare call inside the outer try whose catch (:302-307) marks the run 'error' and rethrows.
- Independently recomputed: codeIdentity(['services/nfl-replay.js','services/stats-util.js','services/nfl-policy.js'],'nfl-candidate-finding-predicate') -> id af23140b…, file_count 186, complete:false. segmentRuleHash for the live finding = bfc269cc8cbd827e… vs stored 4303bbce23f0c7d6… -> assertRuleUnchanged throws.
- The only finding (id 1, 'spread_x_timing|big spread (7+) + late (wk14+)', state 'discovered') is in eligibleForHoldout, so every season-end run throws.
- Never renewable: segment_key UNIQUE (migration 024:31); rule_definition_hash is written only on the pending_confirmation -> discovered transition (:172); recordDiscoveryFlag returns 'already_past_discovery' (:157-159) for any other state.
- Contrast: the live veto path isolates the same check in a try (:325-336) — so the asymmetry is deliberate on the live side and unisolated on the learning side.
- No test exercises recordHoldoutTest (not exported; test only hits the blind-audit-defer branch at test/nfl-candidate-findings.test.js:174).

## G07 historical record is beat-the-close — SURVIVES (citation nit)
- nfl-replay.js:193 `gl.spread AS home_spread`, :203 `AND gl.home = 1 AND gl.team_score IS NOT NULL AND gl.spread IS NOT NULL`.
- DB: closing_spread is NULL for all 2,848 rows 2021-25; `spread` is the nflverse consensus. |spread - open_spread| >= 0.5 in 480-536 of ~570 home rows per season (84-94%), consistent with (higher than) the quoted ~80%.
- Market-residual anchor: the marketMargin used by the residual blend is nfl-ensemble.js:1290 `const marketMargin = g.home_spread != null ? -g.home_spread : null;` feeding :1293-1295 — the gap cites :1317, which is the reported `market_spread` field, not the anchor. Substance unaffected: both read game_lines.spread (selected at :1246).
- Disclosure is a source comment only (nfl-replay.js:82-110); the summary object (:335-363) carries no market_line_basis and the opener diagnostics are labeled as non-executable at :350-357.

## G08 decisions not reproducible — SURVIVES
- nfl-execution-pipeline.js:136 `dataIdentityStatus: 'unfrozen_live_tables',` with dataHash left default null.
- nfl-decision-tape.js:361 `scheduleVersion = null,`. The tape already supports the target state: :374 requires a 64-hex dataHash when dataIdentityStatus === 'frozen_packet', and :377 forbids a hash otherwise — no producer ever passes it.
- DB: the single nfl_t60_observations row has schedule_version NULL.
- test/nfl-decision-identity-pipeline.test.js:149-150 asserts data_identity_status 'unfrozen_live_tables' and data_hash null.
