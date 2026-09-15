# G06 adversarial verification — lens: materiality

Gap under test: "Stale candidate finding will abort the 2026 season-end learning cycle and can never be renewed."
Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). Files read in full:
server/services/nfl-candidate-findings.js (404 lines), server/services/nfl-model-growth.js (308),
server/migrations/024_candidate_findings.js (77), server/platform/code-identity.js (174),
server/migrations/025_candidate_finding_discovery_note.js. Partial reads cited by line elsewhere.

## 1. Mechanics — every clause of the gap is TRUE

### 1a. The throw is unisolated, all the way up
- `nfl-candidate-findings.js:207-209` — `recordHoldoutTest` calls `assertRuleUnchanged(finding)` BEFORE the `try`; only `proposeAdjustment` (:212-216) is caught.
- `:280-284` — `for (const finding of eligibleForHoldout) { ...; holdoutActions.push(recordHoldoutTest(finding, season, config)); }` — no try/catch per finding.
- `nfl-model-growth.js:256` — `detail.candidate_findings = runCandidateFindingsForSeasonEnd(season);` bare call inside the outer `try`.
- `:302-307` — `catch (error) { ... SET status='error' ... ; throw error; }` — whole run marked error and rethrown.
- `scheduler.js:982-991` — `runIfStale` catches, `record(name,'error',e.message)`, returns; other jobs unaffected.

### 1b. Staleness is certain, not hypothetical (independently recomputed, no DB import)
- Stored (live DB, readOnly): finding id 1, `segment_key='spread_x_timing|big spread (7+) + late (wk14+)'`, state `discovered`, `rule_definition_hash=4303bbce23f0…9085`, `confirmed_at 2026-09-09 21:20:50` (SQLite UTC = 17:20 -0400).
- Recomputed via `codeIdentity(['services/nfl-replay.js','services/stats-util.js','services/nfl-policy.js'])` (roots at `nfl-replay.js:998-999`) + `segmentRuleHash` formula (`nfl-replay.js:848-851`): `bfc269cc8cbd…4b20`. Match: false. Closure = 186 files, `complete:false` (3 unresolved dynamic imports), sample files include `db/index.js`, `db/schema/core-and-fantasy.js`, `betting/nfl/strategy/t60-runner.js` — i.e. the "predicate identity" is most of the server.
- Git (read-only log): finding frozen at commit 969d501 (2026-09-09 17:21 -0400); helper swapped from git-based to closure-based at d958b24 (2026-09-10 02:56 -0400) — so the stored hash was produced by the OLD helper and can never match the new one regardless of drift. 141 server files touched in commits since the freeze.
- Reachability at season end: `eligibleForHoldout` = state IN ('discovered','validating') (:275) → finding 1 qualifies; `alreadyUsed` for 2026 = none (seasons rows are 2021-2025 only); `singleSeasonFindings(2026)` only short-circuits on `replaySeason` `{error}` (`nfl-replay.js:206`, "no completed games") which will not hold in Feb 2027. Guard at :246-249 only defers while a blind audit is `running` (latest audits: 32 complete, 31 complete, 30 failed).

### 1c. No renewal path
- `024_candidate_findings.js:31` — `segment_key TEXT NOT NULL UNIQUE`.
- `nfl-candidate-findings.js:120-122` — `registerManuallyObservedFinding` throws `already exists` on the key.
- `:152-154` — `recordDiscoveryFlag` returns `already_past_discovery` for any non-pending state (no row written).
- `:391-396` — `rejectFinding` flips state only; row and key remain. No delete/version/supersede function anywhere in the file.
- Test coverage (`test/nfl-candidate-findings.test.js:89-99`) exercises `assertRuleUnchanged` only in isolation and with a tampered string; nothing drives `recordHoldoutTest` through `runCandidateFindingsForSeasonEnd` with a real replay (the only orchestrator test, :174-179, hits the blind-audit deferral path).

## 2. Materiality — what actually changes for Nick

### 2a. Numbers he reads
- ProfitabilityControl.tsx renders `model_growth.state`, `learned_through_week`, `labeled_examples`, `sources`, `next_action` (:133-157) and the engine pill (:121). `state` is derived in `nflModelGrowthStatus` from the warehouse and the fit artifact (`nfl-model-growth.js:126-128`), NOT from the run's status. `latest_run` is typed (:29) but never rendered.
- Diagnostics.tsx:384-400 renders the scheduler job table, but its State column shows only `never run / stale / fresh` from `j.runs` and `j.stale` (:398-400) — `last_status` is in the payload (`scheduler.js:1170`) but never rendered. And `record()` (`scheduler.js:78-85`) bumps `last_run_at` and `runs` on an error run too, so after each 6h offseason failure the job reads green "fresh". The `error` reaches no page Nick reads. It also misreports: everything that matters has already completed by :256 (settlement :166-172 before the try; ingestion; postgame truth :198-203; signal reliability :204-206; the final cutoff fit :211-224; team-code reconciliation :233; offseason refresh :248). The run row keeps `detail_json` with all of it (:305).
- Engine pill: `recordNflEngineArtifact` (:285-287) is skipped, but `nflEngineVersionFor` falls back to `computedVersion` when no sealed row exists (`nfl-engine-registry.js:155-158`); the missing row is for `predicts_week = 23`, which is never bet on.

### 2b. Decisions
- The only live consumer of the ledger is `promotedFindingVeto` (`nfl-auto-picks.js:12,134`), which reads `state='promoted'` only (:312) and is a no-op with zero promoted findings (:313). Finding 1 needs `REQUIRED_HOLDOUT_CONFIRMATIONS = 3` (:70) non-overlapping seasons → 2026, 2027, 2028 → earliest possible live effect ~Feb 2029, and then only via an explicit human `promoteFindingToShrink` call (:370-388). No 2026 or 2027 pick changes either way.
- Skipped trainings are cumulative and self-heal: `trainOnlineNeuralThroughSettled` selects `settled_at IS NOT NULL AND trained_at IS NULL` (`nfl-online-neural.js:297-298`); `trainRiskLabThroughSettled` likewise (`nfl-risk-lab.js:431-432`). The season-end `else` branch (and the throw) is only taken when `season_complete` (:237-241); the first in-season 2027 cycle takes the `if (!seasonOver)` branch and trains through every pending week including 2026 wk18-22. Neural output is used on the board only when `production_eligible === true` (`nfl-auto-picks.js:104`). Player weekly learning also runs from the independent `nfl_weekly_learning` job (`weekly-learning.js:217-218`, `scheduler.js:851`).

### 2c. Validity of the record
- The candidate-findings ledger has NO route and NO UI reader: grep of `server/routes` and `client/src` for `candidateFindingsStatus|candidate-findings|candidate_findings|promoteFindingToShrink|rejectFinding` returns nothing. Its forward record for finding 1 is real and does become a dead end, but no one reads it and nothing downstream depends on it before 2029.
- Note the gap's own SHOULD-BE ("stale => recorded 'stale' event and skipped") would NOT make the 2026 holdout accumulate either — only the identity redesign (manifest of predicate files only, or versioned keys) would. Per-finding isolation alone just converts a loud failure into a quiet one.

## 3. Verdict
Mechanically confirmed on every clause; refuted at the materiality lens. Closing G06 changes no number Nick reads, no pick, and no record with a reader before ~Feb 2029. Its visible symptom is a false `error` on the Diagnostics job table during the 2027 offseason (after the real work succeeded) plus the loss of an unread ledger's 2026 row. Keep as a hygiene item with a hard clock (fix before the 2026 season completes); it is not a Week 1 concern and not a validity-of-record concern for anything currently consumed.

Residual risk to the refutation: (i) if someone wires a candidate-findings route/UI before Feb 2027, the dead-end finding becomes visible; (ii) if a future consumer keys on `nfl_model_growth_runs.status='ok'` (today only `latestRun()` and `evidence-daemon.js:187` read it, and neither gates behavior), the offseason `error` rows would start to matter.
