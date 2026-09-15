# AUDIT_SYSTEM_REVIEW — Gridiron HQ betting audit system, gap analysis

Analyst: gap analyst (synthesis of code readers A01–A05). Date: 2026-09-11.
Repo `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` read-only. DB facts re-checked read-only
via `node:sqlite` `readOnly:true` on `server/data.sqlite` at 22:5x local (live server PID 56651 writing).
Every `path:line` below is either quoted from a reader's notes (A01–A05, same directory) or was re-read by me
with `sed -n`; the load-bearing ones (blend mode, receipt clock, packet hash, ledger writers, findings crash,
overview case bug, registry gate, CLV persistence, T2 weather, ablation label) were re-read tonight, and all of
G01–G31 was re-read again on 2026-09-12 by the verification pass described below.

Re-confirmed live-DB counts (2026-09-11): `nfl_blind_audit_runs` 24 rows (ids 9–32), `nfl_blind_audit_weeks`
with season ≥ 2026: **0**; `nfl_decision_runs` **0**, `nfl_decision_events` **0**, `nfl_execution_opportunities`
**0**, `forward_picks` **0**, `nfl_bet_log` **0**; `nfl_pick_decisions` season 2026: 16; `nfl_t60_observations`:
1 (`frozen`); `nfl_quote_batches.receipt_clock_source`: `legacy_request_time_only` **1,323 / 1,323**;
`nfl_candidate_findings`: 1 row, state `discovered`, hash prefix `4303bbce`; `nfl_feature_revisions` **0**;
`game_lines` 2026 home rows 272, 2 scored (both Week 1).

**Verification status (2026-09-12).** Every P1/P2 gap (G01–G31) was put through an adversarial pass with three
independent verifiers per gap — code truth, standard, materiality — each trying to knock it down. **22 CONFIRMED,
9 REFUTED**, with per-gap reasons and citation corrections in **§3.1** and the refuted nine in **Appendix A**.
§7 has been rebuilt from confirmed gaps only. G32–G37 were not put through the pass and are marked unverified.
Corrections the pass forced on this document: SEA–NE *is* in `nfl_pick_decisions` (written three days after its
final), not absent from every ledger (G03); G12's look-back citations are `:673-680`/`:758-760`; the
forward-ledger half of G10 is already fixed. Two findings the pass added: the injury receipt clock is the
source's own publication time (G31), and the forward provenance verifier's live `flagged_rows` goes 0 → ≥ 8 once
it checks the horizon instead of the kickoff (G24).

---

## 0. Verdict in one paragraph

Gridiron has two audit systems and neither is currently producing admissible betting evidence. The **historical**
system (the sealed blind audit, runs 27/31/32) is chronologically honest and byte-reproducible, but it audits a
forecast that is not served (`blendMode 'raw'` in replay vs `'market_residual'` on the board), grades at the
nflverse closing consensus with closing-time features, and is — by the plan's own §9.2 — development data. The
**forward** system (T-60 packet → decision tape → lifecycle ledger → CLV → findings) is implemented as a set of
well-tested modules that are not wired to each other in production: every live quote batch carries the legacy
request clock so the packet can never admit a price; the runner stores a non-canonical hash and discards the packet;
Week 1 decisions were written to a mutable UPSERT table, not the append-only tape (0 rows); the only ledger with
2026 rows (`shadow_decisions`) captured two finished games as "forward" predictions and grades them against a
column ESPN overwrites in-game; and the single candidate finding is stale in a way that will throw and abort the
2026 season-end learning cycle. (The CLV-persistence complaint in the first draft of this verdict was refuted —
the execution CLV module is a read-only projection over an append-only tape and returns everything the fix asked
to store; see Appendix A, G09.) The −7.1 %/−7.7 % ROI and −2.28 CLV figures cited in the plan are beat-the-close
diagnostics of the raw blend; they are not evidence about the T-60 operation either way. As of tonight the
number of admissible 2026 forward observations is zero.

---

## 1. How the audit system actually works today

Two lanes share code but not data. Arrows are `file:line`.

```
LANE H — HISTORICAL REPLAY (2021–25, weeks 5–18; "THE audit" per plan §1.2; development data per §9.2)

 sources ──────────────► "tape" ─────────► packet ──────────► forecast ───────────► decision
 game_lines.spread        none. quote_at   weekly_input =     ensembleLine(...)      applyNflPolicy(
 = nflverse CLOSE         := gl.fetched_at projection of in-  nfl-replay.js:225      NFL_HISTORICAL_REPLAY_POLICY)
 nfl-replay.js:187-200,   nfl-replay.js:   memory council     → nfl-ensemble.js:1221 nfl-replay.js:212-222
 :193/203                 246              output, not inputs  blendMode DEFAULT      per market, 5 picks/wk
 31 tables hashed, not                     nfl-blind-audit.js: 'raw'; fitEnsemble    nfl-blind-audit.js:284
 made as-of               (frozen by hash: :420-449, :866-869  beforeSeason/Week
 nfl-blind-audit.js:      nfl_injuries,                        :1238, history week<
 :99-152, :141 (fit       nfl_depth… in-                       :1243
 artifacts all_rows)      place mutated)
        │                                                                              │
        ▼                                                                              ▼
 settlement ─────────────► CLV ────────────────► findings ───────────────────────► veto
 unitsFor at stored       none inside replay     season end: nfl-model-growth.js:256  nfl-auto-picks.js:134
 CLOSING price            (closing-line replay)  → nfl-candidate-findings.js:251      promotedFindingVeto:
 nfl-replay.js:80-84      opener regrades are    → analyzeErrors nfl-replay.js:640    SELECT promoted →
 seal: sha result +       labelled non-           (Holm + effect gate + LOSO)          segmentsFor(bet); stale
 chain, BEGIN IMMEDIATE,  executable diagnostics  → nfl_candidate_findings             hash ⇒ NO veto (fail-safe)
 assertFrozen again       nfl-replay.js:93-172    → recordHoldoutTest :207 (throws     0 promoted findings exist
 nfl-blind-audit.js:                              at :209 for the stale finding 1)
 :884-918
        │
        ▼
 overview / compare: nfl-audit-overview.js:35-227 (spread_only.uncertainty fed lower-case results → win_rate_95
 always [0,0] :116/:221; coverage from min–max span :159-170) ; compareAuditRuns :238-272 diffs result_hash.
 look-back: nfl-blind-audit.js:520-643 reads UNFROZEN shadow_decisions :584-585 and nfl_odds_archive /
 nfl_nfelo_games / nfl_external_ratings :485-493 → values enter result_hash → chain_hash.
```

```
LANE F — FORWARD 2026 (what actually ran for Week 1)

 sources ─────────────► tape ──────────────────► packet ─────────────────────► forecast
 free book feeds       ingestQuoteSnapshot       scheduler nfl_t60_runner       autoPickDecisionBoard
 book-feeds.js:417     nfl-quote-tape.js:61-125  scheduler.js:785-799 →         nfl-auto-picks.js:82-83
 line-shopping.js:66   receipt := requestedAt    runT60Pass t60-runner.js:245   blendMode 'market_residual'
 (NO receivedAt)       (:64-65) ⇒ receipt_clock  → freezeT60Packet nfl-t60-     reads MUTABLE tables
 ESPN game_lines       _source = 'legacy…'       packet.js:142-346 → realClock  (data_identity_status
 (spread overwritten   for 1,323/1,323 batches   empty (:214) ⇒ no eligible     'unfrozen_live_tables',
 in-game; closing_     nfl_quote_tape 1.59M rows price → packet_hash ONLY       nfl-execution-pipeline.js:136)
 spread frozen)        nfl_line_snapshots 1.75M  (t60-runner.js:127-129, sha of  packet is NOT an input to
 injuries (modified_   OddsTrader archive open/   JSON.stringify incl. wall clock the board
 at), news (unscoped), close only (odds-archive.  :142) → nfl_t60_observations
 weather, features     js:18)                    (1 row, SF@LAR, no payload col,
                                                  migration 034:33-58)
        │                                                                          │
        ▼                                                                          ▼
 decision (three writers, none the tape) ──────────────────────────────────────► settlement
 (a) scheduler.js:697-703 refreshNflDecisionLedger → persistPickDecisions →        shadow-ledger.js:57-105
     nfl_pick_decisions UPSERT (mutable; 16 rows wk1, policy 1.1.0)                UPDATE in place, close = LIVE
 (b) evidence-daemon.js:125 → shadow-ledger.js:11-50 recordNflShadowBoard →        game_lines.spread (:83)
     shadow_decisions (189 rows; NO kickoff guard :28-31; SEA–NE rows 200/216       forward-ledger.js:136-184
     captured 23 h after final)                                                     UPDATE in place (0 rows)
 (c) t60-runner never records a decision (:245-259)                                nfl-execution-lifecycle.js:
 (d) tape recordDecisionRun nfl-execution-pipeline.js:128 → nfl-decision-tape.js:   320-352 settled event +
     354-489: reachable ONLY from manual route nfl-market.js:323; 0 rows            corrections :381-410 (0 rows)
        │
        ▼
 CLV (four definitions) ─────────────────────────────────────────────────────────► findings / veto
 nfl-execution-clv.js:232-354 declared books (default = ALL incl. own :59),         2026 season end:
   full_game, per-book latest < kickoff, quote ids, grading version — JSON only,     nfl-candidate-findings.js:209
   never persisted; 0 positions                                                      throws outside try; loop
 shadow: decision.line − live spread (:83-84)                                        :280-284 no isolation;
 forward-ledger: ESPN closing_spread, no book (:154-156)                             nfl-model-growth.js:302-307
 beat-the-close.js:266-292: Pinnacle captured_at ≤ kickoff (6 settled, stake 0)      marks run 'error', rethrows
 nfl-clv.js:216-254 legacy single-instant consensus, still scheduled                 → neural/risk/player/council
   scheduler.js:275-278 (0 rows)                                                     settlement skipped
```

**Parallel / duplicate engines (A05 §16, confirmed):**

| Question | Engines answering it today |
|---|---|
| Historical spread ROI 2021–25 | `replaySeason` (nfl-replay.js:177) under: blind audit (nfl-blind-audit.js:284), `trainingIteration` (:856), `candidateInputComparison` (:1031), nfl-experiments.js, nfl-research.js, nfl-family-contribution.js:319, nfl-ai-replay.js:281, nfl-candidate-analysis.js, nfl-abstention-audit.js:111 |
| Family contribution | nfl-family-contribution.js:300 (paired, three scores) **and** nfl-research.js:120-146 (ROI only; asserts a refit that never happens :139-142) |
| Football-first vs close | weekly-walkforward.js:101 (weekly ridge refit) **and** scripts/audit-football-first.mjs:75 (per-season fit) |
| Opener→close move / CLV | line-move-study.js:344 (historical) → beat-the-close.js:200 (live shadow) — intended pair |
| Neural residual | nfl-neural-replay.js:101 (own prequential loop, 0 rows) plus council `deep_residual` |
| Weekly-cluster bootstrap | nfl-replay.js:43 `uncertainty` (drops zero-bet weeks), line-move-study.js:275 `clvSummary`, beat-the-close.js:394 `weeklyRead`, nfl-family-contribution.js:235 `pairedDelta`, backtest-significance.js:57 `pairedBootstrapDiff` — five implementations, at least three RNG regimes |
| "Close" for CLV | nfl-execution-clv.js (per-book latest < kickoff), shadow-ledger.js:83 (live ESPN spread), forward-ledger.js:154 (ESPN closing_spread), nfl-clv.js:97 (single-instant consensus), beat-the-close.js:275 (Pinnacle ≤ kickoff), nfl-replay.js:193 (nflverse consensus) — six closes |
| "T-60" | t60-runner.js observation ledger vs evidence-daemon.js:88-167 T-60m capture window — two unlinked notions |
| Frozen packet schema | nfl-t60-packet.js `sources[]` shape vs betting/nfl/contracts/forecast-packet.js eight-group contract (no producer/consumer, :206) |
| Preregistration | audit_registry (audit-registry.js:79-108) vs nfl_blind_audit_runs spec (nfl-blind-audit.js:186-211) vs nfl_candidate_findings vs beat-the-close `RULES` prose (beat-the-close.js:43-56) — four registers, no trial register |

---

## 2. How it should work

One evidence path; one definition of each quantity; every stage append-only and content-addressed; the
historical replay reduced to an algorithmic-chronology test of the *same* graph.

```
 SOURCES ──► TAPE ──► PACKET ──► FORECAST ──► DECISION ──► SETTLEMENT ──► CLV ──► REGISTER/FINDINGS ──► GATE
 (3 clocks)  (append  (frozen at (pure fn of  (append-only, (separate     (declared  (trial register,    (evidence
             only,    declared   packet +     keyed by      event,        reference, forward-only         recount,
             receipt  cutoff,    fit id,      observation,  finality      persisted  confirmation,        human,
             = resp.  content    same graph   references    basis,        grading    effect + clustered   append-only
             done)    persisted, as served)   packet hash,  corrections   version,   interval, min n,     lifecycle)
                      canonical              abstain/       appended)     quote ids) multiplicity haircut)
                      hash, one              missed/
                      schema)                unavailable
                                             are rows)
```

Principle behind each stage, stated plainly:

1. **Sources carry three clocks** (when the fact became true, when the source published it, when we received
   it). A decision may only use what was *received* before the cutoff. A request timestamp is not a receipt.
2. **The tape is append-only and never interpreted at write time.** Rows are never updated; a corrected quote
   is a new row. The tape is the only thing CLV may read.
3. **The packet is the decision's input, and it is stored.** At the declared cutoff, freeze the exact rows
   (values, not counts) scoped to the game, hash them canonically (no wall clocks inside the hash), persist the
   payload, and validate it against one schema. A hash without content reconstructs nothing.
4. **The forecast is a pure function of (packet, fit artifact).** The fit's cutoff precedes the packet's cutoff.
   The replay and the served board call the identical function with identical options; if a knob exists
   (`blendMode`), it is part of the recorded identity, never a default.
5. **The decision row is immutable and complete.** One row per (observation, game): selected, abstain, missed,
   unavailable. The denominator is the declared schedule, not the rows that happened to be written. Content hash
   covers the board and policy; the observation key covers when and why; the packet hash links input to output.
6. **Settlement is a separate event with a finality basis; corrections are appended deltas.** Reports read net
   units after corrections. The score source is declared. Nothing on the decision row changes.
7. **CLV is one definition, persisted with its grading version.** Reference = declared book set that excludes the
   execution book; period pinned; per-book latest quote strictly before kickoff; point CLV and price CLV (in
   probability space) with quote IDs; missing-close rate is part of the result. New evidence ⇒ new grading version,
   old one retained. CLV is supporting evidence, not profit.
8. **Every trial is registered before it is scored.** Models, thresholds, segments, family ablations, signal rules:
   one register, one row per attempt, including failures. Discovery happens on development data; confirmation
   happens only on data that did not exist when the rule was written (2026+). Confirmation needs an effect size,
   a weekly-clustered interval retaining zero-bet weeks, and a minimum matching count — not a directional flip.
9. **Provenance is narrow and versioned.** A rule's identity hashes the rule, not the database layer. A stale rule
   is isolated, recorded as stale, and can be renewed under a new version that starts with zero evidence.
10. **Inference is pre-declared.** Fixed review endpoints; if sequential, σ and τ declared from development data
    before the season, one p-value per hypothesis, alpha-spending declared. Multiplicity across the search is
    charged (Holm within a family, deflated-Sharpe/PBO across the model search).
11. **The historical replay is labelled development.** It exists to prove the algorithm is chronological and to
    develop candidates, using as-of (bitemporal) inputs where they exist and disclosing where they do not. It
    grants no betting authority.

---

## 3. Gap table

Severity: P1 = forward evidence cannot be produced or is corrupted; P2 = evidence is produced but mis-measured,
mis-labelled or unreproducible; P3 = hygiene / latent.

This table now holds **only the 22 confirmed gaps** plus the six unverified P3s; the nine refuted rows were moved
verbatim to Appendix A. Verdicts, corrections and narrowings are in §3.1 immediately after the table, and they
override any cell above them.

| id | sev | gap | current (path:line) | should be | evidence | fix (file · function · table · test) |
|---|---|---|---|---|---|---|
| G01 | P1 | Forward packet is price-blind: the only prospective-capable source can never be admitted | `book-feeds.js:417` and `line-shopping.js:66` call `ingestQuoteSnapshot` with `requestedAt` only; `nfl-quote-tape.js:64-65` defaults `clockSource` to `legacy_request_time_only`; `nfl-t60-packet.js:214-216` grants `received_by_cutoff` only to `response_completion` | Receipt = response-completion timestamp on every live batch; packet admits real quotes | DB: 1,323/1,323 batches legacy; SF@LAR frozen packet has no eligible price (A04 headline 3) | `book-feeds.js` `captureBookFeeds`: stamp `receivedAt = new Date().toISOString()` after the awaits and pass it; same in `line-shopping.js`; test `nfl-quote-tape.test`: live-feed batch ⇒ `response_completion`; `nfl-t60-packet.test`: a free-feed quote reaches `received_by_cutoff` |
| G02 | P1 | Frozen packet content is discarded; hash is non-canonical and embeds a wall clock | `t60-runner.js:127-129` stores `packet_hash` only; `:142` `sha256(JSON.stringify(packet))`; packet embeds `computation_started_at` (`nfl-t60-packet.js:332`); migration 034:33-58 has no payload column; `runT60Pass :249-258` drops `captured[].packet`; canonical `packetHash`/validator in `forecast-packet.js:193-227` unused (`:206`, grep: test only) | Persist payload; canonical sorted-key hash excluding clocks/attempt; validate against the one contract before sealing | A04 §t60-runner P1/P2; plan §4.1 "a hash without retained content cannot reconstruct a decision" | migration 035: `ALTER TABLE nfl_t60_observations ADD packet_json TEXT`; `t60-runner.captureDueObservations` → `validateForecastPacket` + `forecast-packet.packetHash`; emit contract shape from `freezeT60Packet`; test: re-freeze identical fixture ⇒ identical hash; read back validates |
| G03 | P1 | Week 1 decisions are not on the append-only tape; runner never records a decision | `scheduler.js:697-703` `persistPickDecisions` → `nfl_pick_decisions` UPSERT; `t60-runner.js:245-259` open/capture/missed only; `recordDecisionRun` reachable only from manual `nfl-execution-pipeline.js:128` / route `nfl-market.js:323` | Every observation (game × cutoff) yields exactly one immutable tape run (selected/abstain/missed/unavailable) linked to its packet hash | DB: `nfl_decision_runs` 0, `nfl_pick_decisions` 16 rows wk1; SEA–NE absent from every ledger (A03 §13) | `t60-runner.captureDueObservations`: after freeze call `autoPickDecisionBoard(season, week, policy, {packet})` → `recordDecisionRun(..., {observation:{observationId: obs.id, cutoffAt}, dataIdentityStatus:'frozen_packet', dataHash: packet_hash})`; `markMissedObservations` → tape run `unavailable`; scheduler job writes tape then materialises `nfl_pick_decisions` as a cache; test: `runT60Pass` on 16-game fixture ⇒ 16 tape runs |
| G04 | P1 | Shadow ledger records finished games as forward predictions and settles them | `shadow-ledger.js:28-31` existence check by `(event_key, market, model_version)`, no kickoff/score guard; policy bump ⇒ new `model_version` re-records | Refuse capture at/after kickoff or when a score exists; quarantine existing post-kickoff rows via an invalidation row, not a delete | Live rows 200/216 `2026:1:SEA:NE` captured `2026-09-10T23:36Z`, kickoff `00:20Z`, final 13-10, settled Push clv 0 (A03 D15) | `shadow-ledger.recordNflShadowBoard`: `if (game.team_score != null \|\| now >= nflKickoffDate(...)) skip`; add `shadow_decision_invalidations` (or migrate shadow to tape role `shadow`); test: finished-game fixture refused; `validationFirewall().forward` excludes invalidated rows |
| G05 | P1 | Historical audit grades a forecast that is not served | `nfl-replay.js:225` `ensembleLine(..., {includeEvidence:false, ...modelOptions})` never sets `blendMode`; `nfl-ensemble.js:1221` default `'raw'`; `nfl-auto-picks.js:83` forces `'market_residual'`; blind audit inherits at `nfl-blind-audit.js:284` | Replay and board call one function with an explicit, recorded `blendMode`; spec_json carries it; runs 27/32 relabelled "raw blend" | A05 §1 P1; no test asserts replay blend | `nfl-replay.replaySeason`: require `modelOptions.blendMode` (throw if absent) and echo it in `policy`; `nfl-blind-audit.normalizeSpec`: `blendMode` mandatory, in `spec_hash`; new blind run with `market_residual`; test `nfl-replay-graph.test`: replay options ⊇ served options |
| G06 | P1 | Stale finding will abort the 2026 season-end learning cycle; cannot be renewed | `nfl-candidate-findings.js:209` `assertRuleUnchanged` outside `try`; loop `:280-284` no per-finding isolation; `nfl-model-growth.js:256` bare call, `:302-307` marks run `error` and rethrows; `segment_key` UNIQUE (024:31); identity = 186-file closure (`:49`, `code-identity.js`) | Per-finding isolation; stale ⇒ recorded `stale` row and skipped; versioned `(segment_key, rule_version)`; identity = declared manifest of the predicate files | DB finding 1 hash `4303bbce…` ≠ recomputed `bfc269cc…` (A02); nothing tests `recordHoldoutTest` | `runCandidateFindingsForSeasonEnd`: wrap each `recordHoldoutTest` in try, write `nfl_candidate_finding_events(kind='stale')`; migration: drop UNIQUE on `segment_key`, add UNIQUE `(segment_key, rule_version)`; `segmentRuleHash`: hash `segmentsFor` + bucket helpers only; test: stale finding + healthy finding ⇒ cycle completes, one stale event, one holdout row |
| G07 | P1 | The cited historical CLV/ROI are beat-the-close numbers with closing-time features | `nfl-replay.js:193/203` market = `game_lines.spread` (nflverse close, `closing_spread` NULL); `nfl-ensemble.js:1317` market-residual anchor consumes the same close; disclosed `nfl-replay.js:83-91, 108-109` | Historical evaluation at a declared decision time uses only lines received before that time, or is labelled "closing-line diagnostic, not decision-time" in every report and summary | A04 headline 6: spread ≠ open_spread by ≥0.5 in ~80 % of games/season | `nfl-replay.replaySeason`: add `market_line_basis:'closing_consensus_not_decision_time'` to `summary` and to `nfl_blind_audit_runs.final_json`; plan §1.2 table footnote; no code can fix the data — only the OddsTrader archive opener (`nfl_odds_archive`) or 2026 tape gives decision-time lines |
| G08 | P2 | Decisions are not reproducible from stored inputs; packet is never linked | `nfl-execution-pipeline.js:136` hard-codes `dataIdentityStatus:'unfrozen_live_tables'`, `data_hash` NULL; `schedule_version` never passed (`nfl-decision-tape.js:361`); `nfl_t60_observations.schedule_version` NULL | Tape run carries `data_hash = packet_hash`, `data_identity_status='frozen_packet'`, `schedule_version` | A03 D2, §12.5 | covered by G02/G03 wiring; `openObservations` pass `scheduleVersion` from `game_lines` revision; test: tape run `data_hash` equals observation `packet_hash` |
| G10 | P2 | Shadow/forward settlement overwrites the decision row; shadow close is the in-game-mutable column | `shadow-ledger.js:99-100` UPDATE; `:83` `game.spread`; `forward-ledger.js:179-181` UPDATE where `result IS NULL` (`:137`) | Settlement as appended event with finality basis; close = frozen `closing_spread`; corrections appended | A03 D13/D16/D17; `forward-ledger.js:149-156` already explains why | Retire both writers into `nfl-execution-lifecycle.settleOpportunity` (tape-linked); interim: `shadow-ledger.settleNflShadowDecisions` use `closing_spread ?? spread` and write `shadow_settlements` rows; test: score correction produces a second settlement row |
| G12 | P2 | Blind-audit freeze scope inverted: hashes what it doesn't read, reads what it doesn't hash | `nfl-blind-audit.js:485-493` (`nfl_odds_archive`, `nfl_nfelo_games`, `nfl_external_ratings`) and `:584-585` (`shadow_decisions`) unfrozen but enter `result_hash`; `:141-147` no scope branch ⇒ `nfl_ensemble_fit_artifacts` hashed `all_rows` though `withEphemeralEnsembleArtifacts` (nfl-ensemble.js:951-962, :993-995) never reads it | Freeze exactly the read set; look-back reads either frozen or excluded from the hashed result | run 21 died on `nfl_ensemble_fit_artifacts`, run 28 on `nfl_teams` (A01 B1/B2) | `INPUT_TABLES`: add the four look-back tables (season-scoped) and drop `nfl_ensemble_fit_artifacts`; or move `lookback` out of `result_json` into a side column excluded from `result_hash`; test: persisting a live fit does not void a running audit |
| G14 | P2 | Overview: win-rate interval always `[0,0]`, coverage cannot see a truncated run, missing units become 0 | `nfl-audit-overview.js:116` lower-cases results; `:221` passes them to `uncertainty()` which matches `'Won'/'Lost'` (`nfl-replay.js:44`); `:159-170` expected = min..max observed; `:125` `units: pick.units ?? 0`; `:135` roi denominator includes voids/unknown | Interval on graded results; coverage vs `spec_json.schedule` (loaded `:36`, unused); missing units excluded from units and denominator, counted separately | A01 O1–O4; test never asserts `win_rate_95` | `auditOverview`: map to canonical `'Won'/'Lost'` before `uncertainty`; `seasonCoverage` from `spec.schedule`; `roi = units / units_known_bets`; tests `audit-overview-counting.test`: truncated run ⇒ `coverage_complete:false`; run-27 `win_rate_95` ≠ `[0,0]` |
| G15 | P2 | Weekly-cluster bootstrap omits zero-bet weeks; five bootstrap implementations | `nfl-replay.js:43-50` clusters built from bets only; reused by `nfl-neural-replay.js:97`, segment gate `:668`, overview `:221` | One `clusteredBootstrap(rows, {weeks: declaredWeekSet})` where declared weeks with no bets contribute 0 units; ROI per bet and P&L per week both reported | plan §9.2 "complete zero-bet weeks retained"; C09 | `stats-util.js` new `weeklyClusterBootstrap(bets, weeks, {seed})`; `uncertainty(bets, {weeks})` delegates; replace `clvSummary`/`weeklyRead`/`pairedDelta` internals; test: adding an empty week widens the ROI-per-week interval |
| G17 | P2 | Registry gate collapses the C17 relabel and mixes two corrections; alpha depends on run order | `audit-registry.js:219` `p_always_valid ?? p_fixed_sample_only`; `:200-201`,`:220` mSPRT p vs Šidák alpha; `:197-198` `COUNT(sealed)` at run time vs `auditHistory :282-286` final n; `dataSignature :62-71` six row counts | Gate on `p_always_valid` only when σ was declared; fixed-sample p gets Šidák, sequential p gets its own α; family size declared at preregistration | DB: `always_valid_p` NULL on all 15 rows; 5 `require_significance` audits all `passed=0` (A02) | `runAudit`: `alwaysValidSignificant = av.anytime_valid ? av.p_always_valid < alpha_seq : null`; store `family_size_declared` in `preregister`; test: plug-in σ never satisfies `require_significance` |
| G18 | P2 | Findings holdout is a coin flip; development seasons not fenced; promotion trusts a column | `nfl-candidate-findings.js:218` `passed = helped_holdout === true` (ROI-without > ROI-with, `nfl-replay.js:~815`); `:208` role fence per finding only; `routes/nfl-betting.js:232` body.season; `:369` state check only; tests reach promotion by `UPDATE` (test 104,116,158,221) | Holdout seasons must be > 2025 and > max discovery season; pass requires declared effect (MIN_EFFECT_ROI), weekly-clustered interval excluding 0, min matching bets; promotion recounts evidence rows | A02 P2 ×4; P(3 false passes \| null) ≈ 12.5 % | `recordHoldoutTest`: `if (season <= DEVELOPMENT_SEASON_MAX) throw`; compute `uncertainty` on matching bets; `promoteFindingToShrink`: recount `nfl_candidate_finding_seasons` (≥3 pass, 0 fail, all > discovery); add `nfl_candidate_finding_events` append-only; tests for each |
| G20 | P2 | Line-move study passed signals rest on leaked/unverified features | `line-move-study.js:197` T2 = actual kickoff-hour weather ("the actual hour stands in for a Friday forecast"); `:132` `fitModel()` hyperparameters selected through `lastSeason-1` (nfl-market.js:130) = inside 2024–25 holdout; `:218-220` nfelo/TeamRankings backfilled outputs treated as T0-knowable | Only features received before each T-stamp; ratings selection window < holdout start; nfelo availability verified per date or labelled unverified in the passed-signal basis | A05 §9; beat-the-close.js:52-53 already shows +0.47 → +0.28 on the knowable forecast | `buildLineMoveDataset`: drop `T2.wind_kmh/precip/cold` from actual weather (keep forecast-history version); default `selectionThrough = holdoutStart-1`; add `feature_availability_basis` per feature; test: no feature with `source_time > stamp` |
| G22 | P2 | Packet sources are counts, news unscoped, injuries by week; contract unwired | `nfl-t60-packet.js:264-270` no WHERE on news; `:250-255` injuries season/week; values only for tape `:240-243`; `forecast-packet.js:206` no producer/consumer | Every source scoped to event/team/player with rows persisted; one schema | A04 P2; test 131-139 asserts the defect | `freezeT60Packet`: scope news by team/player ids, injuries by team, persist rows; emit `forecast-packet` shape; flip test 131-139; C11 close-with |
| G23 | P2 | `missed` unreachable through the durable pass; no acceptance window | `t60-runner.js:249` capture `cutoff_at <= now` unbounded, then `:250` mark missed; `graceMinutes` dead on that path | Capture only within `[cutoff, cutoff+grace]`; older ⇒ `missed` tape run | A04; test 74-83 tests `markMissedObservations` alone | `captureDueObservations`: `AND cutoff_at >= now - grace`; order missed before capture; test: 3-hour outage ⇒ missed rows |
| G24 | P2 | Provenance verifier checks kickoff, not the horizon cutoff | `nfl-evidence-provenance.js:4-5, 54` `evidence_cutoff` = kickoff | Verify against the row's own horizon cutoff (T-60) | A04 | pass `cutoffAt` from the observation; test: T-15 evidence in a T-60 row flagged |
| G26 | P2 | No trial register: attempted segments, thresholds, models, signals are uncounted | `nfl-replay.js:691` Holm covers one `analyzeErrors` call; segments below `minBets` leave no row; family configs, RULES, ai-replay, walk-forward variants never registered | One `research_trials` table with every attempt (identity, declared_at, result, status) feeding the multiplicity haircut | plan §9.2 "count every attempted model, threshold, family connection and segment definition" | migration `research_trials(kind, identity_hash, declared_at, scored_at, metric, value, status)`; hooks in `analyzeErrors`, `familyContributionReport`, `lineMoveStudy`, `audit-registry.preregister`; report `trials_counted` on every summary; test |
| G29 | P2 | Migration 027 `down()` drops the tape | `027_decision_tape.js:359-369` unconditional DROP; 031 guard only for non-legacy runs (`:245-254`) | Refuse destructive downgrade when any run exists | A03 D4; C03 | `027.down`: `if (count(nfl_decision_runs) > 0) throw`; test |
| G30 | P2 | Legacy CLV and three other "close" definitions still scheduled/served | `scheduler.js:275-278` runs `gradeClosingLineValue` (nfl-clv.js:216-254, single-instant consensus, no period); shadow/forward/beat-the-close closes differ | One close definition (G09) consumed by every ledger | A03 D11/D14/D16 | unschedule and delete `nfl-clv.js`; shadow/forward/beat-the-close read `nfl_clv_grades`; test: one CLV per (decision, grading_version) |
| G31 | P2 | Bitemporal store exists but is never fed; every injury/news read is latest-value | `nfl-bitemporal.js` correct; `nfl_feature_revisions` 0 rows; packet gates injuries on `modified_at` (`nfl-t60-packet.js:250`) | Injury/news ingest appends revisions; packet reads by `observed_at <= cutoff` | A04; A01 §6.1 (79k in-place injury UPDATEs) | `nfl-injuries` sync → `recordFeatureRevision`; packet reads via `bitemporalValueAt`; test: revised value after cutoff not visible |
| G32 | P3 | Two kickoff clocks (fixed −04:00 vs DST-correct) | `nfl-t60-packet.js:378, 434` vs `t60-runner.js:51` `nflKickoffDate` | One `nflKickoffDate` | A04 | replace string concat; test a November game |
| G33 | P3 | Blind-audit lifecycle states without a controlled writer; `allowDirty` from HTTP body; silent week clamp | `nfl-blind-audit.js:847, 923-932, 157-158, 186`; `routes/nfl-betting.js:398` | Explicit `cancelBlindAudit`; `allowDirty` CLI-only; clamp ⇒ error | A01 B5–B7 | small edits + tests |
| G34 | P3 | Latent whole-season cutoff when `gameday` is NULL | `nfl-expert-council.js:453` string `${season}-W${week}-pregame` sorts after every ISO stamp | Throw on NULL gameday | 0 NULLs today (A01 B4) | guard + test |
| G35 | P3 | AI-replay candidate cache keyed by season + hand-bumped version | `nfl-ai-replay.js:278` | key by code/policy/data identity | latent (empty) | add `code_hash` + policy id to key |
| G36 | P3 | Content hash includes observation fields | `nfl-decision-tape.js:184-203` `horizon`, `cutoff_at` in content hash | pure content address | A03 D1 | move to observation key; test |
| G37 | P3 | Neural replay and walk-forward grade at the close silently / at assumed −110 | `nfl-neural-replay.js:104`; `weekly-walkforward.js:42`; `scripts/audit-football-first.mjs:41` | disclosure string + stored price | A05 | add `market_line_basis`, use `spread_odds` |

### 3.1 Verification verdicts (adversarial pass, 2026-09-12)

Every P1/P2 gap above (G01–G31) was re-read by three independent adversarial verifiers, each trying to knock it
down on a different leg: **code truth** (do the cited lines say what the gap claims?), **standard** (is the
"should be" a real requirement, or an opinion?), and **materiality** (does any number Nick reads, or any decision
the system takes, actually change?). A gap is **CONFIRMED** when all three legs stand; it is **REFUTED** when a
verifier knocked down the leg that makes it actionable — in every refuted case that was the materiality leg, and
in every refuted case the code reading itself survived as a P3/latent note. Refuted gaps are not deleted: they
move to **Appendix A** with the reason, so the finding is recoverable if its preconditions change.
G32–G37 (P3) were **not put through this pass** and are marked unverified; they are excluded from §7.

Where a verifier corrected a citation or narrowed a claim, the correction is stated here and overrides the row above.

| id | verdict | verifier's one-line reason (corrections override §3) |
|---|---|---|
| G01 | **CONFIRMED** | All three legs stand: 1,323/1,323 live batches carry `legacy_request_time_only`, the only `response_completion` producer (`nfl-quote-tape.js:127-137`) is reachable solely from a manual route, and `nfl-t60-packet.js:214-216` admits nothing else — zero eligible prices have ever existed. |
| G02 | **CONFIRMED** | `t60-runner.js:127-129` writes only the hash; `:141-143` hashes `JSON.stringify` including `computation_started_at` (`nfl-t60-packet.js:332`), so re-freezing identical evidence yields a different hash; the canonical `packetHash`/validator (`forecast-packet.js:174-217`) has exactly one importer, a test. |
| G03 | **CONFIRMED** (one evidence line corrected) | `nfl_decision_runs`/`nfl_decision_events` are 0 and the only tape writer is a manual route. **Correction:** "SEA–NE is absent from every ledger" is false — it is one of the 16 `nfl_pick_decisions` rows, `recorded_at` 2026-09-12T05:36Z, i.e. three days after its final; it is absent from the T-60 ledger and the tape. |
| G04 | **CONFIRMED** (materiality nuanced) | `shadow-ledger.js:28-31` has no kickoff/score guard and rows 200/216 were captured 23 h after final. **Nuance:** those rows are `abstain`, which `validationFirewall` (`nfl-evidence.js:114-123`) does not count — but `shadowLedgerSummary` (:105-121) does and is surfaced at `model-intelligence.js:117`, and the next policy bump over an *eligible* finished game writes `observe` straight into the forward gate. |
| G05 | **CONFIRMED** | `nfl-replay.js:225` never sets `blendMode`; default `'raw'` (`nfl-ensemble.js:1221`, branch `:1299`) vs the board's forced `'market_residual'` (`nfl-auto-picks.js:83`). `nfl_replay_runs` has no `spec_json` column, so the difference is recorded nowhere. |
| G06 | **CONFIRMED** (mismatch reproduced) | `assertRuleUnchanged` at `:209` sits before the try at `:212`; the loop has no per-finding isolation; `nfl-model-growth.js:302-307` marks the run `error` and rethrows. The hash mismatch was independently reproduced: stored `4303bbce…` vs recomputed `bfc269cc…`; renewal is blocked by `segment_key` UNIQUE (024:31). |
| G07 | **CONFIRMED** (code and data) | `closing_spread` is NULL on every 2021–25 home row, so the replay's market is necessarily the nflverse close, and `nfl-ensemble.js:1293-1295` anchors market-residual on it; `abs(close − opener) ≥ 0.5` on 71–94 % of games (~80 % mean), so the distinction is not cosmetic. |
| G08 | **CONFIRMED at P2** | `nfl-execution-pipeline.js:136` hard-codes `dataIdentityStatus:'unfrozen_live_tables'` and passes no `dataHash`/`scheduleVersion`, while `nfl-decision-tape.js:372-377` already implements the frozen-packet branch — the mechanism exists and is unfed. Strictly downstream of G01–G03; 0 rows today, so nothing is presently mis-stated. |
| G10 | **CONFIRMED** (shadow half) | `gamescript.js:219-223` overwrites `game_lines.spread` on every scoreboard poll while `:226-229` writes `closing_spread` only pre-kickoff; `shadow-ledger.js:71-72` does not even select `closing_spread` and `:83` reads the mutable column. **Narrowing:** the forward half is already fixed (`forward-ledger.js:154` prefers `closing_spread`) and moot at 0 rows; correction-as-append is latent, not active. |
| G12 | **CONFIRMED** (citations corrected) | **Correction:** the three external tables are read at `nfl-blind-audit.js:673-680` and `shadow_decisions` at `:758-760` (not `:485-493`/`:584-585`); `INPUT_TABLES` is `:40-51`. It has already cost completed work — runs 25 and 28 were killed by the over-freeze of `nfl_ensemble_fit_artifacts`. The `shadow_decisions` leg is inert for 2021–25 runs; the live hazard is the three line tables. |
| G14 | **CONFIRMED** (all four sub-claims) | `:116` lower-cases `pick.result` and `:125` feeds it to `uncertainty()`, which matches `'Won'/'Lost'` exactly — run 32 stores `'Won'/'Lost'`, so `win_rate_95` is `[0,0]` on a live endpoint (`routes/nfl-betting.js:385`). Coverage from observed min–max lets run 28 (dead at 22 of 70 weeks) self-certify `coverage_complete`; `spec_json.schedule` is loaded and never read. |
| G15 | **CONFIRMED** (magnitude modest) | Five independent weekly bootstraps exist and none can see a declared-but-empty week. **Narrowing:** for ROI-per-bet the omission is near-neutral in expectation; the sharp defect is the missing eligible-week denominator — and the interval it produces feeds the segment effect gate (`nfl-replay.js:668-672`) and rule retirement (`beat-the-close.js:417-430`). |
| G17 | **CONFIRMED** (narrowed) | **Narrowing:** the relabel collapse is true of the persisted column and `auditHistory` only — `runAudit`'s return (`:253-262`) keeps `p_always_valid`/`p_fixed_sample_only`/`variance_source` apart — and the Šidák-α-on-mSPRT-p mix is conservative, so it can never manufacture a pass. What survives: stored `passed` depends on how many audits happened to be sealed when it ran (`:197-198` vs `:286`), contradicting the module's own "criterion before the number" promise. |
| G18 | **CONFIRMED** | `passed = helped_holdout === true` resolves to `nfl-replay.js:811`, a strict ROI inequality on one season with no effect size, interval or minimum n; three such flips reach `flagged_for_review`, the state a human promotes into a live veto. The season fence forbids only the same season in both roles, and `routes/nfl-betting.js:229-235` takes the season from the request body. |
| G20 | **CONFIRMED** (strongest study claim) | `selectionThrough` is never passed (`line-move-study.js:132`; `report-cache.js:61` calls with `[{}]`), so `nfl-market.js:130` selects α/carryover through 2025 — inside the 2024–25 holdout — for `ratings_vs_open`, the signal promoted to a live rule. T2 weather is the realised kickoff hour (the project already measured the drop, +0.47 → +0.28). **Narrowing:** TeamRankings is date-verified; only nfelo lacks per-date availability. |
| G22 | **CONFIRMED** | `nfl-t60-packet.js:264-270` issues the news query with no WHERE clause at all, and `test/nfl-t60-packet.test.js:131-139` pins that behaviour; injuries are season/week only. No forecast consumes the packet, so no bet changes — but the packet is the record of what was knowable, and `decisionTimeManifest` aggregates these per-game claims. |
| G23 | **CONFIRMED** (live proof) | `captureDueObservations` selects `cutoff_at <= now` with no upper bound, so `markMissedObservations` finds nothing and `graceMinutes` is dead on the durable path. The single live observation was captured 2m32s after its cutoff and stored `frozen`; nothing bounds how late that can be, so `captured_rate` would read 100 % through a collector outage. |
| G24 | **CONFIRMED** (highest forward materiality) | `evidence_cutoff` is the kickoff for all seven horizons (`nfl-expert-council.js:654, :688`), and the verifier re-ran the module's own `collectTimestamps` against each row's own horizon cutoff: 8 of 155 stamped rows carry a late stamp (T-24h 3, T-6h 3, T-60m 1, T-15m 1) that the verdict string today calls clean. |
| G26 | **CONFIRMED** (material) | `nfl-replay.js:670` discards every attempted segment below `minBets` *before* the Holm family is assembled at `:691`, so the correction is applied to survivors only; three unlinked Holm families exist (`nfl-replay.js:691`, `line-move-study.js:406`, `nfl-passing-specialists.js:226`); grep for `research_trials`/PBO/deflated-Sharpe returns zero hits in server, test and docs. Which segments survive is a decision input, not prose. |
| G29 | **CONFIRMED** (latent) | `027_decision_tape.js:359-369` drops both tape tables unconditionally while its own guards (`:263-282`) count only the execution ledger; `031`'s guard passes a legacy-only tape straight through. Reachable in production via `npm run db:rollback` against the live file (8 successive invocations). 0 rows today. |
| G30 | **CONFIRMED** (already realised in the data) | Four live definitions verified. Of 14 settled `shadow_decisions`, 6 carry a Pinnacle close and 8 the `game_lines.spread` close, and `shadowLedgerSummary`/`nfl-profitability` average `clv_points` across both. Additional finding: `shadow-ledger.js:58-59` selects unsettled rows with no `model_version` filter, so `nfl-model-growth` can settle beat-the-close rows with the ESPN spread before `beat_the_close` reaches them. |
| G31 | **CONFIRMED** (worse than stated) | `nfl_feature_revisions` is an empty, correctly-triggered table whose only writer is a test. Additional finding: the packet's injury receipt clock is `modified_at`, which `nfl-advanced.js:306-311` writes from the CSV's own `date_modified` — a *publication* clock — and that clock grants `received_by_cutoff`, the one claim a prospective packet may rest on. |
| G09, G11, G13, G16, G19, G21, G25, G27, G28 | **REFUTED** | See Appendix A. In each case the code reading stands but the gap as written is not actionable: nothing a person reads or the system decides changes today. |
| G32–G37 | *unverified* | Not put through the adversarial pass; excluded from §7 until they are. |

§6 (keep/merge/delete) still cites refuted ids in places — read those rows against Appendix A.

---

## 4. Leakage audit — every place the historical replay (and the forward lane) could see the future

Verdict vocabulary: **leaks** (future or post-decision information demonstrably enters), **guarded at path:line**,
**unknown** (cannot be adjudicated from code alone).

| # | Place | Verdict | Evidence |
|---|---|---|---|
| L01 | Ensemble fit cutoff per replay week | guarded at `nfl-ensemble.js:1238` (`fitEnsemble({beforeSeason, beforeWeek})`), history filter `:1243` `season<S OR (season=S AND week<W)` | A01 §Time semantics; A05 §17 |
| L02 | Cover calibration training set | guarded at `nfl-ensemble.js:831-832, 1011` (`train = season < min(evalFrom, beforeSeason)`) | A01 |
| L03 | Team-week features | guarded by `week <` at `nfl-ensemble.js:261-262`; **content unknown** — if a row's value was recomputed with later data (feature backfill) the filter is cosmetic (C07) | A01 §6.3 |
| L04 | Coordinator / neural-residual training inside the audit | guarded at `nfl-expert-coordinator.js:258-260` (`audit_run_id=? AND week<`), `nfl-expert-council.js:279-282` | A01 |
| L05 | Forward predictions mixed into audit training | guarded at `nfl-expert-coordinator.js:261-265` (excluded when `auditRunId` set) | A01 |
| L06 | Market line for historical replay | **leaks relative to decision time** (not relative to outcome): `nfl-replay.js:193/203` uses nflverse closing consensus; `nfl-ensemble.js:1317` anchors the market-residual family on the same close; disclosed `nfl-replay.js:83-91` | A04 headline 6; A05 §1 |
| L07 | Opener inside ensemble context for completed games | guarded at `nfl-ensemble.js:1247` (`CASE WHEN team_score IS NULL THEN open_spread END`) | A05 §17 |
| L08 | In-place mutated week-keyed tables (`nfl_injuries` 79k, `nfl_depth` 342k, `nfl_snaps` 253k, `player_week_usage` 122k UPDATEs since 2026-09-02) | **unknown, likely leaks value-as-of**: a week-N row holds its latest value; freeze hash proves sameness since preregistration, not availability at week N; `nfl_feature_revisions` has 0 rows so no as-of read exists | A01 §6.1; A04 §bitemporal; schema `nfl-a-to-m.js:660` |
| L09 | `weekly_ensemble_fits` hashed `through_season<=2025`; `nfl_pfr_adv`/`nfl_ngs` season-level | **unknown** (C04/C07): whether a 2021 replay week consumes a through-2025 fit or a season aggregate was not verified by any reader (`weekly-weight-store.js`, `weekly-learning.js`, `nfl-engine-registry.js` out of scope) | A01 §6.2, `nfl-blind-audit.js:139-140` |
| L10 | Expert-council evidence cutoff | guarded at `nfl-expert-council.js:451-455` (kickoff from `game_lines.gameday/gametime`); **latent leak** when `gameday` NULL (`:453` string cutoff sorts after every ISO stamp); 0 NULLs 2021–26 today | A01 B4 |
| L11 | Segment news/injury cutoff in `analyzeErrors` | guarded at `nfl-replay.js:607-616` (week-first-kickoff cutoff, conservative) | A05 §1 |
| L12 | Look-back reads of `shadow_decisions`, `nfl_odds_archive`, `nfl_nfelo_games`, `nfl_external_ratings` | not an outcome leak (same-week rows) but **hash contamination**: unfrozen values enter `result_hash`/`chain_hash` (`nfl-blind-audit.js:485-493, 584-585`) | A01 B1 |
| L13 | Cross-run example pooling outside the audit | chronological (`week<`) but code-version-mixed (`nfl-expert-coordinator.js:254-257`); guarded within the audit | A01 §6.5 |
| L14 | Candidate-findings holdout on development seasons | **leaks by design**: a finding flagged on 2021/22 may use 2023–25 as "holdout" although those seasons were fitted/tuned/inspected (`nfl-candidate-findings.js:208`; `routes/nfl-betting.js:232` accepts `body.season`); the manual path locks all five seasons for exactly this reason (`:122-139`) | A02 P2 |
| L15 | Holdout replay fits | inherits L09 (`replaySeason(season)` fits may be later-cutoff, `nfl-candidate-findings.js:214`) — **unknown** | A02 |
| L16 | Specialist audit coordinator fit | **leaks (in-sample)**: `fitExpertCoordinator(9999, 1, {auditRunId})` at `nfl-specialist-audit.js:109` trains on every audited row while the comment calls it walk-forward; diagnostic only | A02 P3 |
| L17 | `historicalReliabilityReplay` | guarded within replay (`nfl-candidate-analysis.js:96-102` appends after each week) but consumes L09-dependent margins — **unknown** | A02 |
| L18 | Line-move study T2 weather | **leaks**: `line-move-study.js:197-201` actual kickoff-hour weather stamped as Friday T2 | A05 §9 |
| L19 | Line-move study ratings hyperparameters | **leaks into holdout**: `:132` `fitModel()` selects through `lastSeason-1` (`nfl-market.js:130`) = 2024, inside the 2024–25 holdout unless `selectionThrough` passed | A05 §9 |
| L20 | nfelo pre-regression line / TeamRankings as T0/T1 features | **unknown**: third-party backfilled model outputs; historical availability unverified (plan line 559); basis of the only +CLV signal | A05 §9 |
| L21 | Neural replay | guarded (prequential: `nfl-neural-replay.js:165-173` updates after the week); graph = all-inputs (`includeChallengers:true`), unlabelled | A05 §5 |
| L22 | Fantasy weekly backtest hyperparameters | **leaks (fantasy only)**: `weekly-backtest.js:90-91, 135` global constants fitted over the same seasons | A05 §7 |
| L23 | AI-replay candidate cache | latent fail-open (`nfl-ai-replay.js:278` keyed season+CACHE_VERSION); cache empty | A05 §4 |
| L24 | AI-replay packet injuries | **unknown**: `nfl_injuries` by season/week, no publication timestamp (`nfl-ai-replay.js:114-198`); disclosed research-only | A05 §4 |
| L25 | Beat-the-close settlement | guarded: Pinnacle `captured_at <= kickoff`, post-kickoff prints excluded (`beat-the-close.js:275-277`, test L77-78) | A05 §10 |
| L26 | Beat-the-close live "opener" | not a future leak but a **reference mismatch**: first live capture (`:79-82`) vs study's archive opener | A05 §10 |
| L27 | OddsTrader archive "close" rows | 9,785/~67,000 stamped after `commence_time`; a `captured_at`-bounded T-60 reader sees the close only for lines that stopped moving early — **selection effect**, guarded only when used as a post-kickoff close | A04 headline 5; `odds-archive.js:18` |
| L28 | Shadow ledger capture (forward lane) | **leaks**: no kickoff guard (`shadow-ledger.js:28-31`); rows 200/216 captured 23 h after final | A03 D15 |
| L29 | Shadow / forward "close" | shadow uses live `game_lines.spread` (in-game mutable) `:83`; forward uses frozen `closing_spread` `forward-ledger.js:154-156` — **shadow leaks in-game numbers into CLV** | A03 D16 |
| L30 | Forward provenance verifier | **insufficient guard**: checks kickoff not horizon (`nfl-evidence-provenance.js:54`); T-15 evidence in a T-60 row passes | A04 |
| L31 | Forward packet quote admission | guarded at `nfl-t60-packet.js:214-216` — so strictly that nothing passes (G01) | A04 |
| L32 | Forward packet news/injury scope | **leaks availability, not outcome**: global news (`:264-270`) marks the source eligible for every game | A04 |
| L33 | Python dataset builder | guarded: strict `<`, 3-day publication proxy, unparseable ⇒ dropped (`research/betting/nfl/dataset.py`); no `decision_at < kickoff` check — **unknown** for callers | A04 headline 4 |
| L34 | `research/leakage.py` | cannot detect close-as-feature (R² ≥ 0.98 threshold) — **no guard**, docstring overclaims (`:7`) | A04 |
| L35 | Tape run cutoff trust | `nfl-decision-tape.js:244` never checks `decidedAt <= cutoffAt` or `quote_at <= cutoffAt` — **unknown / unguarded** | A03 |

Net: inside the blind-audit controller no week-N+1 → week-N outcome path was demonstrated (L01–L05, L07, L11
guarded). The historical record's real exposures are L06 (decision-time), L08/L09 (as-of content), and L14/L18/L19
(development-as-holdout). The forward lane's exposures are L28–L30 and the absence of any packet→decision link.

---

## 5. Metrics — what is measured now vs what should be

| Quantity | Now | Should be |
|---|---|---|
| **CLV by reference book** | Six closes (§1 table). Only `nfl-execution-clv.js` declares books/period and returns quote IDs, and it has 0 positions, is not persisted, and defaults to *all* books including the execution book (`:59`). Shadow (189 rows) uses the live ESPN column with no book (`shadow-ledger.js:83`); beat-the-close uses Pinnacle ≤ kickoff (6 settled). The −2.28 CLV in the plan is opener→nflverse-close over days, on the raw blend. | One persisted grade per (decision, grading_version): declared reference set that **excludes** the execution book (Pinnacle + one sharp + one soft), `full_game`, per-book latest quote `received_at < kickoff`, point CLV and price CLV in probability space (`nfl-execution-clv.js:268-271` already does the arithmetic), quote IDs, missing-close rate in the denominator. Graded for **every** tape decision (selected and abstain), so the all-game CLV series exists. Report CLV per week and per book. |
| **Clustered SE** | `uncertainty()` clusters by week but only weeks containing bets (`nfl-replay.js:43-50`); `pairedBootstrapDiff` silently drops to iid on mis-sized groups (`backtest-significance.js:62`); abstention audit uses iid Wilson/z (`nfl-abstention-audit.js:45-76`); family/line-move/beat-the-close each carry their own bootstrap and RNG. | One weekly-cluster paired bootstrap over the **declared** week set (all eligible weeks; zero-bet weeks contribute 0 units), seeded once, used by every report. Report both ROI-per-bet and P&L-per-eligible-week intervals. Disclose repeated-team dependence. |
| **Sequential p-values** | mSPRT implemented correctly (`backtest-significance.js:216-230`) but never fed (`always_valid_p` NULL on all 15 registry rows); registry collapses plug-in and declared σ (`audit-registry.js:219`) and compares to Šidák α; decay-watch runs the plug-in variant repeatedly (`decay-watch.js:172`), all `insufficient_data`. | Fixed review endpoints declared now: (a) after 2026 Week 9 — integrity only (row counts, coverage, zero leakage), no economic claim; (b) after Week 18 — primary CLV endpoint. If a running monitor is wanted, mSPRT with σ declared from the 2021–25 development weekly P&L and τ declared, one hypothesis per registered rule; α-spending written in the register row. Never gate on a plug-in-σ p. |
| **Multiplicity haircut (PBO / DSR)** | None. Holm applies within one `analyzeErrors` call (`nfl-replay.js:691`) and within one line-move run; nothing across runs, thresholds, families (31 registered components, 9 challenger-only, plan line 126; the brief's "21-model search" has no register to be checked against), the ~40 line-move features × 4 stamps × 2 markets, or the two audit scripts. `research_trials` does not exist. | Build the trial register (G26). For the development search compute (i) probability of backtest overfitting via combinatorially-symmetric cross-validation over the 70-week P&L matrix of all K variants, and (ii) a deflated Sharpe ratio for the selected variant. Order of magnitude: with K ≈ 21–31 and 70 weekly observations the expected best-of-K weekly Sharpe under pure noise is ≈ 1.9 × (1/√70) ≈ 0.23 per week, i.e. a selected variant must beat roughly that before it is evidence of anything. Historical variants are all negative (−7 %), so the haircut bites hardest on the **segment finding** (best of many segments) and the **beat-the-close signals** (best of ~320 feature×stamp×market cells), which is where it must be applied first. |
| **Coverage** | Overview coverage = observed min–max span (`nfl-audit-overview.js:159-170`), so a run that died mid-season reports complete. T-60 `missed` unreachable (`t60-runner.js:249-250`); SEA–NE Week 1 is absent from every ledger; `nfl_t60_observations` holds 1 of 16 Week-1 games. Execution CLV has an `ungraded` list but 0 rows. | Denominator = declared schedule (272 regular-season games × 1 observation at T-60). Every game gets exactly one tape row with state ∈ {selected, abstain, missed, unavailable}; coverage report = counts by state + missing-close rate + packet-eligibility rate per source; `coverage_complete` only vs the declared schedule. |
| **Probability quality** | Conditional/three-state Brier corrected and test-pinned in family report (A05); slice diagnostic ECE (`nfl-slice-diagnostic.js:102-103`); no forward rows. | Same scorecards on the forward all-game series vs the market's own implied probability at T-60 and at close; report with the denominator (decided bets vs all games). |

**Minimum forward sample before any claim (assumptions stated, approximations):**

Units per −110 bet under break-even p = 0.5238: mean 0, SD ≈ 0.95. One-sided α = 0.05, power 0.80 ⇒
n ≈ (2.49 × 0.95 / δ)² ≈ 5.6 / δ² before clustering (multiply by ~1.3–1.5 for weekly dependence):

| Target ROI δ | Bets needed (iid) | With ≤5 selections/week (2.2/week observed historically, 153 bets / 70 weeks) |
|---|---|---|
| +10 % | ≈ 560 | ≈ 6 seasons at the historical rate; ≈ 3 seasons at the 5/week cap |
| +5 % | ≈ 2,250 | ≈ 25 seasons / 12 seasons |
| +3 % | ≈ 6,240 | not reachable |

A 90 % interval on ROI at n = 90 (one season at the cap) is ≈ ±16 %; at the plan's 200-selection operational
minimum ≈ ±11 %. **ROI cannot be decided in one season, or in three.** The plan's §9.3 already says 200 selections
need ≥ 40 fully used weeks; the arithmetic above says 200 selections still cannot separate +5 % from −5 %.

What a season *can* decide is **all-game CLV at T-60**: 272 observations (not ≤ 90). If the T-60→close move has
SD ≈ 0.7–1.0 points, a mean point-CLV of +0.3 needs ≈ 35–70 games iid (≈ 50–100 clustered), and +0.15 needs
≈ 140–280. Price CLV of +0.5 pp with SD ≈ 1.5 pp needs ≈ 55 games. Caveat: the +0.3 gate was set for opener-based
signals over days of movement; the T-60 target must be re-declared against the 2026 tape's own T-60→close
distribution once ~4 weeks of it exist, *before* looking at the model's side of it. Conditional Brier vs the market
on 272 games cannot resolve differences of the size that matter (≈ 0.002) — do not claim probability improvement
from one season.

Therefore the minimum before any claim: (1) ≥ 200 admissible all-game tape decisions with persisted packet, quote
IDs and CLV grade (≈ Weeks 1–13 if wired by Week 2), for a CLV-direction claim only; (2) no ROI or profit claim
from 2026; (3) any segment/signal claim charged against the trial register.

---

## 6. Keep / merge / delete — per replay/backtest engine

| Engine | Verdict | Why / what changes |
|---|---|---|
| `nfl-replay.js` `replaySeason` | **KEEP** (the single historical engine) | Make `blendMode` explicit and recorded (G05); `uncertainty` over declared weeks (G15); add `market_line_basis` disclosure (G07); remove dead imports. |
| `nfl-blind-audit.js` (runs 27/31/32) | **KEEP** as the historical chronology test; **relabel** | Not "the audit". Fix freeze scope (G12), packet per week (G13), blendMode in spec (G05), explicit cancel, no HTTP `allowDirty`. Preserve runs 27/32 as "raw-blend closing-line development record". |
| `nfl-audit-overview.js` | **KEEP** | Fix O1–O4 (G14); compare by artifact/forecast/price/cash-flow separately (C09). |
| `audit-registry.js` | **MERGE** into the trial register | Keep preregistration semantics; fix gating (G17); its `codeHash`/`dataSignature` replaced by `code-identity.js` closure + packet/data hashes. |
| `nfl-candidate-findings.js` | **KEEP** with G06/G18 | It is the right shape (discovery → forward confirmation → human promotion → fail-safe veto). |
| `nfl-research.js` family ablation (`:120-146`) | **DELETE** | Duplicate of nfl-family-contribution with a false refit claim (`:139-142`); `nfl_feature_ablation_audits` rows retained as history. |
| `nfl-family-contribution.js` | **KEEP** | Relabel `frozen_fit_removal_sensitivity`; optional true refit path; measured cost; identities (G19). |
| `nfl-neural-replay.js` | **MERGE** into `replaySeason` as a model option, or park | Prequential logic is sound; 0 rows; unlabelled close grading and all-inputs graph (G37). Not worth a separate engine. |
| `weekly-walkforward.js` vs `scripts/audit-football-first.mjs` | **MERGE** — keep the service, make the script call it | Same question twice with different fits; keep the sealed registry rows; add stored prices (G37); idempotent preregistration. |
| `line-move-study.js` | **KEEP** as Phase-1 research | Remove T2 actual weather, fix selection window, verify/label nfelo availability (G20); register every feature cell (G26). |
| `beat-the-close.js` | **KEEP** — the only forward, timestamped, zero-stake experiment | Quarantine unpassed rules as candidates; opener source first-class; one bootstrap (G21/G15); read its CLV from `nfl_clv_grades` (G09). |
| `nfl-ai-replay.js` | **PARK** (do not run; paid) | Fix cache key (G35) before any run; research-only label is honest. |
| `nfl-props-replay.js` | **KEEP out of spread reports** | Synthetic line; fine as a necessary-not-sufficient diagnostic. |
| `backtest.js`, `weekly-backtest.js` | **KEEP** (fantasy) | Out of betting scope; note hyperparameter leakage (L22) in their headers. |
| `nfl-execution-replay.js` | **KEEP** | Cleanest module in the set; pure, deterministic, tested. |
| `nfl-clv.js` (legacy) | **DELETE** and unschedule (`scheduler.js:275-278`) | Fourth CLV definition; 0 rows; C13/C14 defect class. |
| `forward-ledger.js` / `forward_picks` | **MERGE into the tape** then delete | 0 rows; caller-supplied clock; in-place settlement. The tape + lifecycle ledger already cover it. |
| `shadow-ledger.js` / `shadow_decisions` | **FIX now, then MERGE into the tape** | The only 2026 ledger; kickoff guard + `closing_spread` + invalidation rows immediately (G04/G10); long-term it is a tape run with role `shadow`. |
| `nfl_pick_decisions` UPSERT (`persistPickDecisions`) | **DEMOTE** to a materialised view of the tape | Never a source of truth again (G03). |
| `nfl-candidate-analysis.js` | **KEEP**, strip constant verdicts (G27) | Useful development diagnostic. |
| `nfl-slice-diagnostic`, `nfl-specialist-audit`, `nfl-abstention-audit`, `nfl-coordination-audit`, `nfl-diagnostic` | **KEEP** as descriptive | Fix labels (in-sample coordinator fit, iid intervals, constant severities); never cited as evidence. |
| `evidence-daemon.js` T-60m window vs `t60-runner.js` observation | **MERGE** | Daemon captures; runner freezes; link by observation id; one notion of T-60. |
| `nfl-t60-packet.js` vs `forecast-packet.js` contract | **MERGE** | Packet emits the contract shape; validator gates the freeze (G02/G22). |
| `decay-watch.js` | **PARK** until forward data exists; qualify the method (G17) | All runs `insufficient_data`. |
| `scripts/audit-trend-totals.mjs` | **KEEP** as a sealed negative result | Add idempotency guard. |

---

## 7. What to build next — ordered, each with an exit test

**Built only from CONFIRMED gaps** (the 22 that survived all three adversarial legs). Refuted gaps (Appendix A)
appear nowhere here; where one used to be bundled with a confirmed gap, the bundle has been split and only the
confirmed half remains. Ordered by "what stops zero admissible observations from becoming one" first, then the
places where a number a person reads is currently wrong, then historical hygiene. Items 1–5 are the Week-2
critical path; every week they slip is a week of 2026 lost.

1. **Real receipt clock on the free feeds** (G01). `book-feeds.js:417`, `line-shopping.js:66`: stamp
   `receivedAt` after the awaits and pass it — the honest clock already exists at `book-feeds.js:388` and is
   simply dropped. *Exit:* next `nfl_quote_batches` rows show `response_completion`;
   `test/nfl-t60-packet.test.js` gains a case where a free-feed quote is `received_by_cutoff`; a re-frozen packet
   for a Week-2 game lists ≥ 1 eligible price. Nothing downstream can produce an admissible observation until
   this lands.
2. **Persist the packet, canonical hash, scoped sources** (G02/G22). Migration 035 `packet_json`;
   `freezeT60Packet` emits the `forecast-packet` contract shape with rows scoped to the event/team/player
   (the news query gets a WHERE clause); `validateForecastPacket` gates the seal; `packetHash` canonicalises and
   excludes `computation_started_at`. *Exit:* freeze the same fixture twice ⇒ identical hash; `readPacket(obs.id)`
   validates; `test/nfl-t60-packet.test.js:131-139` flips from asserting the unscoped-news defect to refusing it.
3. **Decisions to the tape from the runner, inside a grace window** (G03/G08/G23). `captureDueObservations`
   gains `AND cutoff_at >= now - grace` and runs *before* `markMissedObservations`; the runner calls
   board(packet) → `recordDecisionRun` with `data_hash = packet_hash`, `data_identity_status='frozen_packet'`,
   `schedule_version`; `missed`/`unavailable` become tape rows; `nfl_pick_decisions` is demoted to a
   materialised view. *Exit:* Week-2 fixture of 16 games ⇒ 16 `nfl_decision_runs` whose states sum to 16;
   simulated outage ⇒ `missed` rows, not late `frozen` ones; `nfl_decision_runs` on the live DB ≥ 16 after Week 2.
4. **Shadow ledger guard, frozen close, quarantine** (G04/G10). Refuse capture at/after kickoff or when a score
   exists; read `closing_spread`, never `spread`; write invalidation rows for 200/216 (no deletes). *Exit:*
   finished-game fixture refused; `shadowLedgerSummary` and `validationFirewall` both exclude invalidated rows;
   an `observe` row for a finished game is impossible after the next policy bump.
5. **One close definition, legacy unscheduled, settlement race closed** (G30). Every ledger reads one graded
   close; unschedule `gradeClosingLineValue` (`scheduler.js:273-277`) and retire `nfl-clv.js`; give
   `settleNflShadowDecisions` a `model_version` filter so it cannot settle beat-the-close rows with the ESPN
   spread first. *Exit:* the 14 settled shadow rows carry one `close_source`; no `clv_points` mean averages two
   definitions; a race fixture (both settlers eligible) settles each row under its own rule.
6. **Provenance verifier against the horizon cutoff** (G24). Pass the row's own `cutoff_at` (kickoff − lead)
   instead of the kickoff. Cheapest item on this list and it changes a served verdict string today. *Exit:*
   `flagged_rows` on the live forward ledger goes 0 → ≥ 8 (T-24h 3, T-6h 3, T-60m 1, T-15m 1); a T-15 stamp in a
   T-60 row is flagged in test.
7. **Findings ledger isolation and forward-only holdout** (G06/G18). Per-finding `try`; a `stale` event instead
   of a thrown season-end; versioned rule key so a changed predicate starts a new finding at zero evidence;
   `season > 2025` fence for the holdout role; `passed` requires effect size + weekly-clustered interval +
   minimum matching count, not a directional flip. *Exit:* season-end fixture with finding 1 (stale) plus a
   healthy finding completes, emitting one `stale` event and one holdout row; `recordHoldoutTest` with 2
   matching bets ⇒ `insufficient`; the 2026 cycle runs to completion on the live DB.
8. **One clustered bootstrap over declared weeks; overview counting fixes** (G14/G15). Shared
   `clusteredBootstrap(rows, {weeks: declaredWeekSet})` where a declared week with no bets contributes 0 units;
   all five call sites use it; overview compares results case-insensitively, takes coverage from
   `spec_json.schedule` rather than observed min–max, and keeps missing-units picks out of the ROI denominator
   alongside voids. *Exit:* run-27/32 `win_rate_95` is non-degenerate; `auditOverview(28)` reports
   `coverage_complete: false`; an empty declared week widens the interval.
9. **Trial register + multiplicity haircut; registry gate fixed** (G26/G17). One `research_trials` table with a
   row per attempt — including the sub-`minBets` segments dropped at `nfl-replay.js:670` and every variant of the
   three Holm families; PBO/deflated-Sharpe computed over the development search and printed on every summary;
   `audit-registry` gates on a p-value whose α does not depend on run order, and persists
   `p_always_valid`/`p_fixed_sample_only`/`variance_source` separately rather than collapsing them into
   `always_valid_p`. *Exit:* register row count ≥ number of variants ever scored; finding 1 and
   `nfelo_pre_vs_open` carry `trials_in_family` and a deflated statistic; re-running an audit later does not
   change the α that decided a stored `passed`.
10. **Pre-declared 2026 review endpoints** (§5). One `audit_registry` row per hypothesis — all-game point CLV and
    price CLV, **not** ROI — with endpoints after Week 9 (integrity) and Week 18 (CLV), σ/τ taken from
    development data, written before Week 3 kickoffs. *Exit:* rows exist with `declared_at` earlier than the
    first Week-3 kickoff; the Week-9 report contains counts and coverage only.
11. **Historical replay graph parity and relabel** (G05/G07). `blendMode` explicit and recorded (add
    `spec_json`/`spec_hash` to `nfl_replay_runs`); a new blind run under `market_residual` with runs 27/32
    preserved as the raw-blend closing-line development record; a `market_line_basis` field carried on every
    replay summary and the `/replay` route. *Exit:* `spec_json.blendMode` present;
    `compareAuditRuns(32, new)` differences are attributable to the blend; a test asserts replay options ⊇
    served options.
12. **Feed the bitemporal store and fix the injury receipt clock** (G31). Injury/news ingest appends
    `nfl_feature_revisions`; the packet reads `observed_at <= cutoff`; `modified_at` is relabelled as the
    source's publication time and stops granting `received_by_cutoff` on its own. *Exit:* `nfl_feature_revisions`
    > 0 rows; a revision written after the cutoff is invisible to the packet; no packet source claims
    `received_by_cutoff` on a publication clock.
13. **Freeze-scope fix for the blind audit** (G12). Freeze (or exclude from `result_hash`) the three look-back
    line tables read at `:673-680`; stop hashing `nfl_ensemble_fit_artifacts` `all_rows` when the run executes
    under `withEphemeralEnsembleArtifacts`. *Exit:* persisting a live fit during a run no longer voids it (the
    failure mode that killed runs 25 and 28); a look-back table changing between two otherwise identical runs
    does not move `result_hash`.
14. **Line-move hygiene** (G20). Drop the realised-kickoff-hour weather feature in favour of the lead-2/lead-3
    forecast already beside it; pass `selectionThrough` so α/carryover are selected strictly below the 2024
    holdout; attach an availability basis to nfelo rows (TeamRankings already carries one). *Exit:* re-run
    `ratings_vs_open` with the selection window fenced and publish the re-measured effect next to the promoted
    rule's basis string; no feature in the study's output has a source time later than its own stamp.
15. **Refuse the destructive downgrade** (G29). `027.down`: throw when `nfl_decision_runs` or
    `nfl_decision_events` hold any row. *Exit:* rollback past 027 with a non-empty tape fails loudly; with an
    empty tape it still succeeds.
16. **Delete/merge duplicates** (§6, confirmed half only): `nfl-research` ablation (duplicate engine — the
    *false-refit* charge against it was refuted, see Appendix A), `nfl-clv.js` (after item 5), script → service
    for football-first. *Exit:* one engine per question in the §1 duplication table.

**What a 285-game season honestly allows.** 272 regular-season games (13 playoff games are a different regime and
should be excluded from the primary endpoint). With ≤ 5 selections a week the selected-bet sample is ≤ 90 and
historically ~40; ROI is undecidable this season and next. The season's achievable product is: (a) a complete
forward ledger — 272 tape rows with persisted packets, quote IDs and CLV grades, zero post-kickoff rows, zero
legacy-clock quotes admitted; (b) a CLV-direction reading on the all-game series against a re-declared T-60
threshold; (c) a trial register that makes the development-era numbers (finding 1, the opener signals, the
family search) interpretable with their multiplicity charged. Anything that says "profit" or "edge" from 2026
data alone is not supported by the arithmetic in §5, and the code today would not even produce the rows to
attempt it.


---

## Appendix A — refuted gaps (2026-09-12 adversarial pass)

Nine gaps were knocked down. In every case the **code reading survived** and the **materiality leg failed**: no
number a person reads, and no decision the system takes, changes today. They are kept here because each is a real
latent defect whose preconditions can change — if the named precondition ever becomes false, promote the row back
into §3. None of them appears in §7.

| id | original claim | why it was refuted (verifier's one-line) | precondition that would reopen it |
|---|---|---|---|
| G09 | CLV recomputed on every read, never persisted; default reference book set includes the execution book | Not material: `nfl-execution-clv.js:294-310` already emits `closing_quote_ids`/`closing_books`/`clv_points`/`clv_probability` and `:341-342` the `grading_version` + declared books; the module is a read-only projection over an append-only tape (`:347-349` states the idempotent-regrade rationale), so recompute over immutable rows returns the same number. 0 positions today. The default book set is a *declared* choice recorded on every report. | The quote tape stops being append-only, or a graded number is cited in a claim that must be reproducible at a later date, or an execution book is actually used. |
| G11 | Funnel and attribution read the uncorrected settled row | Real but unreachable: 0 opportunities and 0 lifecycle events; a divergence requires accepted → settled → `correctSettlement` (actor + reason), which has never happened; `threeWayAttribution` has no caller outside its own test, and the funnel route returns zeros either way. | The first settlement correction is written, or `threeWayAttribution` is wired to a route. |
| G13 | `weekly_input` is council output, not a persisted input packet (C11 unmet historically) | Labelling, not evidence: the run's input attestation exists at table level — `inputDataState :95-157` hashes every `INPUT_TABLE` at preregistration and `assertFrozen` rechecks at `:847` and inside the write transaction `:891`, with code hashed at `:80-93`. No number or decision changes; the honest fix is renaming the field or adding per-game row hashes. | The historical run is cited as satisfying C11 (per-game input packet), or per-game reproduction from stored inputs is required. |
| G16 | Paired bootstrap silently degrades to an iid resample when `groups` is mis-sized | No live call site trips it: `n = min(len(A), len(B))` and every inspected caller builds `groups` in lockstep, so `groups.length < n` does not occur and no published interval is currently wrong. **The verifier found a different, reachable exposure the gap does not state**: `groups` *longer* than n passes the `>=` guard and misaligns by index (`offseason-model.js:1497`, `:1149`, where a skipped challenger can lengthen the pooled array). | Reopen as a correctly-stated gap: add a `clustered` flag to the return and refuse mis-*aligned* groups, not only short ones. |
| G19 | Family ablation claims a refit it does not perform; cost reported as model count; no identities saved | The label is loose but the numbers are identical to a true refit: per-model RMSE is accumulated independently (`nfl-ensemble.js:1070-1090`, `:1112-1138`), weights are `exp(-0.7·rmse)` renormalised over the models actually present (`:1275-1282`), so filter-then-renormalise equals refit-over-remaining families; calibration and the residual gate are family-independent. `cost` feeds nothing — `decideFamily` never reads it — on a `diagnostic_only` report that cannot promote anything. | A family's removal starts changing another model's fit (shared weighting, joint calibration), or the report gains promotion authority. |
| G21 | Live beat-the-close runs two rules the study did not pass; its live "opener" is not the study's opener | Nothing pools candidates with passed rules: `cleanDecisions` filters per `model_version`, `beatTheCloseStatus` and `weeklyRead` report per signal and print the rule's own basis string — which literally reads "candidate, not a passed signal" and "under the +0.3 gate" — stake is 0 everywhere and retirement is per signal. The opener fallback has never fired: all 35,239 `nfl_signal_snapshots` rows carry `opener_source = 'archive:pinnacle:open'`. Residual P3: the frozen `feature` snapshot (`:250-253`) omits `opener_source`, so if the fallback ever fires the decision row cannot say which opener it used. | A summary aggregates across signals, stake becomes non-zero, or the archive opener goes missing and the fallback fires. |
| G25 | `forward_picks` "cannot be retrofitted" is enforced by convention only | The score check at `forward-ledger.js:102` is clock-independent, so a pick for a completed game is refused whatever clock is passed; only in-process callers can supply `recordedAt` and the sole production caller (`:304`) omits it; the HTTP surface cannot reach it; 0 rows and a UNIQUE index already blocks overwrite. Residual: no append-only trigger, and `forwardLedger()`'s served note (`:259`) overclaims. | `forward_picks` gains rows or a caller that passes `recordedAt`; otherwise retire the table into the tape (§6). |
| G27 | Hard-coded verdict strings are persisted as computed diagnosis | Not material, **and the stated evidence is wrong**: only 1 of the 6 persisted `nfl_candidate_robustness_audits` rows carries `macro_diagnosis` at all, and that row's constant verdict matches its own numbers (hit rate 0.481 vs break-even 0.524). No number changes; staking authority comes from the profitability gates, not these strings. Latent: `nfl-coordination-audit.js:60-61`'s derived `production_state` could contradict its constant verdict `:48` once calibration and neural qualify. | The derived state and the constant string diverge, or a verdict string is quoted as a finding. |
| G28 | A test opens the live production DB as a WAL writer and runs migrations at import | Real C06 violation, but `db/index.js:163` applies only `000_legacy_schema`, already present on the live file — a no-op; the only writes are a `db_health_checks` row and a no-op leagues upsert. No evidence table is touched and no number changes. The real hazard is write-lock/IO contention with PID 56651 during capture, bounded by `busy_timeout=15000`. | Anything in the suite writes an evidence table, or a lock timeout is actually observed during a capture window. |

### A.1 The nine rows as they stood in §3 (verbatim, for the record)

| id | sev | gap | current (path:line) | should be | evidence | fix (file · function · table · test) |
|---|---|---|---|---|---|---|
| G09 | P2 | CLV is recomputed on every read, never persisted; default reference includes the execution book | `nfl-execution-clv.js:232-354` JSON only; `:59` `DEFAULT_CLOSING_BOOKS = null` (= all books); route `nfl-market.js:391` never passes `books` | Persist `(opportunity_id/decision_event_id, grading_version, book_set, quote_ids, point_clv, price_clv_prob)`; reference excludes execution book; grade every tape decision (selected and abstain), not just accepted tickets | A03 D8/D9; C13 close-with | new table `nfl_clv_grades` (append-only, trigger); `executionClvReport` → `persistClvGrades`; `DEFAULT_CLOSING_BOOKS` = declared list (e.g. pinnacle, circa, draftkings) minus `accepted.book`; test: re-grade after tape change appends v2, v1 retained |
| G11 | P2 | Funnel and attribution read the uncorrected settled row | `nfl-execution-lifecycle.js:470-476` joins `state='settled'` only; `nfl-execution-attribution.js:116,127-128` | Net realized units after corrections everywhere (`netRealizedUnits :417-421` already does) | A03 D6/D19 | `lifecycleFunnel`: sum `settled` + `settlement_correction` per opportunity; `threeWayAttribution.realized_result` via `netRealizedUnits`; test with one correction |
| G13 | P2 | `weekly_input` is council output, not an input packet | `nfl-blind-audit.js:866-869` → `:420-449` assembled from the same in-memory `expertCouncil` | Historical week packet = the exact rows read (or their hashes) per game, in the same schema as the forward packet | A01 B3; plan §4.1 | `weeklyInput` → call `freezeT60Packet(mode:'historical')` per game and store `packet_hash` + payload in `result_json.packets`; test: packet row count equals games |
| G16 | P2 | Paired bootstrap silently degrades to iid when `groups` mis-sized | `backtest-significance.js:62` `if (groups && groups.length >= n)` else ungrouped `:83-93`; test 111-117 enshrines it; ~30 call sites | Refuse (`{error}`) or return `clustered:false` prominently | `paired-bootstrap-clustering.test` proves iid under-covers (<0.85 at nominal 0.90) | `pairedBootstrapDiff`: `if (groups && groups.length !== n) return {error:'groups length mismatch'}`; audit call sites; test flips 111-117 to expect the error |
| G19 | P2 | Family ablation claims a refit it does not perform; cost = model count | `nfl-family-contribution.js:390` `ablation_kind:'refit_leave_one_family_out'`; `families` only filters `MODELS` (`nfl-ensemble.js:1257`), `fitEnsemble :1238` called without it; `:375` cost = `model_count/31`; `nfl-research.js:139-142` stronger false claim | Label `frozen_fit_removal_sensitivity`; if refit wanted, pass `families` to `fitEnsemble`; cost = measured ms; save graph/fit/universe/calibration ids | A05 §11; C16 status row | `familyContributionReport`: `ablation_kind` literal fix + `runtime_ms` per config + `identities:{code_hash, fit_artifact_keys, universe_hash}`; delete nfl-research.js:120-146 ablation; test asserts `ablation_kind` and that `fitEnsemble` receives `families` when `refit:true` |
| G21 | P2 | Live beat-the-close runs two rules the study did not pass; live "opener" ≠ study opener | `beat-the-close.js:45` `ratings_vs_open_total` "candidate, not a passed signal"; `:52-53` `wind_total` "under the +0.3 gate"; `:79-82` opener falls back to first live Pinnacle capture | Rules frozen live only from the register with `status='passed'`; candidates in a separate bucket; opener source a first-class field and a filter in `weeklyRead` | A05 §10 P2 ×2 | `RULES` → rows in the trial register with `status`; `decideBeatTheClose` freezes candidates with `role:'candidate'`; `weeklyRead` splits by role and `opener_source`; test |
| G25 | P2 | `forward_picks` "cannot be retrofitted" is by convention | `forward-ledger.js:99` `now = recordedAt ?? new Date()`; no trigger on `forward_picks` | Server clock only; append-only trigger; or retire into the tape | A03 D12 | drop `recordedAt` parameter; migration adds `no_update/no_delete` triggers; test |
| G27 | P2 | Hard-coded verdicts presented as computed | `nfl-candidate-analysis.js:211,219-222,233-236,183-187`; `nfl-coordination-audit.js:48-55,60-61`; `nfl-diagnostic.js:84,99-102` | Verdict strings derived from the numbers or removed | six persisted `nfl_candidate_robustness_audits` carry constant verdicts (A02) | replace with `verdictFrom(metrics)` or delete `verdict`; test: profitable fixture ⇒ no "not profitable" text |
| G28 | P2 | A test opens the live production DB as a WAL writer and runs migrations | `test/nfl-audit-overview.test.js:12-13` imports `server/db/index.js` without `GRIDIRON_DB_PATH` (`index.js:163` migration at import); hard-codes run 27/31 | Temp DB fixtures only (C06) | A01 T1 | rewrite on a temp DB with synthetic runs; CI guard: fail any test that opens the default path |

**Also corrected, not refuted:** G03's "SEA–NE is absent from every ledger" (it is in `nfl_pick_decisions`,
written three days post-final); G12's `:485-493`/`:584-585` citations (read `:673-680` and `:758-760`); G10's
forward half (already fixed at `forward-ledger.js:154`); G17's "collapses the relabel" (true of the persisted
column and `auditHistory`, not of `runAudit`'s return); G20's TeamRankings leg (date-verified; only nfelo lacks
availability evidence).
