# Adversarial verification, gaps G25-G31 (practice-truth lens)

Repo read-only. DB read via node:sqlite readOnly:true on server/data.sqlite.

## Live DB facts (2026-09-12)
nfl_decision_runs 0 | nfl_decision_events 0 | nfl_decision_run_invalidations 0
nfl_bet_log 0 (0 graded) | forward_picks 0 | nfl_feature_revisions 0
nfl_candidate_robustness_audits 6 | shadow_decisions 189 (61 beat-the-close, 6 settled)
triggers on forward_picks: NONE
latest migrations: 035,034,033,032,031,029

## G25 forward_picks retrofit
forward-ledger.js:99 `const now = recordedAt == null ? new Date() : new Date(recordedAt)`
:102-104 kickoff refusal uses that supplied clock; :110 INSERT; :179 settlement UPDATEs same row.
Schema core-and-fantasy.js:652-675, unique index :892-893. No no_update/no_delete trigger (DB confirms),
unlike 027:118-121, 023:101-104, 028:61-64, 034:81-84, 035:169-178.
Mitigations: team_score guard blocks retrofit once a final is ingested; UNIQUE blocks re-insert;
recordedAt used only by tests today (test/forward-ledger.test.js:43, week1-readiness:46).
Residual: plain UPDATE/DELETE unguarded; backdated recordedAt passes between kickoff and score ingest.
VERDICT: survives.

## G26 no trial register
nfl-replay.js:691 `const adjustedP = holm(out.map(s => s.p))` — family = one analyzeErrors call.
:667 `if (e.n < minBets) continue` — under-powered segments leave no row, never counted.
grep: no research_trials / trial register / PBO / DSR anywhere in server/.
Plan demands it: docs/CLAUDE-NEXT-STEPS.md:596; 31 components at docs line 124.
beat-the-close RULES (beat-the-close.js:46-62) carry Phase-1 Holm p's in prose only, no register row.
Weakest sub-clause: PBO/DSR are strained at ~150 dev bets; the register + cross-run Holm is the substance.
VERDICT: survives.

## G27 hard-coded verdicts persisted
nfl-candidate-analysis.js:211 verdict constant; :219-222 data_integrity 'not_primary_failure' constant;
:233-236 regime_instability 'critical' constant; :183-187 openingSeason diagnosis constant.
Persisted by :302-306 saveCandidateRobustnessReport.
nfl-coordination-audit.js:48 verdict constant, :49-55 hard_truths constant (:60-61 IS derived).
nfl-diagnostic.js:84 severity 'critical', :99-102 'guardrail' constant (:105-107 verdict IS derived);
persisted through report-cache.js:41 + nfl-diagnostic.js:147.
DB: all 6 audit rows carry a constant narrative diagnosis array; row 6 (win_rate 0.481) also carries
"The candidate is not profitable" + regime 'critical'. Rows 1-5 predate macro_diagnosis.
VERDICT: survives (softer than framed — many sibling states are derived).

## G28 test opens live DB
test/nfl-audit-overview.test.js:12-13 imports server/db/index.js with no GRIDIRON_DB_PATH.
db/index.js:10 DB_PATH default server/data.sqlite; :13 DatabaseSync RW; :17 WAL;
:161-164 legacy migration at import (backup + migrate); :171-199 writes db_health_checks row at import.
Test hard-codes run 27/31 figures :25-31, :69-70 (skip-guarded, so it no-ops elsewhere).
package.json:14 `node --test test/*.test.js`, no env.
NOT unique: ~36 of 42 tests without GRIDIRON_DB_PATH import server modules.
VERDICT: survives; correct the scope.

## G29 027 down() drops the tape
027_decision_tape.js:262 down(); :360-369 unconditional DROP TRIGGER/INDEX/TABLE nfl_decision_events (:365)
and nfl_decision_runs (:368).
031_decision_identity.js:234-243 guard throws only when non-legacy observation runs or invalidations exist.
migrate.js:59-81 rollbackMigration unwinds only the LATEST migration, so 027 is 8 rollbacks deep and 031
would block the chain whenever real runs exist. 0 runs today = nothing to lose right now.
VERDICT: survives as a latent defect; the path is gated and currently empty.

## G30 four close definitions
scheduler.js:275-278 still calls gradeClosingLineValue; route nfl-betting.js:930 serves it.
nfl-clv.js:97-110 closingConsensus = single MAX(captured_at) instant < kickoff, modal line, MEDIAN of raw
American prices, no declared book, no period; :216-254 grades and stamps graded_at (no immutability trigger).
shadow-ledger.js:83 closingLine = game_lines.spread (the LIVE column forward-ledger.js:151-155 warns can be
overwritten in-game).
forward-ledger.js:154 closeSpread = closing_spread ?? spread.
beat-the-close.js:275 pinnacleLineAt(..., kickoff) — the declared-book, declared-period definition.
EXTRA (found, beyond the stated evidence): shadow-ledger.js:57-58 settles ALL unsettled NFL shadow rows with
no model_version filter, and it is scheduled every 6h via nfl-model-growth.js:169 / scheduler.js:856-857,
while beat-the-close settles the same rows via scheduler.js:379-387. 55 unsettled beat-the-close rows are
live to whichever job runs first — two close definitions racing for one clv_points column.
VERDICT: survives; strongest of the batch alongside G31.

## G31 bitemporal never fed
nfl-bitemporal.js is correct (:59-81 recordRevision, :95-123 valueAsKnown with published_at/observed_at).
Only writer anywhere is test/evidence-dataset.test.js:67-70. nfl_feature_revisions = 0 rows.
nfl-advanced.js:305-311 syncInjuries UPSERTs report_status/practice_status/modified_at in place;
:174-180 syncSnaps the same — prior revisions destroyed.
nfl-t60-packet.js:250-255 gates injuries on modified_at, which is the SOURCE's date_modified (:320), not an
observation clock.
nfl-availability.js:62-65 availabilityDeficit reads latest-value injuries with no cutoff, feeding replay.
nfl-event-archive.js:84-93 sets occurred_at AND available_at from the same overwritten modified_at.
VERDICT: survives; point-in-time inputs is the first principle on the list.
