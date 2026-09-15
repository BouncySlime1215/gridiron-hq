# G03 adversarial verification — lens: materiality

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). DB: server/data.sqlite via node:sqlite readOnly. Date of check: 2026-09-12 (live server PID 56651 started Sep 11 00:55:49 local).

## Claim-by-claim

### 1. "Week 1 decisions are not on the append-only tape" — TRUE
- Live DB: `nfl_decision_runs` 0 rows, `nfl_decision_events` 0 rows.
- Only writer of the tape is `recordDecisionRun`, called from `server/services/nfl-execution-pipeline.js:128` (`const tape = recordDecisionRun(season, week, board, {`), reachable only from `server/routes/nfl-market.js:323` (`r.post('/execution/run', requireModelPermission('model:train'), ...)`). No scheduled job calls it (`server/routes/nfl-market.js:314-317` says so explicitly).
- The scheduled ledger job `refreshNflDecisionLedger` (`server/services/scheduler.js:697-703`) calls `persistPickDecisions`, which is a mutable UPSERT: `server/services/nfl-auto-picks.js:208-217` `INSERT INTO nfl_pick_decisions ... ON CONFLICT(season,week,policy_id,matchup,market,selection) DO UPDATE SET line=excluded.line, ... recorded_at=excluded.recorded_at`.
- `nfl-decision-tape.js:4-11` documents exactly this defect ("writes a MUTABLE latest view ... overwrites what the model actually decided before it moved").

### 2. "The T-60 runner never records a decision" — TRUE
- `server/betting/nfl/strategy/t60-runner.js:126-131`: on capture, `UPDATE nfl_t60_observations SET state='frozen', packet_hash=? ...`. No `recordDecisionRun` import or call anywhere in the file. The only reference to `decision_run_id` is the read at `t60-runner.js:292`.
- Migration `server/migrations/034_t60_runner_ledger.js:46-47` declares states `'decided','abstained'` that nothing writes.
- Live DB: one observation (`nfl|2026-09-10|SF@LAR`, state `frozen`, `packet_hash e2bcd98f…`, `decision_run_id NULL`). `docs/evidence/2026-09-11/RETURN-TO-CODEX.md:271` already concedes: "`decision_run_id` is **empty**. No forecast consumed the packet."

### 3. "SEA-NE is absent from every ledger" — FALSE as stated
- Absent from `nfl_t60_observations`: yes. Runner last_detail (sync_log) lists `{"home":"SEA","away":"NE","kickoff":"2026-09-10T00:20:00.000Z",...,"reason":"cutoff_already_passed"}`. Cause is deployment timing, not a runner defect: the runner landed in commit `fced8d9 2026-09-10 13:40:51 -0400` (= 17:40Z), ~18h after the NE@SEA cutoff `2026-09-09T23:20Z` (`decisionCutoff` = kickoff − 60 min, `nfl-t60-protocol.js:31,45`). The runner correctly refused to reconstruct it (`t60-runner.js:82` `cutoff_already_passed`).
- PRESENT in `evidence_capture_windows` (event_key `2026:1:SEA:NE`) at all 6 horizons: open partial, T-24h captured 2026-09-09T03:44Z, T-6h captured 18:29Z, T-60m **partial** (`{"error":"database is locked","mode":"source_quarantined"}`, 2 attempts), T-15m partial (same), close captured 2026-09-10T00:23Z. `evidence-daemon.js:23-27` defines those horizons; `:138-141` marks partial on error. This IS a game×cutoff denominator with missed states, and it recorded the T-60m failure honestly.
- PRESENT in `nfl_expert_forward_predictions` (append-only: triggers `nfl_expert_forward_predictions_no_update/_no_delete` exist in sqlite_master) as `expert_id='combined_decision'` rows for SEA at horizons scheduled/open/T-24h/T-6h, each embedding the production decision at capture time via `nfl-expert-council.js:667-668` (`SELECT selection,...,eligible,abstention_reason FROM nfl_pick_decisions ... ORDER BY recorded_at DESC LIMIT 1`). E.g. T-6h captured `2026-09-09T18:26:53Z`: `"line":3,"price":100,"book":"espn","eligible":false,"abstention_reason":"calibration_not_proven"`. No SEA rows at T-60m/T-15m/close (games per horizon: 15 at T-60m/T-15m/close vs 16 at others) — the T-60m loss is the DB-lock failure above.
- PRESENT in `nfl_pick_decisions` — but the latest view for `NE at SEA` (and `SF at LAR`) was rewritten `recorded_at 2026-09-12T05:36:03Z` with `quote_at 2026-09-12 04:42:45`, i.e. two days after the game. That is the real defect the gap points at: the mutable view no longer says what was decided pre-kickoff.

## Materiality tests

### Would closing it change a number Nick reads? NO
- No route or UI component reads the tape or the T-60 ledger. `grep -rln nfl_decision_runs|decisionRunsFor|t60Coverage|nfl_t60_observations server/services server/routes server/modeling server/betting` → only `nfl-decision-tape.js` and `t60-runner.js` (plus pipeline, preflight, migrations, tests, docs). `t60Coverage` has no route. Client grep for `evidence/status|evidence/coverage|t60` → nothing.
- Abstention counts Nick sees are computed live from the board, not from any ledger: `routes/nfl-market.js:253` (`abstentions: decisionBoard.decisions.filter(d => !d.eligible)`), `nfl-candidate-analysis.js:175`, `nfl-replay.js:348`.

### Would it change a decision? NO
- All 16 wk1 rows: `eligible 0`, `abstention_reason calibration_not_proven`, `edge 0`. That reason is a fit-level gate applied identically to every candidate: `nfl-policy.js:198-200` (`policy.requireCalibratedAdvantage && candidate.calibration_eligible !== true`), fed by `nfl-cover-calibration.js:404` (`if (!fit.metrics?.forward_gate_passed) return { ..., reason: 'calibration_not_proven' }`), where `forward_gate_passed` (`:357-365`) is a historical walk-forward test (`walkForward.length >= 200`, Brier/log-loss vs market, `edge_predicts_covers`). It does not read the tape, so the tape cannot lift it; capture timing cannot change a slate-wide abstention.
- `nfl_execution_opportunities` 0. The 5 `nfl_auto_picks` wk1 rows were voided 2026-08-28 ("current policy abstains on every game in this slate"). Nothing staked, nothing to route.

### Would it change the validity of the historical/forward record? MARGINALLY, NOT NOW
- The prospective per-game decision for Week 1 survives append-only in the council `combined_decision` rows for captured horizons, with `evidence_cutoff` and `captured_at`, and the denominator (incl. misses) survives in `evidence_capture_windows`. What the tape would uniquely add: the full 16-candidate board + forecast content hash keyed to a packet hash, and immunity to the post-game UPSERT. Neither has a consumer today.
- The tape would not have rescued NE@SEA at T-60: the runner did not exist, and the alternative T-60m capture failed on `database is locked` — the same SQLite file the tape writes to.
- Forward look: Sunday's 14 games are queued (`evidence_capture_windows` status queued, first T-60m due `2026-09-13T16:00Z`); the runner will open them ≤24h ahead (`SCHEDULE_HORIZON_MINUTES = 24*60`, `t60-runner.js:39`) and freeze packets, still with no decision run. Same immateriality holds while the policy abstains slate-wide.

## Verdict
Refuted on materiality (downgrade). Real as an architectural incompleteness — a write-only tape with no scheduled writer and no reader, a runner that freezes packets nothing consumes — but closing it today changes no on-screen number, no decision, and no record anything currently evaluates. Materiality rises only when (a) something reads the tape (coverage/decision report), or (b) the calibration gate lifts and the policy can select — and (b) is driven by historical walk-forward, not by this ledger.
