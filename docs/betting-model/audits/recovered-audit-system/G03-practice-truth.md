# G03 adversarial verification — lens: practice-truth

Question: is the SHOULD-BE ("every observation (game x cutoff) yields exactly one immutable tape run in state selected/abstain/missed/unavailable, linked to its packet hash; denominator = declared schedule") a genuine, widely-held ledger/backtest principle, or opinion dressed as a standard? Does it survive NFL sample sizes (272 games/season)?

Verdict: NOT refuted. Core of the should-be is a genuine cross-domain standard. Two sub-clauses are implementation choices, not standards. One evidence line in the gap statement is literally wrong (SEA-NE IS in one ledger — post-game, which is worse). Confidence 0.80.

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). No web lookups made; external sources cited by title from memory, flagged as unverified-in-this-run.

## 1. What the code actually does (all files read in full)

### Mutable latest-view is the only thing written for Week 1
- server/services/scheduler.js:693-703 `refreshNflDecisionLedger` -> `persistPickDecisions(season, week, board)`; scheduled at scheduler.js:882-883 as `nfl_decision_ledger` (growth tier, 3h).
- server/services/nfl-auto-picks.js:205-224 `persistPickDecisions`: `INSERT ... ON CONFLICT(season,week,policy_id,matchup,market,selection) DO UPDATE SET line=..., american_price=..., quote_at=..., eligible=..., abstention_reason=..., feature_snapshot_json=..., recorded_at=excluded.recorded_at`. Conflict key omits policy_version and cutoff; recorded_at is overwritten on every run.
- nfl-decision-tape.js:4-9 says this itself: "`persistPickDecisions` writes a MUTABLE latest view ... overwrites what the model actually decided before it moved."

### The T-60 runner never records a decision
- server/betting/nfl/strategy/t60-runner.js:27-32 imports: db, nfl-t60-protocol, nfl-contract-key, nfl-t60-packet, date-util. No import of nfl-decision-tape.js.
- t60-runner.js:118-147 `captureDueObservations`: only `UPDATE ... SET state='frozen', packet_hash=...` (137-139) or `state='failed'` (131-133, 142-144).
- t60-runner.js:165-176 `markMissedObservations`: `SET state='missed'`.
- t60-runner.js:233-245 `runT60Pass` = open + capture + markMissed. Nothing else.
- t60-runner.js:150-152 `packetHash(packet)` sha256 of JSON; the packet itself is not stored anywhere — `grep INSERT server/services/nfl-t60-packet.js` finds none; `freezeT60Packet` (nfl-t60-packet.js:142-143) returns the packet. The hash on the row (`nfl_t60_observations.packet_hash`) therefore addresses content that no table holds.
- States 'collected', 'decided', 'abstained' (migration 034:46-47 CHECK) are never written by any code path; `decision_run_id` is never written. t60Coverage's `captured_rate` counts `frozen + decided` (t60-runner.js:276-277) so 'decided' is expected but unreachable.
- test/t60-runner.test.js:74-99 tests missed/never_scheduled only; no test asserts a decision row or a decision_run_id link.

### recordDecisionRun reachable only from manual paths
- server/services/nfl-execution-pipeline.js:118-141: `observationIdentity = observation ?? { experimentId: 'unscheduled-manual-invocation', horizon: 'unspecified_on_demand', ... }`; comment at 126-128: "only the durable runner (C12, slice 5) may claim that horizon". Line 143-151: `recordDecisionRun(... dataIdentityStatus: 'unfrozen_live_tables' ...)` — never `frozen_packet`.
- server/routes/nfl-market.js:323-329 `POST /execution/run` -> `runExecutionPipeline(season, week)` with no observation argument; route comment 314-321: "There is no scheduled job calling `/execution/run` automatically".
- No scheduler JOBS entry (scheduler.js:788-971) calls runExecutionPipeline.

### Live DB (node:sqlite readOnly, 2026-09-12)
- nfl_decision_runs 0, nfl_decision_events 0, nfl_decision_run_invalidations 0, nfl_capacity_events 0, nfl_t60_observations 1 (SF@LAR, state frozen, decision_run_id NULL, created 2026-09-10 20:03:38), nfl_pick_decisions 16 rows for 2026 wk1, all eligible=0 abstention_reason=calibration_not_proven, all recorded_at 2026-09-12T05:36:03.634Z.
- game_lines wk1 declared schedule: 16 home rows (SEA-NE 09-09 20:20, LAR-SF 09-10 20:35, 13 on 09-13, KC-DEN 09-14).
- sync_log nfl_t60_runner: 148 runs, last 2026-09-12T06:45:53Z, opened 0, Sunday games skipped `beyond_scheduling_horizon` (24h horizon, t60-runner.js:39, 74).

### SEA-NE specifically
- Kickoff 2026-09-09 20:20 ET = 2026-09-10T00:20Z; T-60 cutoff 2026-09-09T23:20Z.
- Runner file and migration 034 first committed fced8d9 2026-09-10 13:40:51 -0400 (17:40Z) — 18 hours after the cutoff. `openObservations` skips a passed cutoff with `reason:'cutoff_already_passed'` and writes no row (t60-runner.js:72-73). So SEA-NE could never enter nfl_t60_observations; t60Coverage would report it under `never_scheduled` (t60-runner.js:263-265) — computed on read from mutable game_lines, not a stored record.
- BUT nfl_pick_decisions DOES hold "NE at SEA": selection NE, line 3, -102, book espn, quote_at 2026-09-12 04:42:45, recorded_at 2026-09-12T05:36:03Z. game_lines shows the game final (SEA 13, NE 10, fetched_at 2026-09-12 05:44:53). The row was (re)written ~53 hours after kickoff, with a post-game quote timestamp, over whatever pre-kickoff row existed (UPSERT). So the gap's "absent from every ledger" is literally false; under point-in-time discipline the truth is worse: the only Week 1 record of the model's SEA-NE decision is a post-outcome overwrite.

## 2. Is the should-be a genuine standard?

The should-be bundles four claims. Assessed one by one.

### 2a. Complete, pre-declared denominator; every unit gets a recorded outcome including abstain and missed — GENUINE, widely held
Cross-domain instances (no web verification this run; titles from memory):
- Clinical trials: ICH E9 (1998) "full analysis set" / intention-to-treat; CONSORT 2010 participant flow diagram — every randomized unit accounted for, dropouts reported not dropped.
- Forecasting: Tetlock & Gardner, Superforecasting (2015) / Good Judgment Project — time-stamped forecasts scored on every question; Nosek et al., "The preregistration revolution", PNAS 2018.
- Backtesting: Bailey, Borwein, Lopez de Prado, Zhu, "Pseudo-Mathematics and Financial Charlatanism", Notices AMS 2014 (report all trials, not the ones that worked); Harvey & Liu, "Backtesting", J. Portfolio Mgmt 2015; Lopez de Prado, Advances in Financial ML (2018) ch.11 (backtest dangers, point-in-time data).
- Missing data: Rubin (1976) — a missing observation must be recorded as missing so its mechanism can be assessed.
- The project's own declared standard says the same, independently of this audit: superseded-plan-2026-09-09.md:419 "Record a missed capture as a missing prospective observation"; :437 "persist every decision/abstention"; :439 "Replace the mutable `persistPickDecisions` upsert history with append-only decision-run and decision IDs"; :467 "missing closes stay in coverage denominators"; :613 "retain its denominator"; model-governance-manual.md:23 (no look-ahead), :28 (positive CLV, clustered uncertainty), :39 (week-clustered lower confidence bound).

### 2b. Append-only / immutable identity, idempotent retries, linked to a content-addressed input — GENUINE, widely held
- Event sourcing (Fowler 2005), Kleppmann, Designing Data-Intensive Applications (2017) ch.11 immutable logs; regulated trading record-keeping (SEC 17a-4 WORM retention; MiFID II algorithmic-trading record-keeping) — decisions are never edited, corrections are appended.
- The project implements exactly this for the tape: migration 027:118-126 triggers (`decision events are append-only`, `decision runs are immutable`), 031:168-170, `invalidateDecisionRun` (nfl-decision-tape.js:452-463) appends rather than edits; observation-key idempotency (nfl-decision-tape.js:243-250, 352-371).
- Gap-strengthening fact: nfl_t60_observations has NO append-only trigger (migration 034:35-58 vs the triggers only on nfl_capacity_events at 034:83-88). The 'missed' denominator record is therefore mutable at the schema level, unlike the tape it is supposed to feed.

### 2c. "Exactly one tape run per game x cutoff" — IMPLEMENTATION CHOICE, not a standard
- The tape's unit is a board: `recordDecisionRun` writes one header with `decision_count` events (nfl-decision-tape.js:376-421). Same-kickoff games share one cutoff and are the only ones legitimately ranked together (nfl-t60-protocol.js:56-68 `cutoffBatches`; sequentialCapacity ranks within batch, 134-137). One run per cutoff batch with one event per game satisfies the principle exactly as well as one run per game. The standard requires one recorded outcome per denominator unit; it does not fix the run granularity.

### 2d. "State selected/abstain/missed/unavailable" on the tape — VOCABULARY CONFLATION, but the codebase is itself inconsistent here
- Migration 034:26-29: "The observation row is deliberately NOT the decision tape. The tape records what a computation decided; this records whether the computation happened at all."
- nfl-decision-tape.js:80-84: computation_status 'unavailable' "is the row that keeps a missed T-60 capture in the denominator rather than letting it silently disappear from coverage."
- Two competing designs for where 'missed' lives. The principle only requires that the two reconcile (every observation row resolves to exactly one tape run or one explicit unavailable/missed record, and coverage joins them). Today nothing joins them: decision_run_id is never set.

## 3. NFL sample size (272 games/season)
- Sample size argues FOR the ledger, not against it. One missing game is 1/16 = 6.25% of a week's denominator, 1/272 of a season; with ~5 picks/week (~85 bets/season) the SE of a win rate is ~sqrt(.25/85) ~ 5.4 pp, so W/L ROI cannot resolve a 52-55% edge in a season. That is precisely why the project's declared endpoints are CLV (lower variance, manual:28, :549), week-clustered intervals (manual:39, :613), and an always-valid sequential test (scheduler.js:911; superseded-plan:694 caveat; :666 confseq reference). Every one of those needs a complete, immutable per-observation denominator as its input. A ledger principle is sample-size-independent; the smaller n, the larger the bias from each silently dropped or post-hoc-overwritten unit.
- The project's own RETURN-TO-CODEX.md:271-274 says the same: "how often a capture is missed. Those are the numbers §4's power analysis says nothing else can substitute for."

## 4. Refutation attempts that failed
1. "The runner does record decisions via the pipeline" — no: runner never imports the tape (t60-runner.js:27-32); pipeline only manual (routes/nfl-market.js:323; pipeline:118-141 labels itself unscheduled).
2. "nfl_pick_decisions is the tape" — no: the tape module itself disclaims it (nfl-decision-tape.js:4-9, 61-64); UPSERT key omits version/cutoff (nfl-auto-picks.js:212).
3. "SEA-NE is in the coverage report so nothing is lost" — `never_scheduled` is computed at read time from game_lines (t60-runner.js:262-265); a reschedule or row change alters the denominator retroactively; nothing durable says a capture was ever due for SEA-NE.
4. "The packet hash gives reproducibility" — the packet is not persisted (no INSERT in nfl-t60-packet.js); the hash is dangling.
5. "Standard cannot apply at 272 games" — see §3; it applies more, not less.

## 5. Corrected statements
- Corrected evidence: SEA-NE is absent from nfl_t60_observations, nfl_decision_runs and nfl_decision_events, but PRESENT in nfl_pick_decisions with recorded_at 2026-09-12T05:36:03Z and quote_at 2026-09-12 04:42:45, ~53h after its 2026-09-10T00:20Z kickoff and after the final score landed — a post-outcome overwrite, not a prospective record.
- Corrected should-be: Every observation the runner opens (cutoff x game, from the schedule as declared at open time) must terminate in exactly one immutable record — a tape run (per cutoff batch or per game; one decision event per game, eligible or abstained) linked via decision_run_id and carrying the hash of a PERSISTED packet, or an explicit missed/unavailable record that is itself append-only. The denominator is the set of observation rows opened ahead of the cutoff, never a read-time join against mutable game_lines; a game that was never opened is recorded as such at the time, not inferred later.
