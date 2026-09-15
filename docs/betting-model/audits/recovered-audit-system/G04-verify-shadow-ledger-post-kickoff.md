# G04 verification (lens=code-truth) — shadow ledger records finished games

Verdict: NOT refuted. The "current" description is accurate at the cited lines. One correction to the
EVIDENCE line: rows 200/216 are decision='abstain', so validationFirewall().forward does NOT count them today
(the risk there is latent, not realized). shadowLedgerSummary().settled does count them.

## Code (all read in full)
- server/services/shadow-ledger.js (122 lines): 
  - :23-24 model_version = `nfl-ensemble-v2-shadow:${engine_mode}:${policy.id}@${policy.version}:${controller}` — any policy
    version bump OR reliability-controller version change yields a new key.
  - :28-31 `SELECT id FROM shadow_decisions WHERE sport='NFL' AND event_key=? AND market=? AND model_version=? LIMIT 1`
    → `if (exists) {alreadyFrozen++; continue;}` — the only dedupe; no kickoff, no team_score/opp_score check anywhere in
    recordNflShadowBoard (:11-54).
  - :57-100 settleNflShadowDecisions settles every row with settled_at IS NULL once game_lines has a score (:71-73);
    no check that captured_at < kickoff. clv = decision.line - closing (:85) → 0 when the "prediction" was captured post-final.
  - :102-113 shadowLedgerSummary `settled` counts result IN (Won,Lost,Push) with NO decision filter → abstain rows included.
- server/services/nfl-auto-picks.js (285 lines): computeDecisionBoard (:99-198) iterates ensembleWeek(season, week) →
  nfl-ensemble.js:1352-1356 `SELECT team AS home, opponent AS away FROM game_lines WHERE season=? AND week=? AND home=1`
  — every game of the week, finished or not. Prices from game_lines current row (:100-102), i.e. post-game fetched_at.
- server/services/evidence-daemon.js (198 lines): :102-111 groups due windows by season:week; :125 `recordNflShadowBoard(season, week)`
  records the WHOLE week board whenever any window of that week is due. planEvidenceWindows (:48-58) only plans unfinished
  games, and dueWindows (:68-77) only picks event_at >= now-5min — but that gates the *trigger*, not the *board contents*.
- server/services/nfl-evidence.js (179 lines): :114-119 forward query filters `decision='observe'` — abstain rows excluded.
- server/db/schema/mlb-model-misc.js:665-672 shadow_decisions has no voided_at/invalidated_at column; UNIQUE(sport,event_key,market,model_version,captured_at).
- Sibling writers DO guard: server/services/beat-the-close.js:175-176 `if (kickoff && kickoff <= now) continue;`
  and recordForwardPick (test/forward-ledger.test.js:39-52 expects /already been played/). shadow-ledger.js has no equivalent.

## Data (server/data.sqlite, readOnly)
- game_lines 2026 wk1 SEA home: gameday 2026-09-09 gametime 20:20 ET → kickoff 2026-09-10T00:20Z (evidence_capture_windows
  event_at for 2026:1:SEA:NE = 2026-09-10T00:20:00.000Z); final 13-10; spread -3 / closing_spread -3.
- shadow_decisions for 2026:1:SEA:NE: ids 15/31 @1.1.0 captured 2026-09-02T05:51Z line 3.5 (pre-kickoff, legit);
  ids 200/216 @1.2.0 captured 2026-09-10T23:36:01Z (≈23h AFTER kickoff, after final), quote_at "2026-09-10 23:02:55",
  line 3, reason calibration_not_proven, decision 'abstain', settled 2026-09-11T04:12Z result Push clv 0,
  outcome_json line_at_prediction=3 closing_line=3.
- evidence_daemon_runs id 2149 started 2026-09-10T23:35:53Z: due=2, nfl:[{season:2026, week:1, windows:1, ...}] — the run that
  re-recorded the whole week-1 board (32 rows at 23:36:01Z, CAR:CHI..TEN:NYJ) under the new 1.2.0 model_version.
- Post-kickoff join (captured_at > close-window event_at) across all 189 NFL rows: exactly ids 200 and 216.
- validationFirewall forward today: decisions 61 / settled 0 (all 61 observe rows are beat-the-close.js models, which guard kickoff).
- shadowLedgerSummary-style: abstain n=128 settled=8 (includes 200/216); observe n=61 settled 0.

## Bottom line
Mechanism confirmed end to end: policy 1.1.0→1.2.0 → new model_version → existence check misses → daemon re-records the
finished SEA:NE game with the post-game line → settle marks it Push/clv 0. Contamination of nfl-evidence forward counts is
latent (rows are abstain because calibration is unproven); it becomes real the moment the board emits 'observe'.
