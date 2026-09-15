# Adversarial materiality verification — 8 audit-system gaps (2026-09-12)

DB read-only: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/data.sqlite

## G01 forward packet price-blind — CONFIRMED
- nfl-quote-tape.js:61-67 `const clockSource = receiptClockSource ?? (receivedAt ? 'response_completion' : 'legacy_request_time_only')`
- book-feeds.js:417 `ingestQuoteSnapshot(payload, { provider: 'free-book-feeds', requestedAt: at, ... })` — no receivedAt (and `at` at :388 is already stamped after the fetches complete, so the honest clock exists and is simply not passed)
- line-shopping.js:66 same shape
- nfl-t60-packet.js:214-216 `const realClock = scopedQuotes.filter(q => q.receipt_clock_source === 'response_completion')`; only realClock can reach received_by_cutoff
- The one response_completion producer, captureCurrentQuoteTape (nfl-quote-tape.js:127-137), is reached only from nfl-prospective-collection.js:101, which is called only from routes/nfl-market.js:35/402 (comment: "this is NOT a scheduled…"). Not in scheduler JOBS.
- DB: nfl_quote_batches by provider/clock = free-book-feeds 1175 legacy (2026-09-02 → 2026-09-12T07:50Z, still running), the-odds-api 168 legacy. Zero response_completion rows ever.
- Only frozen observation: nfl_t60_observations 1 row, SF@LAR, state=frozen, packet_hash e2bcd98f…

## G02 packet content discarded / hash non-canonical — CONFIRMED
- t60-runner.js:127-129 UPDATE stores packet_hash only; :130 pushes packet into the in-memory array
- t60-runner.js:141-143 `crypto.createHash('sha256').update(JSON.stringify(packet))` — insertion order, no canonicalization
- packet embeds nfl-t60-packet.js:332 `computation_started_at: computationStartedAt` → wall clock inside the hashed object; re-freezing identical evidence yields a different hash
- migration 034:33-58 nfl_t60_observations has no payload column
- t60-runner.js:249-258 runT60Pass returns `captured: captured.captured.length` — packets dropped
- forecast-packet.js canonicalize/packetHash/sealForecastPacket (:174-217) have exactly one importer: test/forecast-packet-contract.test.js:20. No producer, no consumer.

## G03 no decision on the tape — CONFIRMED (one evidence line needs correction)
- scheduler.js refreshNflDecisionLedger (~:694-710) → nfl-auto-picks.js:252 persistPickDecisions → nfl_pick_decisions UPSERT (ON CONFLICT DO UPDATE) — mutable, not append-only
- t60-runner.js:245-259 runT60Pass = open/capture/mark-missed only; nfl_t60_observations.decision_run_id and states 'decided'/'abstained' (migration 034:49-53) are never written
- recordDecisionRun (nfl-decision-tape.js:354) reachable only from nfl-execution-pipeline.js:128, itself reachable only from POST /execution/run (routes/nfl-market.js:319-325, whose own comment says "There is no scheduled job calling /execution/run automatically")
- DB: nfl_decision_runs 0, nfl_decision_events 0, nfl_t60_observations 1 of 16 wk1 games, nfl_pick_decisions 16 (2026 wk1)
- CORRECTION: "SEA-NE is absent from every ledger" is false. "NE at SEA" IS one of the 16 nfl_pick_decisions rows (eligible=0, recorded_at 2026-09-12T05:36Z — i.e. written 3 days AFTER its 2026-09-09 kickoff and final). It is absent from the T-60 observation ledger and from the decision tape.

## G04 shadow ledger records finished games — CONFIRMED (materiality nuanced)
- shadow-ledger.js:28-31 `SELECT id FROM shadow_decisions WHERE sport='NFL' AND event_key=? AND market=? AND model_version=?` — no kickoff/score guard
- model_version string (:24) embeds policy version, so a 1.1.0→1.2.0 bump re-records the whole board
- DB SEA:NE rows 200/216, model_version …@1.2.0…, captured_at 2026-09-10T23:36:01.906Z; kickoff 2026-09-09 20:20 ET = 2026-09-10T00:20Z; final SEA 13 NE 10; settled 2026-09-11T04:12Z result Push clv_points 0
- NUANCE: rows 200/216 are decision='abstain'. validationFirewall (nfl-evidence.js:114-123) counts only decision='observe', so the promotion gate is NOT currently inflated by these rows. But shadowLedgerSummary (shadow-ledger.js:105-121) counts total/settled/independent_examples across ALL decisions and is surfaced at model-intelligence.js:117 — a number Nick reads. And recordNflShadowBoard writes 'observe' whenever d.eligible, so the next policy bump over a slate with an eligible finished game puts a post-final row straight into the forward gate.

## G05 replay grades an unserved blend — CONFIRMED
- nfl-replay.js:225 `ensembleLine(season, g.week, g.home, g.away, { includeEvidence: false, ...modelOptions })` — blendMode never set
- nfl-ensemble.js:1221 `blendMode = 'raw'` default; :1299 `const margin = blendMode === 'market_residual' ? residualMargin : rawMargin`
- nfl-auto-picks.js:83 `modelOptions = { blendMode: 'market_residual', ...modelOptions }` (live board); nfl-cover-calibration.js:276 same
- nfl-blind-audit.js:283 replaySeason(…) and :284 ensembleLine(… { includeEvidence: false }) both inherit raw
- routes/nfl-betting.js:691 GET /replay never sets blendMode; GET /blind-audits* served to client/src/pages/betting/Training.tsx and Diagnostics.tsx
- nfl_replay_runs has no spec_json/spec_hash columns (cols: id, season, label, created_at, bets, wins, losses, pushes, units, roi, config); 0 rows. nfl_blind_audit_runs 24 rows.

## G06 stale finding aborts the season-end cycle — CONFIRMED (hash mismatch reproduced)
- nfl-candidate-findings.js:209 `assertRuleUnchanged(finding)` sits BEFORE the try at :212-216
- loop :281-284 `holdoutActions.push(recordHoldoutTest(finding, season, config))` — no per-finding try
- nfl-model-growth.js:256 `detail.candidate_findings = runCandidateFindingsForSeasonEnd(season);` bare; :302-307 catch marks the run 'error' and rethrows
- Predicate identity = codeIdentity(['services/nfl-replay.js','services/stats-util.js','services/nfl-policy.js']) (nfl-replay.js:995-1001) — recomputed here: 186 files, complete:false, id af23140b…
- Recomputed segmentRuleHash = bfc269cc8cbd827ecd4bd0a8b24db1c94e99a9beb4c00c15ac06de28180d4b20; stored rule_definition_hash = 4303bbce23f0c7d69a2f93b79c669b37b62f79fad9ffe8f63910543654319085. MISMATCH reproduced.
- Finding 1 state='discovered' with no 2026 season row → it WILL be offered as a 2026 holdout and WILL throw
- Renewal blocked: segment_key UNIQUE (migration 024:31); registerManuallyObservedFinding:125 throws on an existing key; recordDiscoveryFlag:156 returns 'already_past_discovery'
- test/ references runCandidateFindingsForSeasonEnd only at test/nfl-candidate-findings.test.js:174-177, which exercises only the blind-audit-defer early return; recordHoldoutTest is never referenced

## G07 historical CLV/ROI is a beat-the-close exercise — CONFIRMED
- nfl-replay.js:193 `gl.spread AS home_spread`, :203 `AND gl.spread IS NOT NULL`; :227-241 edge = projected_margin − (−home_spread)
- nfl-ensemble.js:1245-1247 open_spread is NULLed for completed games (`CASE WHEN team_score IS NULL THEN open_spread`); :1291 marketMargin = −home_spread; :1293-1295 residual anchor uses that same close
- Disclosure exists only as a source comment (nfl-replay.js:80-91, 108-109). No market_line_basis field anywhere in nfl-replay.js; the /replay route returns none.
- DB (home=1): closing_spread NOT NULL count = 0 for every season 2021-2025 (271/272 for 2026). |spread − open_spread| ≥ 0.5: 2021 255/272, 2022 229/267, 2023 231/285, 2024 203/285, 2025 218/285 → 71-94%, ~80% mean.

## G08 decisions not reproducible — CONFIRMED at P2
- nfl-execution-pipeline.js:136 `dataIdentityStatus: 'unfrozen_live_tables'` hard-coded; no dataHash, no scheduleVersion passed
- nfl-decision-tape.js:358-361 defaults dataIdentityStatus 'unfrozen_live_tables', dataHash null, scheduleVersion null; :372-377 a frozen_packet run REQUIRES a hex64 dataHash and a non-frozen run may not carry one — so the mechanism exists and is simply unfed
- nfl_t60_observations.schedule_version NULL on the live row (scheduler's nfl_t60_runner job, scheduler.js:786-795, passes no scheduleVersion)
- test/nfl-decision-identity-pipeline.test.js:149-150 asserts data_identity_status 'unfrozen_live_tables' and data_hash null
- P2 is right: nfl_decision_runs is empty today, so nothing is presently mis-stated; it is strictly downstream of G01/G02/G03 (no payload to hash, no scheduled tape writer to carry it).
