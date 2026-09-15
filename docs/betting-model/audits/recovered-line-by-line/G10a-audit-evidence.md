# G10a — Audit & evidence machinery (historical replay, blind forward, registries, ledgers)

Reader: G10a-audit-evidence · Date: 2026-09-12 · Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only)
Files: 24 · Lines read: 5440 (every file read end-to-end; lines_read == wc -l for each)

All paths below are relative to the repo root. DB facts come from `node:sqlite { readOnly: true }` one-liners against `server/data.sqlite` on 2026-09-12.

## 0. Executive summary

The audit stack has three distinct mechanisms that are frequently conflated in the docs:

1. **Historical week-chain replay** (`nfl-blind-audit.js`, run via `scripts/nfl-blind-audit.mjs`): preregisters a spec (seasons 2021-25, weeks 5-18, engine/registry/policy versions), freezes a content hash of server code + a per-table hash of 31 input tables, then opens one (season, week) at a time. Each opened week replays the player engine, the three betting markets (separately), the expert council and postgame truth, chains a SHA-256 over the prior week's chain hash, and persists it immutably. **The controller itself never enforces a point-in-time cutoff** — it delegates that entirely to `nfl-ensemble.js` (`week < target`, lines 262/724/845/1028-1053) and `nfl-expert-council.js` (kickoff cutoff, line 466). What the controller enforces is *no mutation during the run* (code hash + data hash + mutation-journal watermark), which is a different property.
2. **Audit registry** (`audit-registry.js`, driven by `scripts/audit-*.mjs`): preregister a hypothesis + threshold, run once, seal, Šidák-correct across all sealed audits. Sound design; **the two scripts that use it pass `pValue`/`sampleSize` while the registry reads `p_value`/`sample_size`**, so audits 13/14/15 were sealed with NULL p-values and NULL sample sizes and, because they demand significance, were structurally forced to FAIL regardless of the data.
3. **Forward ledgers** (`forward-ledger.js` = football-first picks, 0 rows; `shadow-ledger.js` = auto-pick decision board, 189 NFL rows for 2026 W1-W2, 14 settled). `shadow-ledger.js` grades CLV against `game_lines.spread` (the live column) while `forward-ledger.js` — same author, same month — explicitly prefers `closing_spread` because `spread` can be clobbered after kickoff.

Input mutations (`nfl_blind_input_mutations`, 5,103,652 rows, `AUTOINCREMENT`): 31 tables carry INSERT/UPDATE/DELETE triggers that append `(table_name, operation, changed_at)`. Only `MAX(id)` is consumed as a watermark; the T-60 runner alone appended 442,045 rows between 2026-09-11 00:01 and 2026-09-12 07:18. There is no pruning anywhere in server/ or scripts/. Because the journal churns constantly in-season, the "skip the rehash if nothing moved" shortcut at `nfl-blind-audit.js:239` never fires during the season, so every opened week rehashes all 31 tables twice — once before compute and once **inside `BEGIN IMMEDIATE`** (line 888-893), where run 32 averaged 21.5 s of persist time (max 63 s; run 31 max 414 s) against a 15 s `busy_timeout` (`server/db/index.js:18`).

Results counting (C09): `nfl-audit-overview.js` recounts from the pick-level records rather than the per-week summaries, case-normalises `Won/won/win`, names corrupt weeks, keeps zero-bet weeks in coverage and lists missing weeks explicitly. I verified the logic line by line; it is correct as written and reconciles summary vs picks with a 0.5-unit tolerance.

Candidate findings ledger: one finding exists (`spread_x_timing|big spread (7+) + late (wk14+)`, direction `weak`, state `discovered`), registered manually with all five seasons 2021-25 locked as discovery. It needs three holdout passes from real seasons ≥2026, so the earliest it can reach `flagged_for_review` is after the 2028 season; `promotedFindingVeto` is a guaranteed no-op until then.

Verdict: **acceptable**. The architecture is sound and unusually careful; the defects are contract mismatches and a stale close-line source, not design holes. No leakage of week N+1 data into week N was found inside these 24 files.

---

## 1. Per-file notes

### 1.1 server/services/nfl-blind-audit.js (1005 lines) — ACTIVE
**Purpose.** Content-addressed, week-at-a-time historical replay controller.
**Imported by.** scripts/nfl-blind-audit.mjs, scripts/nfl-2022-2025-rebuild.mjs, server/routes/nfl-betting.js (routes at :364/:371/:398/:403), server/db/schema/nfl-a-to-m.js (comment reference), test/blind-audit-lookback.test.js, test/model-integrity.test.js, test/nfl-blind-audit-team-scope.test.js, test/nfl-moneyline-domain.test.js.

**Run lifecycle.**
- `preregisterBlindAudit` (199-224): `repositoryState()` first (git HEAD + content hash of every tracked/untracked file under `server`, `scripts`, `package.json`, `package-lock.json`; the commit id is recorded but NOT hashed, line 73-79), refuses a dirty tree unless `allowDirty`, then inside `BEGIN IMMEDIATE` computes `inputDataState` + journal watermark and inserts `nfl_blind_audit_runs` status `registered`.
- `runNextBlindAuditWeek` → `openNextWeek` (830-915): status gate (complete/failed/cancelled), `assertFrozen`, pick `spec.schedule[next_ordinal]`, compute inside `withEphemeralEnsembleArtifacts` (expert council → postgame packets → betting → player), chain the look-back from the previous week's stored `lookback`, compute `resultHash` and `chainHash = sha(prior:ordinal:season:week:resultHash)`, then `BEGIN IMMEDIATE` → **second `assertFrozen`** → insert week row, persist expert audit + postgame packets, and on the last ordinal store `aggregate()` as `final_json`.
- `failBlindAudit` (917-926) seals `failed`. Nothing in this file writes `cancelled`; the status is honoured at 847 (run 11 carries it, so a route or manual SQL set it).
- Retries: a failed open is journaled to `nfl_blind_audit_retries` (829-839). DB shows retries for runs 16, 19 (code changed), 21 (nfl_ensemble_fit_artifacts), 22-25 (nfl_team_cards), 28 (nfl_teams) — i.e. the freeze has been doing real work.

**The freeze (`inputDataState`, 95-157).** Per-table SHA-256 over `JSON.stringify(row)` for every row in scope, `ORDER BY rowid`. Scope rules: `players` → only `id,name,position,gsis_id WHERE gsis_id IS NOT NULL`; `nfl_teams` → only `id,abbr,name,conference,division`; season tables → `season<=maxSeason`; news/quotes/roster events → timestamp `< (maxSeason+1)-03-01`; `weekly_ensemble_fits` → `through_season<=maxSeason`; everything else (`player_week_usage`, `nflverse_player_positions`, `nfl_ensemble_fit_artifacts`, `nfl_quote_tape`…) all rows. I verified the `nfl_teams` exclusion claim: the only reader of `head_coach/oc_name/dc_name/off_scheme/def_scheme` is `server/services/nfl-pregame.js:21`, which is reached only from `evidence-daemon.js:13` (forward capture) and `nfl-auto-picks.js:13` (live board) — not from the historical replay. So the exclusion does not open a leak.

**Mutation watermark (`assertFrozen`, 232-249).** `priorMutation = mutationCursor.get(run) ?? spec.provenance.input_guard.mutation_id`; if `MAX(id)` of the journal hasn't advanced past it the data hash is skipped; otherwise rehash and compare. `nfl_blind_input_mutations.id` is `INTEGER PRIMARY KEY AUTOINCREMENT` (verified via sqlite_master), so the watermark is monotonic even if rows were ever deleted — the shortcut is safe.

**Betting week (282-339).** Each market replayed separately (`replaySeason(season,{startWeek:week,endWeek:week,markets:[m]})`), merged by `combineBettingSummaries`. Picks get an `explainPick` trace from a cutoff-safe `ensembleLine` call.

**Look-back (701-827).** Per-specialist week + cumulative (chained from prior week's stored lookback), coordinator weight drift, beat-the-close shadow rows (`shadow_decisions … model_version LIKE 'beat-the-close-v%' AND season=? AND week=?` — writer verified at `beat-the-close.js:259-263`, which does populate `season,week`; zero rows for 2021-25 by construction), and `historicalOpenerReplay` (672-699) grading nfelo-pre-vs-open and TeamRankings-vs-open by CLV to Pinnacle close from `nfl_odds_archive`. Sign convention checked: `y = open − close`, take home when external sits ≥0.5 past the opener toward home, `clv = value>0 ? y : −y` — consistent with line-move-study.

**Point-in-time.** Not enforced here. `result.cutoff = "${season}-W${week-1}"` (860) is a label only. Cutoffs live in `nfl-ensemble.js` and `nfl-expert-council.js` (verified by grep, see §0).

**Defects.**
- D1 (P2) `nfl-blind-audit.js:888-893` — the second `assertFrozen` runs a full 31-table rehash while holding the `BEGIN IMMEDIATE` writer lock. In-season the journal always advances (T-60 runner: ~440k rows/day), so the shortcut at :239 never fires. Measured: run 32 persist avg 21,506 ms, max 63,389 ms; run 31 max 414,454 ms; `busy_timeout` is 15,000 ms (`server/db/index.js:18`). A concurrent writer (the live server capturing a T-60 window) will hit SQLITE_BUSY. Snippet: `db.exec('BEGIN IMMEDIATE'); try { … assertFrozen(record);`. Fix: recompute the data hash *before* taking the lock, take the lock only for the compare-and-insert, or compare per-table hashes only for tables whose journal rows advanced.
- D2 (P2) `nfl-blind-audit.js:983-984` — `estimated_remaining_ms: averageTotalMs * Math.max(0, record.spec.schedule.length - weeks.length)` uses `weeks.length`, which is 0 when `listBlindAudits` calls with `weekLimit: 0` (992). Every run in the list view, including complete ones, reports `avg × 70` ms remaining. Should use `opened` (962).
- D3 (P2) `nfl_blind_input_mutations` growth — 5,103,652 rows, +442,045 in the last ~31 h, no `DELETE` anywhere in server/ or scripts/. Only `MAX(id)` is ever consumed (`:56`), plus `table_name` for an error string (`:58-59`). Every trigger fire on `nfl_line_snapshots`/`nfl_quote_tape` (1.77M + 1.61M rows already) is pure write amplification on the live capture path. Fix: prune below `MIN(cursor)` over non-terminal runs on each preregister, or replace the journal with a per-table counter row updated by the trigger.
- D4 (P3) `nfl-blind-audit.js:81` `process.cwd()` for `git ls-files` — `server/platform/code-identity.js:24-28` and `nfl-replay.js:975-983` document that this class of identity must never depend on cwd or git. `scripts/start.mjs:80,86` pins cwd to ROOT so it is correct today; from any other cwd the pathspec matches nothing and the code hash is the hash of the empty set (`files: 0` would be visible in `spec.provenance.code.files`). Recommend reusing `code-identity.js`.
- D5 (P3) `nfl-blind-audit.js:285` `.filter(x => !x.replay.error)` silently drops a market whose replay errored; `runManifest.failures` only records the case where *all* markets error (:545).

**Verdict.** Active, the centre of the historical machinery, correct on the properties it claims. Fix D1 before running another audit during a live capture window.

### 1.2 server/services/audit-registry.js (333) — ACTIVE
**Purpose.** Preregister-once, seal-once hypothesis registry with Šidák + always-valid (mSPRT) gates.
**Imported by.** scripts/audit-football-first.mjs, scripts/audit-trend-totals.mjs, server/routes/betting-hub.js (:676 `auditHistory`), server/db/schema/core-and-fantasy.js (comment), test/audit-registry-always-valid.test.js.
**Reads/writes.** `audit_registry` (insert on preregister, update on run). `codeHash()` hashes every `.js` in server/services; `dataSignature()` is row counts of six tables.
**Contract.** `runAudit(id, producer)` reads `result.observed`, `result.p_value`, `result.sample_size`, `result.sequence`, `result.detail` (:184-236). The test suite uses exactly these names (test/audit-registry-always-valid.test.js:39-41,54). It returns `{observed, passed, significant, always_valid, sample_size, p_value, …}` — **no `detail` and no `detail_json`** (:244-271).
**Defects.**
- D6 (P3) `audit-registry.js:62-70` `dataSignature` uses `COUNT(*)` of `nfl_line_snapshots` (+1.77M and rising) so any audit sealed in-season is flagged `data signature changed since preregistration` (:237) even when preregister→run is one process. Cosmetic but it makes the flag meaningless.
- (Contract mismatch is filed against the scripts, D12/D13.)
**Verdict.** Good.

### 1.3 server/services/nfl-audit-overview.js (272) — ACTIVE
**Purpose.** C09-corrected per-market scoreboard from stored week JSON; `compareAuditRuns` via stored `result_hash`.
**Imported by.** server/routes/nfl-betting.js, test/audit-overview-counting.test.js, test/nfl-audit-overview.test.js.
**Counting (verified).** Iterates `nfl_blind_audit_weeks` in ordinal order; corrupt JSON → `corrupt_weeks` (:73-78); every parsed week enters coverage before the betting check (:81-91); per-market tallies come from `betting.picks[]` with case-normalised results (:116-121) and explicit `voids`/`unknown_results`/`missing_units`; summary reconciled with a 0.5-unit tolerance (:148-150); `spread_only` block uses the same vocabulary (:187-196) and the weekly-cluster bootstrap `uncertainty()` from nfl-replay (which filters on `'Won'/'Lost'` — but `allBets` stores the lower-cased result, see D7).
**Defects.**
- D7 (P2) `nfl-audit-overview.js:125-126,221` — `allBets` rows carry `result` lower-cased (`'won'/'lost'/'push'`), then `uncertainty(spreadBets)` is called; `nfl-replay.js:44,57-58` filters `b.result === 'Won' || b.result === 'Lost'`. So every draw has `graded.length === 0` → `winRate: 0` and `win_rate_95` collapses to `[0, 0]`, while `roi_95` (which uses `units`) is right. The spread-only interval is therefore wrong. Fix: pass the original-case result (or normalise inside `uncertainty`).
- D8 (P3) `nfl-audit-overview.js:171` parses `weeks.split('-')[0]` from a string it just built (:165); use `c.min_week`.
**Verdict.** Good apart from D7.

### 1.4 server/services/nfl-diagnostic.js (161) — ACTIVE
Aggregator for the "health report" endpoint; imported by server/routes/nfl-betting.js and server/services/report-cache.js. Reads `news_items`, `nfl_historical_signal_replay`, and pulls in ~12 other status functions. `bottlenecks[0].severity: 'critical'` and `[3]` are constant strings (:82-103) — narrative, not measured. No defects beyond that (P3 hygiene).

### 1.5 server/services/nfl-abstention-audit.js (195) — ACTIVE
**Purpose.** Grade the counterfactual outcome of every abstention by reason, Wilson intervals, two-proportion z between taken and declined pools.
**Imported by.** server/routes/betting-hub.js, server/services/report-cache.js.
**Verified.** `replaySeason` decisions carry `won`, `pushed`, `american_price`, `eligible`, `abstention_reason` (nfl-replay.js:249-250), so `summarize()` at :78-95 reads real fields.
**Defects.**
- D9 (P3) `nfl-abstention-audit.js:105-117` comment says the memo is "cleared with the model cache"; `clearAbstentionAuditCache` has zero callers anywhere in server/ (grep). The five-season result is cached for the life of the process even after data refresh.
**Verdict.** Good; honest framing ("hypothesis generator").

### 1.6 server/services/nfl-candidate-findings.js (404) — ACTIVE
**Purpose.** Segment-finding lifecycle ledger with season-role locking, holdout confirmation, rule-hash identity, human-only promotion, and `promotedFindingVeto` for the live board.
**Imported by.** server/services/nfl-auto-picks.js (veto), server/services/nfl-model-growth.js (season-end orchestrator), test/nfl-candidate-findings.test.js, test/nfl-cover-identity.test.js.
**Tables.** `nfl_candidate_findings`, `nfl_candidate_finding_seasons` (UNIQUE(finding_id, season)). DB: one finding (`discovered`, `weak`, rule hash present), seasons 2021-25 all role `discovery`.
**Verified.** `segmentRuleHash` folds `direction` (derived from `win_rate < 0.5`) and a code fingerprint, not the actual win rate (nfl-replay.js:848-851), so the `0.4/0.6` placeholder at :48/:211 reproduces the discovery hash correctly. `runCandidateFindingsForSeasonEnd` defers while a run is `running` (:246-249). `promotedFindingVeto` early-returns with no promoted findings (:313).
**Defects.**
- D10 (P3) `nfl-candidate-findings.js:119-120` doc says holdout seasons must come *after* the discovery seasons; `assertSeasonRoleAvailable` (:85-90) only enforces disjointness. Today moot (all five audited seasons are discovery), but a future manual registration on 2023-24 could be "confirmed" on 2021.
- D11 (P3) `nfl-candidate-findings.js:314` `gameContext()` loads every home row of `game_lines` per bet on the live path once any finding is promoted (nfl-replay.js:614-620). Cache per board build.
**Open.** Finding 1 cannot be tested before three completed seasons ≥2026 (2028 at the earliest).
**Verdict.** Good.

### 1.7 server/services/nfl-candidate-analysis.js (313) — ACTIVE
**Purpose.** Champion vs candidate robustness: attribution, fixed-volume, edge calibration, leave-one-signal-out ablation, cutoff-safe reliability replay (examples appended only after the week is judged, :96-102 — verified correct), season-drop.
**Imported by.** server/routes/nfl-betting.js, server/services/nfl-diagnostic.js (`latestCandidateRobustnessReport`), server/db/schema/nfl-a-to-m.js (comment).
**Defects.**
- D12 (P2) `nfl-candidate-analysis.js:211` `verdict: 'The candidate is not profitable. …'`, `:220-222` `data_integrity.state: 'not_primary_failure'`, `:234-235` `regime_instability.state: 'critical'` are constant strings inside a function whose other fields are measured. The report is surfaced in `nflDiagnostic` (`candidate_robustness`) as if computed. If a future candidate were profitable the sentence would still say it is not.
- D13 (P3) `buildCandidateRobustnessReport` runs 2+2+9 full replays × 5 seasons synchronously (:268-275); route callers should be aware.
**Verdict.** Acceptable.

### 1.8 server/services/nfl-coordination-audit.js (63) — ACTIVE
Descriptive component-wiring audit; imported by nfl-diagnostic.js and test/model-integrity.test.js. `verdict` (:48) and `hard_truths` (:49-55) are static prose; only `cover_calibration` and `production_state` are computed. P3 hygiene only.

### 1.9 server/services/nfl-slice-diagnostic.js (148) — ACTIVE
Calibration/accuracy by slice from `nfl_weekly_expert_examples` joined to `game_lines`; 2021 quarantined; `readable` floor 30. Imported by server/routes/nfl-betting.js, nfl-blind-audit.js (`runManifest.calibration`), test/nfl-slice-diagnostic.test.js. Read every line; arithmetic (normal CDF, ECE weighting :102-103) checks out. No defects.

### 1.10 server/services/nfl-passing-diagnostic.js (155) — ACTIVE
Walk-forward attempts × YPA decomposition on `propReplayRows`. Verified `propReplayRows` iterates seasons ascending and weeks ascending (nfl-props.js:79-93), so the per-player `history` at :115-141 never sees a later week. Oracle rows labelled non-promotable. Imported by scripts/diagnose-passing-components.mjs, server/routes/nfl-betting.js, test/model-integrity.test.js. No defects.

### 1.11 server/services/nfl-page-explain.js (134) — ACTIVE (paid API)
Tool-use loop (max 4 rounds, tools omitted on the last) around `callClaude`; explanation-only. Imported by server/routes/betting-hub.js:32,892. Reads `client/src/pages/betting/TERMINOLOGY.md`. `NOT_PROVEN_MESSAGE` duplicated by hand from client `copy.ts` (:36-40, P3 drift risk). Tool inputs come from the model and are executed by `runTool` (page-explain-tools.js, not in scope) — worth a separate check that every tool is genuinely read-only. No defects in this file.

### 1.12 server/services/nfl-page-explain-audit.js (35) / 1.13 nfl-pick-explanation-audit.js (25) — ACTIVE
Provenance rows (`nfl_page_explain_audits`, `nfl_pick_explanation_audits`) with `authority='wording_only'`. Callers (betting-hub.js:893, nfl-betting.js:518) do not pass `model`, so the stored model is the hard-coded default `'claude-haiku-4-5-20251001'` (:16 / :9); `claude.js:99` currently defaults to the same string, so it is accurate today but recorded from a second copy (P3, D14).

### 1.14 server/services/forward-ledger.js (335) — ACTIVE (0 rows)
**Purpose.** Append-only football-first ledger; refuses post-kickoff rows; settles with CLV against the frozen close.
**Imported by.** server/routes/nfl-betting.js, server/services/nfl-model-growth.js, server/services/scheduler.js (`refreshForwardSettlement`, live cadence), server/db/schema/core-and-fantasy.js, tests.
**Verified.** Sign conventions (:154-176) correct: `line_at_pick` stored as backed side's handicap; `cover = sideMargin + line`; `clv = line_at_pick − closing`. Close source `closing_spread ?? spread` (:154-155). `needed()` matches the doc header (0.03 → 1065).
**Defects.**
- D15 (P3) `forward-ledger.js:81,99-102` — exported `recordForwardPick` accepts a caller-supplied `recordedAt` that is used as `now` for the kickoff check. Only tests pass it today (grep), but the route module imports this file; if ever exposed, a backdated `recordedAt` bypasses the "not after kickoff" guarantee during the window between kickoff and score ingestion.
**Verdict.** Good.

### 1.15 server/services/shadow-ledger.js (122) — ACTIVE (189 NFL rows)
**Purpose.** Freeze the auto-pick decision board (champion + challenger modes) once per event/market/model_version; settle with CLV.
**Imported by.** server/services/evidence-daemon.js, model-intelligence.js, nfl-model-growth.js, server/db/schema/mlb-model-misc.js, five tests.
**Defects.**
- D16 (P1) `shadow-ledger.js:71-72,83,90` — closing line taken from `game_lines.spread`/`total`: `SELECT spread,total,team_score,opp_score FROM game_lines …` then `closingLine = game.spread == null ? null : backedHome ? game.spread : -game.spread`. `game_lines` has `closing_spread`/`closing_total` (PRAGMA verified), written by `gamescript.js:152-153` as "the last observation strictly before kickoff … frozen for good". `forward-ledger.js:149-155` states the reason: "the live spread/total, which syncCurrentLines can overwrite with an in-game number after kickoff", and `scheduler.js:219-222` records that this was "actively wrong" before the fix. `shadow-ledger.js` never received that fix, so the CLV in the ledger that `validationFirewall` and the profitability gates count as the "untouched forward evidence" is graded against whatever `spread` holds at settle time. Week 1 happens to be unaffected (LAR `spread = closing_spread = −3.5`), but the exposure is every future week. Fix: `COALESCE(closing_spread, spread)` exactly as forward-ledger does.
- D17 (P3) `shadow-ledger.js:25-31` mis-indented block inside the loop; hygiene.
**Verdict.** Messy on one load-bearing line.

### 1.16 server/services/nfl-evidence.js (179) — ACTIVE
**Purpose.** Source registry + validation windows + evidence coverage + `validationFirewall` (counts distinct observed shadow decisions toward `FORWARD_SAMPLE_TARGETS`).
**Imported by.** routes nfl-betting.js, nfl-market.js; services nfl-profitability.js, nfl-research.js; server/db/schema/nfl-a-to-m.js; tests.
**Defects.**
- D18 (P3) `nfl-evidence.js:50-66` — module-level `run(INSERT … ON CONFLICT …)` executes on import, so merely importing this module (e.g. from a test or a read-only tool) writes `nfl_source_registry`/`nfl_validation_windows`. Move into an idempotent `ensure()` called by the server bootstrap.
**Verdict.** Good.

### 1.17 server/services/nfl-evidence-dataset.js (239) — ACTIVE
Quote-tape extraction with four chronology quarantines, content-hashed freeze to `server/data/evidence-datasets/<hash>/`. Imported by scripts/build-evidence-dataset.mjs, server/services/nfl-research-lab.js, test/evidence-dataset.test.js. Timestamp comparisons are lexical (:95-97); the tape mixes `…:08.094Z` and `…:00Z` spellings (DB sample), so a snapshot in the same second as kickoff can pass `snapshot_at < commence_time` by string order (sub-second; P3, D19). `readFrozenRows` (:234-236) reads the whole JSONL into one string — the same V8 string-length cap the writer comment (:191-196) worked around (P3, D20).

### 1.18 server/services/nfl-evidence-provenance.js (62) — ACTIVE
Walks `nfl_expert_forward_predictions.payload_json` for any `*_at` ISO stamp later than `evidence_cutoff`. Imported by server/routes/nfl-market.js, server/services/nfl-news-events.js, test. DB: 2026 W1 2,289 rows / W2 336 rows, zero `captured_at > evidence_cutoff`. No defects.

### 1.19 server/services/evidence-daemon.js (198) — ACTIVE (the T-60 runner)
Plans six horizons per unplayed game, runs due windows (never retrospective: `event_at >= now−5min`, :72-75), captures context + Odds API (reserve-guarded) + SGO + free book feeds + shadow board + neural + risk-lab + expert council per horizon; bounded partial retries (3). Imported by scheduler.js (tier `live`, maxAge 5 min, with a "tier still running — skipping" guard at scheduler.js:1127), routes mlb.js/nfl-market.js, model-intelligence.js, tests. DB: 1,059 captured / 209 partial / 2,500 queued windows. No defects found; note that `mark()` (:79-85) stamps every window in a (season, week) group with one status, so one game's failure marks all games' windows partial (design choice, P3 at most).

### 1.20 server/services/nfl-postgame-truth.js (657) — ACTIVE
**Purpose.** Immutable postgame packets (gameplay summary, player/group actualisation, in-game injury exits with replacement value, residual variance decomposition, frozen-expert comparison, carry-forward injury opinion for the next week).
**Imported by.** nfl-blind-audit.js, nfl-diagnostic.js, nfl-expert-council.js (:473 `gameInjuryCarryover` feeds the council in the historical replay), nfl-model-growth.js, nfl-unified-engine.js, server/db/schema/nfl-n-to-z.js, two tests.
**Point-in-time.** `carryoverForTeam` (:497-559) reads prior packets strictly before (season, week) (:498-500), the *target* week's `nfl_injuries` (:507 — the official weekly report, pregame by nature but not publication-stamped, per nfl-evidence.js:41-43), and `playerNewsSignal(…, before: cutoff)` with `cutoff = kickoff` (:508,:514). Acceptable; flagged as an open question rather than a defect.
**Defects.**
- D21 (P2) `nfl-postgame-truth.js:383-385` — `if (play.play_type === 'fg_miss' || /blocked/i.test(text) && /field goal|extra point/i.test(text)) { … home_points: sign * 3 …}` charges a missed/blocked **extra point** as 3 variance points. `variance_points`/`adjusted_residual` (persisted to `nfl_game_variance`, :597-599) are off by 2 for every such game.
- D22 (P3) `nfl-postgame-truth.js:377,413` — `driveShortField` is a module-level mutable `let` (declared after first use at :413) shared across calls, and `residualDecomposition` mutates its input plays (`play._shortField`, :374-375). Reset on the first offense change makes it benign in practice.
- D23 (P3) `nfl-postgame-truth.js:219` `side === 'offense' ? play.is_turnover : play.is_turnover` — identical branches.
- D24 (P3) `nfl-postgame-truth.js:162-163` one query per player per game (N+1) inside a 5,780-packet backfill.
**Verdict.** Acceptable.

### 1.21 scripts/nfl-blind-audit.mjs (33) — ACTIVE entry point (`npm run audit:nfl`)
protocol / preregister / status / next / run [max-weeks]. `run` loops `runNextBlindAuditWeek` until complete — every iteration returns the full status (all weeks' JSON parsed) which is O(n²) over a 70-week run (P3). No other defects.

### 1.22 scripts/audit-passing-specialists.mjs (4) — ACTIVE entry point (`npm run audit:nfl-passing-specialists`)
Prints `passingSpecialistAudit()`; file exists. Nothing to audit.

### 1.23 scripts/audit-football-first.mjs (163) — ACTIVE entry point (standalone)
Preregisters "football-first beats the closing spread (five held-out seasons)" with `requireSignificance: true`, then scores `footballFirstLean` on `game_lines` weeks ≥5, 2021-25.
**Defects.**
- D25 (P1) `scripts/audit-football-first.mjs:121-124` returns `{ observed, sampleSize, pValue, detail }` while `audit-registry.js:199,234-235` reads `result.p_value` / `result.sample_size` (and the registry's own test uses those names). Consequence, verified in `audit_registry`: audit 14 (`observed 0.5789`, require_significance 1) and audit 15 (`0.4835`) sealed with `p_value NULL`, `sample_size NULL`, `significant NULL`, `passed 0`. Because `passed = meetsThreshold && significant === true && alwaysValidSignificant === true` (:226-228), the verdict is forced to FAIL before any evidence is looked at, and — the registry being seal-once — the p-value is permanently unrecorded for a hypothesis the docs still cite as "33-24, 57.89%, z = 0.834". No `sequence` is supplied either, so the always-valid gate cannot pass even after renaming. Fix: rename keys, and pass the per-bet `won − BREAK_EVEN` sequence.
- D26 (P3) `:140-142` reads `result.detail_json ?? result.detail`; `runAudit` returns neither, so the printed RESULT block is all `undefined` (the DB row is fine).
- Open: the script's cutoff claim rests on `footballFirstLean` fitting on prior seasons only ("see residualModel"); not verified here.

### 1.24 scripts/audit-trend-totals.mjs (205) — ACTIVE entry point (standalone)
Same registry pattern; cutoff-safe by `throughWeek = week − 1` (:118,:123). Header records audit #13 as "194 bets, 85-109, 43.81%, z = −2.39".
**Defects.**
- D27 (P1) `scripts/audit-trend-totals.mjs:163-166` same `pValue`/`sampleSize` mismatch; audit 13 in the DB has `p_value NULL`, `sample_size NULL`, `passed 0`. The one-sided p at :161 was never stored.
- D28 (P3) `:181-187` comment claims `detail_json` is the fix for undefined output; `runAudit` returns no such key, so the printed block is still undefined.

---

## 2. Wiring map

- scripts/nfl-blind-audit.mjs → nfl-blind-audit.js → {nfl-replay.js, weekly-backtest.js, nfl-ensemble.js (`withEphemeralEnsembleArtifacts`), nfl-expert-council.js, nfl-postgame-truth.js, nfl-slice-diagnostic.js, pick-reasoning.js} → tables nfl_blind_audit_runs / _weeks / _retries / _week_performance, nfl_weekly_expert_examples, nfl_postgame_truth_packets, nfl_game_variance.
- server/routes/nfl-betting.js → nfl-blind-audit.js (list/status/preregister/next), nfl-audit-overview.js, nfl-slice-diagnostic.js, nfl-candidate-analysis.js, nfl-diagnostic.js, forward-ledger.js, nfl-pick-explanation-audit.js, nfl-passing-diagnostic.js, nfl-evidence.js.
- server/routes/betting-hub.js → audit-registry.js (`auditHistory`), nfl-abstention-audit.js, nfl-page-explain.js + nfl-page-explain-audit.js.
- scheduler.js → evidence-daemon.js (live tier) → shadow-ledger.js (`recordNflShadowBoard`), nfl-pregame.js, line-shopping.js (paid), sportsgameodds.js, book-feeds.js, nfl-expert-council.js (`captureForwardExpertWeek`); scheduler.js → forward-ledger.js (`settleForwardPicks`).
- nfl-model-growth.js → nfl-candidate-findings.js (season-end), forward-ledger.js, shadow-ledger.js, nfl-postgame-truth.js.
- nfl-auto-picks.js → nfl-candidate-findings.js (`promotedFindingVeto`, currently no-op).
- nfl-expert-council.js:473 → nfl-postgame-truth.js (`gameInjuryCarryover`) — the postgame layer feeds the next week's council in the historical replay.

## 3. Data flows

1. Historical replay: spec (seasons/weeks/versions) → code hash + per-table data hash + journal watermark → per week: council → postgame packets → three market replays → player replay → look-back chained from prior week → result_hash → chain_hash → immutable row; final aggregate on the last ordinal.
2. Input mutation journal: 31 tables × 3 triggers → `nfl_blind_input_mutations(id AUTOINCREMENT, table_name, operation, changed_at)` → only `MAX(id)` consumed as a watermark by `assertFrozen`.
3. Registry: preregister(name, hypothesis, metric, direction, threshold) → run producer once → Šidák over sealed count + optional mSPRT over `sequence` → sealed row.
4. Forward: evidence-daemon windows → shadow board frozen per event/market/model → settle after final (CLV vs `game_lines.spread` — see D16) → `validationFirewall` counts distinct observed+settled toward the target.
5. Postgame: final score + ESPN pbp + team/player features + snaps → packet (hash over sources) → `nfl_game_variance` + `nfl_postgame_truth_packets` → next-week injury carryover into the council.

## 4. Leakage assessment (focus question)

- Week N+1 → week N inside these files: **none found.** The controller replays `startWeek=endWeek=week` and every model input cutoff is enforced in nfl-ensemble.js / nfl-expert-council.js (`week < target`, kickoff cutoff). `nfl-candidate-analysis.historicalReliabilityReplay` and `nfl-passing-diagnostic` are walk-forward by construction (examples/history appended only after the week is judged). `carryoverForTeam` reads prior packets strictly before the target and news strictly before kickoff.
- Where leakage *could* enter: (a) the target-week `nfl_injuries` read in `carryoverForTeam` (:507) has no publication timestamp, so a late-updated row (e.g. a Sunday-morning downgrade appended to the same week) would be treated as pregame; (b) `nfl_teams` coaching columns are excluded from the freeze on the claim that replay never reads them — true today (only nfl-pregame.js reads them, forward path only), but nothing enforces it; (c) `footballFirstLean` in `audit-football-first.mjs` — fit-on-prior-seasons is asserted in a comment, not verified here; (d) the freeze scope is `season <= maxSeason`, i.e. the entire audited season including its week 18 is in the hash — that is correct for *mutation* detection but means the freeze proves nothing about cutoffs.

## 5. Dead / duplicate

None of the 24 files is orphaned. Every service has at least one non-test importer; the four scripts are entry points (two wired in package.json, two documented as standalone).

## 6. Open questions

1. Who sets `status='cancelled'` on `nfl_blind_audit_runs` (run 11)? Not this file, not the routes grepped.
2. Runs 12, 13, 16, 18, 20, 21, 22, 29 are stuck at `registered` with `next_ordinal 0` — should stale registrations be sealed/failed so `runCandidateFindingsForSeasonEnd`'s `status='running'` guard and the list view stay honest?
3. Does `page-explain-tools.js` guarantee every tool is read-only (nfl-page-explain.js trusts `runTool` with model-chosen input)?
4. Is `footballFirstLean` genuinely fit on prior seasons only (audit-football-first.mjs:86 comment)?
5. Should the shadow ledger's per-event dedupe (first horizon wins, i.e. the opener) be what CLV is graded from, given the memory note that the opener path is dead for this model?
