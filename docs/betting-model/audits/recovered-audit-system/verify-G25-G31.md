# Adversarial verification: G25-G31 (code-truth lens)
Repo read-only. All line cites re-read in situ.

## G25 forward_picks retrofit — SURVIVES
forward-ledger.js:99 `const now = recordedAt == null ? new Date() : new Date(recordedAt);`
:101 kickoff from nflKickoffDate(gameday, gametime); :102 `if (game?.team_score != null || (kickoff && now >= kickoff))` — the kickoff half of the guard is evaluated against the CALLER's clock.
:115 nowIso (caller clock) is what lands in recorded_at.
No trigger on forward_picks: `grep -i "CREATE TRIGGER"` over server/ returns triggers for nfl_execution_lifecycle_events (023/027/028), nfl_decision_events/runs (027/031), nfl_feature_revisions (nfl-a-to-m.js:624-626), draft owners (016) — none for forward_picks. Schema core-and-fantasy.js:652-671 has no CHECK/trigger; only unique index :892 (season,week,home,away,market,source).
Partial mitigations that do NOT refute: score-presence guard blocks retrofit once a final is ingested; UNIQUE blocks overwrite-by-insert. UPDATE/DELETE remain unguarded (settleForwardPicks:179 itself UPDATEs).

## G26 no trial register — SURVIVES
nfl-replay.js:640 `analyzeErrors`; :668 `if (e.n < minBets) continue;` (below-threshold segments produce no row at all); :691 `const adjustedP = holm(out.map(s => s.p));` — family = the segments surviving this one call.
`grep -rn "research_trials|trial_register|registerTrial"` over server/client/test/docs/research: zero hits. No PBO/deflated-Sharpe implementation anywhere.
Nearest thing: research_hypotheses (mlb-model-misc.js:209) fed by 4 hard-coded rows in model-intelligence.js:22-31 — a narrative hypothesis list, not a count of attempted models/thresholds/families/segments.
beat-the-close.js:43 RULES (frozen rule set) is never registered as trials.

## G27 hard-coded verdicts persisted — SURVIVES, evidence overstated
nfl-candidate-analysis.js:211 `verdict: 'The candidate is not profitable...'` (constant); :219-222 data_integrity state 'not_primary_failure' + constant finding; :233-236 regime_instability state 'critical' + constant finding; :183-187 openingSeason diagnosis[] three constant strings.
Persisted by saveCandidateRobustnessReport :303 (INSERT result_json).
nfl-coordination-audit.js:48 constant verdict, :49-55 hard_truths[] constants, :60-61 production_state IS derived (calibrationQualified && neural.production_eligible).
nfl-diagnostic.js:84 severity:'critical' constant (finding string is computed); :99-102 severity:'guardrail' constant.
DB check (readOnly): 6 rows in nfl_candidate_robustness_audits, but only row 6 carries macro_diagnosis.verdict — rows 1-5 predate macroDiagnosis. All 6 carry the constant evidence_class and 5/6 the constant opening_season diagnosis[0]. Corrected evidence: 1 of 6 carries the constant verdict; 6 of 6 carry constant evidence_class/diagnosis prose.

## G28 test opens live DB — SURVIVES
test/nfl-audit-overview.test.js:12-13 `await import('../server/db/index.js')` with no GRIDIRON_DB_PATH set anywhere in the file; package.json:14 test script sets none. db/index.js:10 falls back to server/data.sqlite, :13 opens it as a writer, :17 PRAGMA journal_mode=WAL, :161-164 applies the legacy schema migration at import (with backupBeforeMigration), :171-185 writes db_health_checks. Other tests (evidence-dataset, t60-runner, etc.) do set GRIDIRON_DB_PATH; this one does not. Hard-coded figures at :25-31 (70 weeks, 153/72/78/3, -11.855) and :68-70 (run 27 vs 31).

## G29 027 down() drops the tape — SURVIVES (latent)
027_decision_tape.js:262 down(); guards at :263-283 only count lifecycle events / opportunity states — nothing about tape rows. :359-369 unconditional `DROP TABLE IF EXISTS nfl_decision_events` / `nfl_decision_runs` regardless of row count.
031_decision_identity.js:245-254 refuses only when invalidations exist or `observation_key NOT LIKE 'legacy:%'` — a tape of entirely legacy-keyed runs passes.
migrate.js:59-79 rolls back only the last-applied migration, so 027 is reachable only after 035..028 are rolled back; 028 has one refusal. Latent today: nfl_decision_runs and nfl_decision_events both hold 0 rows.

## G30 four live close definitions — SURVIVES
scheduler.js:275-278 `const { gradeClosingLineValue } = await import('./nfl-clv.js'); ... clv: gradeClosingLineValue()` — still scheduled.
nfl-clv.js:94-113 closingConsensus: MAX(captured_at) strictly before commence_time (single instant, :97-99), modal line :108, `median` of raw American prices :110 (no de-vig/probability conversion before the median). :216-250 grades in place, `graded_at=?` written by UPDATE on nfl_bet_log (no append-only trigger on that table).
shadow-ledger.js:83 `closingLine = game.spread ...` — the live game_lines.spread column (the very column forward-ledger.js:149-153 documents as overwritable with an in-game number).
forward-ledger.js:154-156 `g.closing_spread ?? g.spread` — ESPN/game_lines frozen close with live fallback.
beat-the-close.js:285 `pinnacleLineAt(..., kickoff, names)` inside settleBeatTheClose (declared :275) — Pinnacle-at-kickoff. Four distinct definitions, all live.

## G31 bitemporal store never fed — SURVIVES
nfl-bitemporal.js:74 recordRevision INSERT OR IGNORE; append-only triggers exist (nfl-a-to-m.js:624-626). `grep -rn recordRevision` outside the module: only test/evidence-dataset.test.js:67-92. nfl_feature_revisions row count (readOnly) = 0.
nfl-t60-packet.js:250-255 injuries gated on `modified_at <= cutoff` — and modified_at is the source's own date_modified (nfl-advanced.js:322 `r.date_modified`), not a receipt clock.
Ingest is in-place UPSERT that destroys the prior value: nfl-advanced.js:306-311 `ON CONFLICT(season,week,gsis_id) DO UPDATE SET report_status=excluded.report_status, practice_status=..., injury=..., modified_at=...`; nfl-advanced.js:215-221 same shape for nfl_depth.
Every nfl_injuries reader is latest-value (nfl-team-card.js:75, nfl-pregame.js:20, nfl-player-value.js:298, who-plays.js:56, draft-assist.js:862, role-scenario-lab.js:76, ...) — none filters on an observed_at cutoff.
