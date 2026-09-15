# G06 verification (lens = code-truth): stale candidate finding aborts the 2026 season-end learning cycle and cannot be renewed

Verdict: NOT REFUTED. Every element of the CURRENT description is accurate at the cited path:line, and none of SHOULD-BE exists in the code. One caveat on "can never be renewed" (see section 5).

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). Files read in full: server/services/nfl-candidate-findings.js (404 lines), server/services/nfl-model-growth.js (308), server/migrations/024_candidate_findings.js (77), server/migrations/025_candidate_finding_discovery_note.js (23), server/platform/code-identity.js (174). Partial: nfl-replay.js 840-1010, scheduler.js 655-690 / 852-1000, test/nfl-candidate-findings.test.js (most of 237).

## 1. assertRuleUnchanged is outside the try (findings.js:207-217) -- CONFIRMED

```
207 function recordHoldoutTest(finding, season, config = {}) {
208   assertSeasonRoleAvailable(finding.id, season, 'holdout');
209   assertRuleUnchanged(finding);
...
213   try {
214     result = proposeAdjustment(segment, { discoverySeasons, holdoutSeasons: [season], config });
215   } catch (e) {
216     return { finding_id: finding.id, segment_key: finding.segment_key, error: e.message };
```
The try/catch only wraps proposeAdjustment. assertRuleUnchanged (:46-68) throws on a null hash (:58-61) or a mismatched hash (:63-67); neither is caught here. The comment at :323-324 states this is intentional: "The same check throws loudly in recordHoldoutTest, where a stale rule must stop the automatic pipeline outright".

## 2. No per-finding isolation in the season-end loop (findings.js:278-284) -- CONFIRMED

```
278   const eligibleForHoldout = rows(`SELECT * FROM nfl_candidate_findings WHERE state IN ('discovered','validating')`);
279   const holdoutActions = [];
280   for (const finding of eligibleForHoldout) {
281     const alreadyUsed = row(`SELECT 1 ok FROM nfl_candidate_finding_seasons WHERE finding_id=? AND season=?`, finding.id, season);
282     if (alreadyUsed) continue;
283     holdoutActions.push(recordHoldoutTest(finding, season, config));
284   }
```
No try around :283. The first stale finding throws out of runCandidateFindingsForSeasonEnd; discoveryActions for the season (:270-273, already written to the DB) are never returned, and later findings in the loop are never tested. Contrast promotedFindingVeto :325-335, which DOES isolate per finding and pushes a `stale` record -- the live path got the isolation, the learning path did not.

## 3. Bare call in growth cycle; whole run marked 'error' and rethrown (growth.js:256, :302-306) -- CONFIRMED

```
256         detail.candidate_findings = runCandidateFindingsForSeasonEnd(season);
...
302   } catch (error) {
303     const finishedAt = new Date().toISOString();
304     run(`UPDATE nfl_model_growth_runs SET finished_at=?,status='error',detail_json=? WHERE id=?`,
305     finishedAt, JSON.stringify({ ...detail, error: error.message }), inserted.lastInsertRowid);
306     throw error;
```
:256 is inside the `else` (seasonOver) branch at :248-257, not wrapped in the module's own `attempt()` helper (:149-153) that the ingestion feeds use. The throw skips everything after :256 in the same cycle: trainOnlineNeuralThroughSettled (:258), trainRiskLabThroughSettled (:259), settleWeeklyPredictions/retrainWeeklyWeights (:260-261), player_learning (:265), expert_council (:269), recordNflEngineArtifact (:281). The scheduler (scheduler.js:982-993) catches the rethrow, records the job 'error', and the growth job is retried on its 6h cadence (:856) -- but each retry throws at the same :256, so those downstream season-end steps never complete for that season. Once game_lines gains 2027 rows, availableSeason() (growth.js:54-58) moves to 2027, finalized_week=0 -> 'waiting', and the 2026 season-end branch is never entered again.

## 4. segment_key UNIQUE, no versioning (024:31) -- CONFIRMED

```
024:31      segment_key TEXT NOT NULL UNIQUE,
```
No rule_version column anywhere: `grep -n "rule_version\|ALTER TABLE nfl_candidate_findings" server/migrations/*.js` hits only 025:15/:21, which add/drop `discovery_note`. 024 and 025 are the only migrations touching the table.

## 5. Rule identity = 186-file code-identity closure -- CONFIRMED

nfl-replay.js trainingAuditCodeHash():
```
  return (_trainingAuditCodeHashCache = codeIdentity([
    'services/nfl-replay.js', 'services/stats-util.js', 'services/nfl-policy.js'
  ], 'nfl-candidate-finding-predicate').id);
```
codeIdentity -> moduleClosure (code-identity.js:79-113) walks every static/dynamic relative import transitively. Recomputed live:
`closure id af23140b... file_count 186 complete false unresolved [platform/code-identity.js, services/draft-assist.js, services/nfl-execution-edge.js]`
segmentRuleHash (nfl-replay.js) = sha256({dimension, segment, direction, implementation: closure id}). Recomputed for finding 1's segment: `bfc269cc8cbd827ecd4bd0a8b24db1c94e99a9beb4c00c15ac06de28180d4b20`.

Live DB (server/data.sqlite, readOnly):
- finding 1: segment_key `spread_x_timing|big spread (7+) + late (wk14+)`, state `discovered`, rule_definition_hash `4303bbce23f0c7d69a2f93b79c669b37b62f79fad9ffe8f63910543654319085`, discovery_seasons [2021..2025], confirmed_at 2026-09-09 21:20:50.
- nfl_candidate_finding_seasons: 5 discovery rows (2021-2025), no holdout rows -> season 2026 is NOT alreadyUsed, so finding 1 WILL reach recordHoldoutTest at season end.
- nfl_blind_audit_runs status='running': none (the :259-262 deferral will not save it).
- latest growth runs: #41-43, season 2026, finalized_week 0, status 'waiting'.

Stored 4303bbce != recomputed bfc269cc: finding 1 is already stale three days after freezing, because the identity moves with any edit to any of 186 files (the closure includes services/nfl-auto-picks.js, nfl-execution-pipeline.js etc. via nfl-policy.js -> ... imports; even code-identity.js itself is in the closure).

## 6. Renewal path -- CONFIRMED absent (with caveat)

- recordDiscoveryFlag :157-159: `if (existing.state !== 'pending_confirmation') return {... action: 'already_past_discovery'}` -- applies to 'rejected' too, so the same segment_key can never be re-discovered automatically once any row exists.
- registerManuallyObservedFinding :125: `if (existing) throw new Error(`a finding for '${key}' already exists ...`)`.
- No DELETE on nfl_candidate_findings anywhere in server/ (grep). No route or CLI exposes rejectFinding/promoteFindingToShrink/registerManuallyObservedFinding: `grep -rn ... server/routes server/services` hits only the growth.js:253 comment.
- Caveat: rejectFinding (:388-395) has no state precondition, so a human running a node one-liner could set finding 1 to 'rejected', removing it from eligibleForHoldout and unblocking the cycle. That is an out-of-band SQL/REPL intervention, not a code path, and it still leaves the segment permanently un-renewable under its key. It does not refute the gap.

## 7. Test coverage -- CONFIRMED

test/nfl-candidate-findings.test.js line 30 imports `__test` but only calls `__test.assertRuleUnchanged` (:92, :99) plus recordDiscoveryFlag/assertSeasonRoleAvailable via destructuring (:33). No call to recordHoldoutTest anywhere in test/ (grep). runCandidateFindingsForSeasonEnd is tested only for the blind-audit deferral (:174-179). The comment at :219-221 admits the holdout replay path is "exercised separately" -- it is not, in this file. So the abort behaviour has no test.

## 8. SHOULD-BE vs code

| Should be | Code |
|---|---|
| per-finding isolation | none at :280-284 |
| stale => recorded 'stale' event, skipped | only in promotedFindingVeto (:325-335); season-end path throws |
| versioned (segment_key, rule_version) | 024:31 UNIQUE(segment_key); no version column (025 only adds discovery_note) |
| identity = declared manifest of predicate files | 186-file transitive closure, complete:false (code-identity.js:79-113, nfl-replay.js trainingAuditCodeHash) |

Nothing in the SHOULD-BE list is implemented. Verdict stands.
