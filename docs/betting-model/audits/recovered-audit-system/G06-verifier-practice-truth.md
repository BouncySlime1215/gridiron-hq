# G06 adversarial verification (lens = practice-truth), 2026-09-12

Gap: "Stale candidate finding will abort the 2026 season-end learning cycle and can never be renewed."
Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). All 3 assigned files read in full
(nfl-candidate-findings.js 404 lines, nfl-model-growth.js 308, migrations/024 77) plus test file (237), code-identity.js (174),
nfl-replay.js 835-1010, scheduler.js 640-700 / 850-862 / 970-1000.

## Verdict: NOT refuted. The mechanism is real, reproduced against the live DB, and the should_be is the code's own
declared standard (and the pattern it claims to mirror), not an outside opinion. One prescription is a design option.

## 1. Mechanism confirmed line by line
- server/services/nfl-candidate-findings.js:207-209  `function recordHoldoutTest(finding, season, config = {}) { assertSeasonRoleAvailable(...); assertRuleUnchanged(finding);`
  -> the identity check is OUTSIDE the try at :212-216 (try only wraps proposeAdjustment). A throw escapes.
- :46-70 assertRuleUnchanged throws on missing hash (:59-63) and on mismatch (:64-68).
- :280-284 loop: `for (const finding of eligibleForHoldout) { ... holdoutActions.push(recordHoldoutTest(finding, season, config)); }` no try, no per-finding isolation.
- server/services/nfl-model-growth.js:256 `detail.candidate_findings = runCandidateFindingsForSeasonEnd(season);` bare call inside the outer try.
- :302-307 `catch (error) { ... UPDATE nfl_model_growth_runs SET ... status='error' ...; throw error; }` -> whole run 'error'.
- Steps AFTER :256 that are skipped on throw: :258 trainOnlineNeuralThroughSettled, :259 trainRiskLabThroughSettled,
  :260-261 settleWeeklyPredictions/retrainWeeklyWeights, :268-276 expert_council, :280-283 recordNflEngineArtifact.
- Branch is reached only when `afterIngest.season_complete` (:246-249 `seasonOver`), i.e. every 6h tick for the whole offseason:
  scheduler.js:856 `nfl_model_growth: { run: refreshNflModelGrowth, maxAgeMinutes: 6 * 60, tier: 'growth'`.
  scheduler.js:992 `try { record(name, 'error', e.message); }` -> scheduler survives, but the growth run itself is 'error' each time.
- The manual route server/routes/nfl-betting.js:229-235 `r.post('/profitability/model-growth/run', ... runNflModelGrowthCycle(` hits the same throw.

## 2. Live DB reproduces the stale state (readOnly:true, server/data.sqlite)
- nfl_candidate_findings id=1: segment_key 'spread_x_timing|big spread (7+) + late (wk14+)', direction weak, state 'discovered',
  rule_definition_hash 4303bbce23f0c7d69a2f93b79c669b37b62f79fad9ffe8f63910543654319085, discovery_seasons [2021..2025],
  confirmed_at 2026-09-09 21:20:50. Five 'discovery' rows in nfl_candidate_finding_seasons; zero holdout rows.
- state 'discovered' => it IS in `eligibleForHoldout` (:274 `WHERE state IN ('discovered','validating')`), and 2026 is not yet used
  (:281-282 alreadyUsed check passes) => recordHoldoutTest(finding 1, 2026) WILL be called at 2026 season end.
- Recomputed via server/platform/code-identity.js (pure file hashing, no DB): closure roots per nfl-replay.js:998-1000
  `codeIdentity(['services/nfl-replay.js', 'services/stats-util.js', 'services/nfl-policy.js'], 'nfl-candidate-finding-predicate')`
  -> segmentRuleHash per nfl-replay.js:848-851 = bfc269cc8cbd827ecd4bd0a8b24db1c94e99a9beb4c00c15ac06de28180d4b20 != stored. Matches A02 exactly.
- Why stale by construction: the finding was frozen 2026-09-09 21:20:50 under the OLD git-based helper; the closure-based helper
  landed in commit fced8d9 2026-09-10 13:40:51 (git log -S'codeIdentity([' / -S'git ls-files' on nfl-replay.js). nfl-replay.js:967-990
  docstring describes the swap. Nothing migrated or invalidated existing rows.
- The predicate itself still exists: nfl-replay.js:474 `segs.push(['spread_x_timing', ...])` -- so this is a false-stale on an unchanged rule.

## 3. "Can never be renewed" -- holds at the API level
- segment_key UNIQUE: migrations/024_candidate_findings.js:31 `segment_key TEXT NOT NULL UNIQUE,`; key = `${dimension}|${segment}` (:77).
- recordDiscoveryFlag on an existing key with state != pending_confirmation returns 'already_past_discovery' no-op (:152-154).
- registerManuallyObservedFinding throws 'already exists' (:121-123).
- assertRuleUnchanged's own error text says "must be re-discovered under a new segment_key" (:67-68) -- impossible for the same predicate.
- No 'stale' state exists: 024:37-38 CHECK(state IN ('pending_confirmation','discovered','validating','validated','flagged_for_review','promoted','rejected')).
- No rule_version column (024:29-47). No later migration touches segment_key (grep migrations/02-09* -> none).
- Only escape hatch in code: rejectFinding (:388-395) -- requires a human actor, is NOT exposed by any route or UI
  (grep for rejectFinding/promoteFindingToShrink outside the service hits only the test file and comments in model-growth.js/024),
  and permanently kills the segment_key (rejected state is terminal; re-registration blocked as above). So renewal = never; unblock = manual only.
- No test exercises recordHoldoutTest or the throw path through runCandidateFindingsForSeasonEnd: test/nfl-candidate-findings.test.js
  only calls runCandidateFindingsForSeasonEnd in the blind-audit-deferral case (:174-180); assertRuleUnchanged is unit-tested in
  isolation (:89-100) with a hand-tampered hash, never through the orchestrator. Confirmed the EVIDENCE claim.

## 4. Is the should_be a genuine standard or opinion?
(a) Per-finding isolation -- the project's own standing convention, applied everywhere except here:
    nfl-model-growth.js:150-154 `attempt()` + :156-158 "Individual feeds fail independently so one late nflverse release does not discard everything";
    nfl-candidate-findings.js:318-333 promotedFindingVeto try/catch per finding with explicit "Isolate one stale finding's failure rather than aborting unrelated evaluation";
    scheduler.js:982-993 per-job catch. Not an outside opinion; a sibling behavior the holdout path omits.
(b) Stale => recorded event, skipped -- the file's own C08 text :327-331 "skipping SILENTLY is how a finding stops working and nobody notices... It is reported."
    Append-only audit-trail discipline. Genuine. Cannot currently be recorded (no state, no event table).
(c) Versioned (segment_key, rule_version) -- the file claims to "mirror model-governance.js's model_registry/model_gate_audits pattern" (:6-7, 024:7-8);
    that pattern IS versioned: server/db/schema/mlb-model-misc.js:189-193 model_registry has `model_version TEXT NOT NULL`, :196-198 model_gate_audits keyed by model_version,
    :200-203 model_registry_history append-only. And :42-44 docstring: "a rule change must create a new finding/version". Genuine, and the code's own stated intent.
(d) Identity = declared manifest of predicate files only -- THIS is a design choice, not a universal standard. The principle behind it is the code's own:
    code-identity.js:31-34 "Editing a documentation file, a fantasy draft screen or an unrelated MLB service therefore does not change the spread model's identity".
    Practice-truth: the closure violates that goal today -- 186 files, complete:false (3 unresolved dynamic imports incl. code-identity.js itself),
    30 files matching mlb|draft|trade|routes/|news/|scheduler|cfbd|polymarket|twitter (services/mlb.js, mlb-projections.js, draft-assist.js, trade-engine.js, scheduler.js, routes/*.js ...).
    Churn: 27 commits since 2026-08-01 on the 3 roots; 17 distinct commit-days on server/services since 2026-08-15. A03's recompute and mine differ only in
    that they were run on different days -- the identity itself already drifted between audit runs. Holdout needs 3 seasons (:72 REQUIRED_HOLDOUT_CONFIRMATIONS = 3),
    i.e. a byte-identical 186-file closure across >= 3 years. Under the current identity no finding can ever reach flagged_for_review -- the ledger is structurally inert.
    The narrower remedy could be a declared manifest OR hashing segmentsFor/gameContext source OR explicit rule_version; the gap should say "scoped to predicate semantics" not
    prescribe manifest-only (a manifest can fail open on a transitive change, the failure C08 was fixing).

## 5. NFL sample size (272 games/season)
Not a factor -- the gap is ledger/identity mechanics, not statistical power. If anything the small per-season N is WHY the design accumulates 3 holdout seasons,
which is exactly the horizon the identity scheme cannot survive; sample size strengthens rather than refutes the gap.

## 6. Corrections to the gap wording
- "abort the 2026 season-end learning cycle": precisely, the seasonOver branch throws at the first tick where season_complete is true (after week 22 finalizes),
  marks that run 'error', skips online-neural/risk-lab/player/expert/engine steps, and repeats every 6h until 2027 game_lines flip availableSeason (finalized_week 0 -> 'waiting').
  Discovery-flag writes before the throw (:264-267) persist and are idempotent on retry.
- "can never be renewed": true for the finding/segment_key via any code path; the pipeline can be unblocked only by a human calling rejectFinding from a REPL (no route) or by a direct DB edit.
- (d) should be phrased as "identity scoped to the predicate's semantic inputs and versioned", not "manifest of predicate files only".
