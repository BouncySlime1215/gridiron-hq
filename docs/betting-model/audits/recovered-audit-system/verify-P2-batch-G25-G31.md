# Adversarial verification, materiality lens — G25..G31
Repo read-only. DB read via node:sqlite readOnly:true.

## Live DB counts (2026-09-12)
forward_picks 0 | nfl_bet_log 0 | shadow_decisions 189 (14 settled, 6 beat-the-close + 8 ensemble)
nfl_feature_revisions 0 | nfl_decision_runs 0 | nfl_decision_events 0
nfl_execution_lifecycle_events 0 | nfl_candidate_robustness_audits 6 | nfl_line_snapshots 1,799,797 | nfl_injuries 28,559
Triggers present only on nfl_feature_revisions, nfl_decision_runs, nfl_decision_events.
None on forward_picks, nfl_bet_log, shadow_decisions.

## G25 forward_picks retrofit — REFUTED (materiality)
forward-ledger.js:99 `const now = recordedAt == null ? new Date() : new Date(recordedAt);`
:102 `if (game?.team_score != null || (kickoff && now >= kickoff))` — the score check is
clock-independent, so a pick for a COMPLETED game is refused no matter what clock is passed.
Only in-process callers can pass recordedAt: the sole production caller is recordThisWeek
(:304) which omits it, and the HTTP surface is routes/nfl-betting.js:1859-1868 (season/week/
min_lean only). forward_picks has 0 rows. UNIQUE index (core-and-fantasy.js:892) already
blocks overwrite. Residual truth: no trigger on recorded_at/side/line_at_pick, and
forwardLedger()'s served note (:259) overclaims. P3.

## G26 no trial register — SURVIVES
nfl-replay.js:670 `if (e.n < minBets) continue;` drops attempted segments BEFORE
:691 `const adjustedP = holm(out.map(s => s.p));` — the family is only what survived the
size filter, in one call. Three independent Holm families exist with no shared register:
nfl-replay.js:691, line-move-study.js:406, nfl-passing-specialists.js:226.
grep for research_trials / trial_register / PBO / deflated-sharpe: zero hits in server, test, docs.
Findings feed validateAdjustment/proposeAdjustment (nfl-replay.js:773+), so which segments
survive is a decision input, not just prose.

## G27 hard-coded verdicts — REFUTED (materiality + evidence error)
nfl-candidate-analysis.js:211 constant verdict; :219-222, :233-236, :183-187 constant states.
nfl-coordination-audit.js:48-55 constant verdict/hard_truths; nfl-diagnostic.js:84, :99-102
constant severities. All factually confirmed.
Evidence claim is WRONG: only 1 of the 6 nfl_candidate_robustness_audits rows (id 6,
2026-08-31T15:26:45) contains macro_diagnosis at all; rows 1-5 predate the field.
Row 6's constant verdict matches its own numbers (current_hit_rate 0.481 vs break-even 0.524,
hit_rate_gap 0.043). No number changes; staking authority comes from nfl-profitability gates,
not these strings. Latent risk only: coordination-audit's derived production_state (:60-61)
could contradict its constant verdict (:48) once calibration + neural qualify. P3.

## G28 test opens live prod DB — REFUTED (materiality)
test/nfl-audit-overview.test.js:12-13 imports server/db/index.js with no GRIDIRON_DB_PATH;
db/index.js:10,13 opens server/data.sqlite, :17 WAL, :161-163 legacy-schema migrate,
:171 CREATE db_health_checks, :191 quick_check, :193-196 INSERT, :205-214 espn_settings->leagues.
Confirmed C06 violation and reachable via `npm test` (package.json).
BUT: :163 applies only 000_legacy_schema, already present on the live file — a no-op, so the
"migrations at import" framing overstates it. The only writes are db_health_checks and a
no-op leagues upsert. No evidence table is touched; no number Nick reads changes.
Real hazard is write-lock/IO contention with PID 56651 during Week 1 capture, bounded by
busy_timeout=15000 (index.js:18). P3 hygiene.

## G29 027 down() drops the tape — SURVIVES
027_decision_tape.js:359-369 `DROP TABLE IF EXISTS nfl_decision_events; ... nfl_decision_runs;`
unconditional. Its two guards (:263-282) count only nfl_execution_lifecycle_events and
nfl_execution_opportunities — both 0 rows live, so neither fires incidentally.
031_decision_identity.js:245-254 refuses only when a run has observation_key NOT LIKE 'legacy:%'
or an invalidation exists — a legacy-only tape passes straight through.
Reachable in production: package.json `db:rollback` -> scripts/rollback-migration.mjs:6 ->
db/migrate.js:59-80, against the live db (index.js:13). Needs 8 successive invocations
(035..028) because :61-65 refuses to skip. 028 and 031 both guard their evidence; 027 guards
everything except the table it exists to make immutable, contradicting its own header
("stays byte-identical forever", :27-28). 0 rows today -> latent, not active.

## G30 four close definitions — SURVIVES (already realized in the data)
1. nfl-clv.js:97-110 closingConsensus — MAX(captured_at) < commence, modal line + median raw
   American price; nfl_line_snapshots has no `period` column (verified). :216-254
   gradeClosingLineValue UPDATEs graded_at in place, no trigger. Still scheduled at
   scheduler.js:273-277. Inert today: nfl_bet_log = 0 rows.
2. shadow-ledger.js:83 `closingLine = game.spread` — the LIVE ESPN column, which
   gamescript.js:125 overwrites on every poll (forward-ledger.js:149-153 documents that it can
   hold an in-game number after kickoff); gamescript.js:152-153 writes the real close to
   closing_spread, which shadow-ledger does not read.
3. forward-ledger.js:154 `g.closing_spread ?? g.spread`.
4. beat-the-close.js:284-290 Pinnacle at kickoff (pinnacleLineAt).
CONTAMINATION IS ALREADY IN THE COLUMN: of 14 settled shadow_decisions, 6 beat-the-close rows
carry outcome_json close_source "free:pinnacle" and 8 ensemble rows carry the game_lines.spread
close. shadowLedgerSummary (shadow-ledger.js:107-121) and nfl-profitability's edge aggregate
clv_points across both.
RACE: shadow-ledger.js:58-59 selects `WHERE sport='NFL' AND settled_at IS NULL` with no
model_version filter, so nfl_model_growth (scheduler.js:856 -> nfl-model-growth.js:169) can
settle beat-the-close rows with the ESPN spread before beat_the_close (scheduler.js:761 ->
beat-the-close.js:275) reaches them.

## G31 bitemporal never fed — SURVIVES
nfl-bitemporal.js is correct and guarded (both append-only triggers present) and holds 0 rows.
recordRevision is called only from test/evidence-dataset.test.js:67,70 — no production writer.
Reads are latest-value: nfl-weekly-feature-store.js:142 and :246 filter nfl_injuries by
season/week only; nfl-ai-replay.js:123 likewise.
Worse than "uncounted": nfl-t60-packet.js:250-256 uses `modified_at` as the RECEIPT clock, but
nfl-advanced.js:306-311/:322 writes it from the CSV's `date_modified` — the SOURCE's publish
time. sourceEntry (:112) then grants `received_by_cutoff`, the one claim a prospective packet
may rest on (:60-62, :75-78), on a publication clock. That is the same defect the file's own
comment calls out for requested_at ("(3) THE CLOCK", :175-179), and it applies to both the
2026 live packets and any historical replay.
