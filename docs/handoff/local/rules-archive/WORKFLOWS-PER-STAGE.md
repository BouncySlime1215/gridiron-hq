# WORKFLOWS PER STAGE (2026-09-23 ~2:15 AM ET). Planning only until "go". Caps: ≤5 workflows and ≤6 active agents at once; before every launch: load < 10, memory free > 20%, 5-hour meter < 75%; past 85% nothing new launches and in-flight work finishes; every launch records scriptPath + args + runId in launch/resume/<task>.json (new bin/launch.sh) so a stop never restarts from zero.

## Workflow scripts
Existing: wf/build-unit.js (builder -> skeptics by risk tier -> fix loop -> serialized gate -> PR), wf/verify-pr.js (skeptics -> fix loop -> body; never marks ready), wf/rnd-loop.js (explorers -> validity + implementation assessors -> recorder), wf/synergy-review.js (every 8 merges). Ops: bin/merge-queue.sh, gate-merge.sh (logs + integration card), board keeper agent (Sonnet, 10-min ticks, ET).
New (written on "go", before phase 0 resumes):
- wf/finish-unit.js: takes a killed build's cached results (journal: builder + skeptics) as args and runs fix -> rechecks -> gate -> PR. Used once for BLEND-01, HX-01, S-03.
- wf/study-unit.js (statistical units): prereg writer (Opus) -> auditor review of the prereg (Fable) -> prereg COMMITTED -> analyst runs the study (Opus, Python 3.12 on this Mac) -> three skeptics (claims re-derived with their own code; leakage/as-of; holdout + MDE + BH) -> auditor sign-off (Fable) -> evidence PR through the build gate. Output: docs/evidence/<date>/<unit>-prereg.md (older commit) + <unit>-results.md + scripts.
- wf/train-model.js (ML units): data contract check -> training run (Python; trees/nets) with a registry entry (experiment, dataset hash, holdout) -> two skeptics (leakage/reproduction; calibration/baseline) -> auditor -> export (weights or table) -> build gate for the serving code. Nothing is promoted without leading its baseline.
- wf/lean-build.js (UI/docs/wiring units): one Sonnet builder, RED test first, targeted tests only, CI as the full check -> verify-pr.js lenses by risk -> merge-queue.
Models inside every workflow: builders Opus 5.5 (Sonnet in lean-build), skeptics Opus 5.5, the claims/statistics skeptic and the auditor Fable 5.1, recorders/PR-body/board Sonnet 5, mechanical Haiku 4.5.

## Phase 0: finish in-flight (about 5 h)
1. finish-unit.js: BLEND-01, HX-01, S-03 (one pipeline; cached skeptic findings as input; 3 fixers in parallel, then rechecks, gate one at a time).
2. verify-pr.js resume C-01 (wf_fe6a2e48-5b6; only the body step reruns) -> merge-queue.sh 160 -> then HX-01 after it lands.
3. skill-split resume (persisted script; only the report reruns) -> read the four skeptic verdicts -> report to Nick.
4. verify-pr.js run A fresh (B-01 #162, A-03 #163, SY-02 #161, C-12 #73) once 1 is past its fix stage -> merge-queue in order (#162 after B-01's auditor condition; #73 low).
5. Board keeper relaunched; integration cards by gate-merge; synergy review #2 after 8 merges.
Concurrency: 1+2+3 first (about 5 agents), then 4.

## Phase 1: Foundations (about 9 h)
- Batch F1 build-unit.js: CE-05, TR-01, TR-03 (risk high; auditor).
- Batch F2 study-unit.js: AI-01 true value, TM-09 market prices, TM-06 backtest + the FantasyCalc disagreement test (prereg first, then results).
- Batch F3 train-model.js: AI-04 price model (after TM-09 lands).
- Batch F4 build-unit.js: GR-05 stats contract, GR-01 recommendation ledger (medium).
Order: F1 ∥ F2 (2 workflows, ~8 agents at peak: run F2's three studies as a pipeline, not all at once) -> F3 -> F4. Merge-queue after each; intake cards; the FantasyCalc verdict is reported to Nick the moment its skeptics pass.

## Phase 2: Engine (about 10 h)
- E1 study-unit.js: CE-01 game sampler calibration, CE-02 player sampler + ranges (BLEND-02 layers only where proven).
- E2 build-unit.js: CE-01 code, CE-02 code, CE-09 one currency + ladder (extends tradeImpact), CE-06 event bus, CE-10 sim grading.
- E3 (alongside, from phase 4): ST-01 availability oracle via train-model.js -> CE-03 sampling.
Order: E1 -> E2 in pairs (CE-01+CE-02, then CE-09+CE-06, then CE-10) -> E3.

## Phase 3/4: Trade Machine v1 (STAY UNTIL DONE; about 14 h of running, likely 2 days with caps)
- T0 dossier agent (Opus, local-only study; no PR) ∥ LS-01 study-unit (Sleeper test) -> LS-01 build (lean-build for the job + chips; build-unit for the signal logic).
- T1 build-unit.js batch: TM-03 target board, TM-17 pain calendar, TM-30 reaction lag.
- T2 train-model.js: AI-05 acceptance (PU) -> replaces acceptanceBand's centre.
- T3 build-unit.js batch: TM-02 tags (with its study), TM-04 pitch ladder + counter evaluator (Coach verifier), TM-01 finder (his screen / real / odds delta).
- T4 build-unit.js batch: TM-05 decision tree, DD-01 doomsday cards, GT-01 game theory (planner-lite until CE-07).
- T5 build-unit.js batch: LL-01 luck ledger, GR-02 report card, GR-06 receipts + offer ledger.
- After every batch: merge-queue, intake, synergy review at 8 merges; researchers R1/R2 (rnd-loop lanes) one round in idle slots; exit criteria checked by an audit workflow (Fable auditor + wiring gate) before the phase is called done.

## Phase 4 alongside: start/sit + rhythm (about 6 h)
- S1 lean-build.js: SS-01 guard, WV-01 streaming board, WV-02 injury alert, WV-03 snap share, SK-01 command center (one Sonnet builder each; verify-pr lenses liveness+structure).
- S2 build-unit.js + study-unit.js: ST-02 floor/ceiling (history test), ST-03 late-swap windows (history test).

## Phase 5: AI tier (about 14 h; Jev cap first for the LLM pieces)
- A1 train-model.js: AI-02 usage forecaster (trees vs sequence net), AI-07 source inference, AI-08 regression classifier, AI-09 value net (kill-or-confirm day).
- A2 build-unit.js: AI-03 situation reader + TM-08 research feed (Jev), AI-06 twins (local index; aggregates only), AI-10 writer, AI-11 preference, CE-07 planner (MCTS), AI-12 model zoo page (lean-build).
- Researchers R3/R4 rounds feed this phase.

## Phase 6: continuous
rnd-loop.js with lanes R1-R6 one round per day; each valid + feasible find becomes a unit through build-unit / study-unit / train-model / lean-build by type; synergy review every 8 merges; re-audit of older evidence every 2 days (R units).

## Reporting cadence to Nick
Board every 10 min (keeper); a plain-English line to Nick at every merge that changes a number he sees, at every study verdict (FantasyCalc, backtest, twins), and at every phase exit; STOP file + resume JSON kept current at every launch.

RULES: see VERIFICATION-RULES.md (enforced by the v2 scripts on every new launch; resumes stay on the original scripts) and UI-STANDARD.md.
