# G03 adversarial verification (lens: code-truth) — 2026-09-12

Gap: Week 1 decisions are not on the append-only tape; the T-60 runner never records a decision; SEA-NE absent from every ledger.
Verdict: NOT refuted. All three code citations in CURRENT are accurate. One wording correction on "every ledger" (below).
Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). DB: server/data.sqlite via node:sqlite readOnly:true.

## Claim 1 — scheduler.js:697-703 persistPickDecisions -> nfl_pick_decisions UPSERT  [ACCURATE]
- server/services/scheduler.js:697 `const { autoPickDecisionBoard, persistPickDecisions } = await import('./nfl-auto-picks.js');`
- server/services/scheduler.js:703 `const decisions = persistPickDecisions(season, week, board);`
- server/services/scheduler.js:863 job `nfl_decision_ledger: { run: refreshNflDecisionLedger, maxAgeMinutes: 3 * 60, tier: 'growth'`
- server/services/nfl-auto-picks.js:208-217 `INSERT INTO nfl_pick_decisions ... ON CONFLICT(season,week,policy_id,matchup,market,selection) DO UPDATE SET line=excluded.line,...,recorded_at=excluded.recorded_at`
- server/services/nfl-decision-tape.js:4-8 header admits it: "writes a MUTABLE latest view: it UPSERTs over (season, week, policy_id, matchup, market, selection) -- a key that omits policy_version".
- Live DB: sync_log nfl_decision_ledger runs=66, last 2026-09-12T05:36:30Z; all 16 wk1 nfl_pick_decisions rows have identical recorded_at 2026-09-12T05:36:03.634Z (every prior run's row was overwritten). All 16 eligible=0, abstention_reason=calibration_not_proven.

## Claim 2 — t60-runner.js:245-259 open/capture/missed only  [ACCURATE]
- server/betting/nfl/strategy/t60-runner.js:245-259 `export function runT60Pass(...) { ... openObservations(...); captureDueObservations(...); markMissedObservations(...); return {...} }`
- Imports at t60-runner.js:27-33: crypto, db, nfl-t60-protocol, nfl-contract-key, nfl-t60-packet, date-util. No import of nfl-decision-tape.js anywhere in the module.
- captureDueObservations t60-runner.js:105-139 writes only `UPDATE nfl_t60_observations SET state='frozen', packet_hash=?...` (127-129) or `state='failed'` (121,132).
- `decision_run_id` (declared migrations/034_t60_runner_ledger.js:51) is never written anywhere in server/: only read at t60-runner.js:292. States 'decided'/'abstained' (allowed by 034:50 CHECK) have no writer in server/.
- runExecutionPipeline has the hook the runner would need — nfl-execution-pipeline.js:96-97 `{ observation = null }` and :119-126 the manual default `experimentId: 'unscheduled-manual-invocation'` — but nothing passes a T-60 observation into it.
- Live DB: nfl_t60_observations = 1 row (nfl|2026-09-10|SF@LAR, state=frozen, packet_hash e2bcd98f..., decision_run_id NULL, cutoff 2026-09-10T23:35Z, captured 23:37:32Z). nfl_capacity_events = 0.
- sync_log nfl_t60_runner runs=148, last 2026-09-12T06:45:53Z: opened 0; 14 remaining games skipped `beyond_scheduling_horizon` (24h horizon, t60-runner.js:39,79).

## Claim 3 — recordDecisionRun reachable only from pipeline:128 / route:323  [ACCURATE]
- server/services/nfl-execution-pipeline.js:12 import; :128 `const tape = recordDecisionRun(season, week, board, {`
- Repo-wide grep (excluding node_modules/dist/.bak/test/docs): recordDecisionRun appears only in nfl-decision-tape.js (definition :354) and nfl-execution-pipeline.js:12,128. runExecutionPipeline appears only in routes/nfl-market.js:34 (import) and :323 `res.json(runExecutionPipeline(season, week));` inside `r.post('/execution/run', requireModelPermission('model:train'), ...)` (:319).
- Route comment routes/nfl-market.js:313-318: "There is no scheduled job calling `/execution/run` automatically".
- scheduler.js JOBS (723-887) contains no entry that imports nfl-execution-pipeline.js. No scripts/*.mjs references it.
- Live DB: nfl_decision_runs = 0, nfl_decision_events = 0.

## Evidence line  [CONFIRMED]
nfl_decision_runs 0; nfl_decision_events 0; nfl_pick_decisions 16 (season 2026 wk 1 — the only season/week present); nfl_t60_observations 1; game_lines 2026 wk1 home=1 = 16 games (SEA home vs NE 2026-09-09 20:20 final 13-10; LAR/SF 09-10; 13 on 09-13; KC/DEN 09-14).

## Why SEA-NE has no T-60 observation (root cause, adds to the gap)
- Runner + migration 034 landed in commit fced8d9 2026-09-10 13:40:51 -0400 (= 17:40Z) — about 18 hours AFTER SEA@NE's T-60 cutoff (kickoff 2026-09-10T00:20Z, cutoff 2026-09-09T23:20Z per nfl-t60-protocol.js:40-50).
- openObservations t60-runner.js:78 `if (cutoffMs < nowMs) { skipped.push({ ...game, reason: 'cutoff_already_passed' }); continue; }` — writes NO row. So a game whose cutoff passed before the runner first looked can never become a 'missed' row; the declared-schedule denominator is not held for it. It surfaces only as `never_scheduled` in t60Coverage (t60-runner.js:275-276, 283), which nothing persists.
- Net: the SHOULD-BE ("every observation (game x cutoff) yields exactly one immutable tape run ... denominator = declared schedule") is not met for SEA-NE even at the observation-ledger layer, let alone the tape.

## Correction to "SEA-NE is absent from every ledger"
Overclaims. SEA-NE IS present in:
- nfl_pick_decisions: row "NE at SEA" (selection NE, line 3, -102, quote_at 2026-09-12 04:42:45, recorded_at 2026-09-12T05:36:03Z) — written ~2.5 days AFTER the game went final, via the UPSERT; a post-hoc latest-view row, not prospective evidence.
- shadow_decisions: 6 rows event_key 2026:1:SEA:NE (captured 2026-09-02T05:51Z .. 2026-09-10T23:36Z; the last two also post-final).
- nfl_expert_forward_predictions: 84 rows (horizons scheduled/open/T-24h/T-6h x 21 experts, all captured before the 2026-09-10T00:20Z evidence_cutoff) vs 147 per other game.
- nfl_pregame_snapshot_history: SEA 85, NE 85 rows.
SEA-NE IS absent from the two ledgers the gap is about: the append-only tape (0 rows for any game) and nfl_t60_observations (no row; never_scheduled).
Suggested wording: "SEA-NE is absent from the append-only tape and from the T-60 observation ledger; its only nfl_pick_decisions row was UPSERTed 2.5 days after the final."

## Other observations
- Tape supports a 'missed' run: nfl-decision-tape.js:266-280 validateDecisionBoard requires computationStatus 'unavailable' for a zero-decision board; COMPUTATION_STATUSES :77. Nothing emits it.
- Scheduler is enabled: .env has no SCHEDULER_DISABLED (keys: ANTHROPIC_API_KEY, ODDS_API_KEY, TWITTERAPI_IO_KEY, ANTHROPIC_WORKSPACE_ID, AUTO_HEAVY_SYNC); live PID 56651 `node --env-file-if-exists=.env server/index.js` up 1d02h.
