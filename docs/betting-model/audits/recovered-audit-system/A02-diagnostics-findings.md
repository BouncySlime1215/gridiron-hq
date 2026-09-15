# A02 — Diagnostics, statistical machinery, and the candidate-findings ledger

Reader: A02-diagnostics-findings. Date: 2026-09-11. Repo read-only; DB read via node:sqlite readOnly.
Lines read: 3,383 across the 14 assigned files (wc -l covered by full `cat -n`), plus supporting reads of
nfl-replay.js (28-75, 455-1000), audit-registry.js (118-135, 195-305), decay-watch.js (30-60, 150-215),
nfl-model-growth.js (160-325), migrations/024, platform/code-identity.js (all 174), nfl-auto-picks.js (9-146),
nfl-expert-coordinator.js (253-278), nfl-passing-specialists.js (183-230), routes/nfl-betting.js (225-240),
docs/CLAUDE-NEXT-STEPS.md sections 3, 4, 7, 9.

## Contract the plan sets (sections 3/4/7/9)

- C08 (P2): findings provenance must not fail open; require provenance at evaluation, promotion, serving;
  version the rule key and preserve old evidence; **isolate one stale finding's failure**; renewed same-label
  rule must get new evidence.
- C17 (P2): plug-in variance from the evaluated sequence is not "always valid"; use a declared protocol or
  fixed endpoints; do not peek repeatedly at conventional p-values.
- §9.2: 2021–2025 are development data; "rearranging them does not make them newly unseen"; paired weekly
  resampling with zero-bet weeks retained; count every attempted segment in a trial register.
- §9.3: fixed review endpoints first; if continuous monitoring is required, qualify a method.
- §9.4: "Software test success alone never qualifies betting authority."

## Live DB state that anchors the findings (server/data.sqlite, read-only)

- `nfl_candidate_findings`: exactly one row, id 1, `spread_x_timing|big spread (7+) + late (wk14+)`, direction
  weak, state `discovered`, rule_definition_hash `4303bbce…9085`, discovery seasons [2021..2025], confirmed
  2026-09-09 21:20:50. Five `nfl_candidate_finding_seasons` rows, all role `discovery`, no holdout rows.
- Recomputed current predicate identity (code-identity.js closure over nfl-replay/stats-util/nfl-policy roots)
  = `bfc269cc…4b20`; closure = **186 files**, `complete:false` (unresolved dynamic imports in
  platform/code-identity.js, services/draft-assist.js, services/nfl-execution-edge.js). Stored hash does NOT
  match. Finding 1 is stale today.
- `audit_registry`: 15 rows; `always_valid_p` is NULL on every row; the five `require_significance=1` audits
  (6, 9, 13, 14, 15) all have passed=0. The sequential machinery has never gated a real audit.
- `decay_watch_runs`: every row `insufficient_data`, n=0.
- `nfl_candidate_robustness_audits`: 6 saved reports (2026-08-31), all candidate_id
  `unified-all-inputs-v3-isolated-roster`.
- `nfl_weekly_expert_examples`: latest audit_run_id 32 (2021–2025, 20,780 rows, 18,881 observed).

---

## server/services/stats-util.js (268 lines)

Purpose: shared helpers — shrinkage, quantile, seeded PRNG (mulberry32), samplers, Cholesky, probit,
normalCdf, Holm.

Math checked at the line:
- `holm` (262-267): sorts p ascending; adjusted_(k) = max over j≤k of min(1,(m−j)·p_(j)) with 0-indexed rank
  → (m − rank) = m − j + 1, i.e. the textbook Holm step-down with monotonicity enforcement. Verified numerically:
  holm([0.01,0.04,0.03,0.5]) → [0.04,0.09,0.09,0.5] (correct: 0.03×3=0.09 caps the 0.04×2=0.08). Correct.
- `quantile` (64-70): linear interpolation on sorted copy. Correct.
- `withRandomSeed` (93-98): swaps a module-level rng; not re-entrant across async, but all callers are sync.
- `normalCdf` (248-254): A&S 7.1.26, |err| < 7.5e-8. Fine.

Defects: none material. (P3 note) `percentiles` (72-73) rounds to 1 decimal and coerces null→0.

Verdict: sound.

## server/services/backtest-significance.js (268 lines)

Purpose: paired (optionally cluster/block) bootstrap of mean(B)−mean(A); aligned error helpers; mSPRT
"always-valid" p-value with the C17 relabel.

Flow/time: pure functions; no DB. Callers (grep): ~30 call sites of `pairedBootstrapDiff` across props,
consensus weights, team strength, passing diagnostic, role lab, etc.; `alwaysValidPValue` is consumed by
audit-registry.js:210 and decay-watch.js:172 only.

Math checked:
- Ungrouped bootstrap (84-93): n draws with replacement, diff of means. CI90 = order stats at
  floor(0.05·it), floor(0.95·it) (97-98). `significant = !(lo<=0 && hi>=0)` (103). Standard percentile
  bootstrap. OK.
- Grouped (62-82): resamples `numGroups` whole groups, divides by the resampled unit count (80) — a
  ratio-of-sums cluster bootstrap. OK.
- mSPRT (216-230): logΛ = ½·log(σ²/(σ²+nτ²)) + n²τ²x̄²/(2σ²(σ²+nτ²)); p = min(1, 1/Λ). Matches
  Johari–Pekelis–Walsh closed form for N(0,τ²) mixture with known σ². OK. Note: this is 1/Λ_n at the current
  look, not the running-minimum p_n = min_{k≤n} 1/Λ_k that the paper defines as the always-valid p-value; both
  are valid at any stopping time by Ville, but the non-monotone version can rise after falling.

Defects:
- **P2 — silent fail-open on cluster size.** `if (groups && groups.length >= n)` (62) else plain resample
  (83-93). A caller that passes a mis-sized `groups` array (off-by-one after filtering, a different row set)
  silently gets the ungrouped interval, which test/paired-bootstrap-clustering.test.js proves under-covers
  (<0.85 for nominal 0.90). test 111-117 enshrines this as "ignored gracefully". Should return `{error}` or at
  minimum a `clustered:false` field.
  snippet: `if (groups && groups.length >= n) {` (62)
- **P3 — degenerate plug-in variance.** `Math.max(1e-9, …)` (224): a constant sequence of five values yields
  σ²=1e-9 and p_fixed_sample_only = 0 (verified: [1,1,1,1,1] → p 0, log_lambda 2.08e9). A zero-variance
  sequence should be refused, not declared infinitely significant.
- **P3 — label survives only if consumers honour it.** The C17 relabel (239-250) is correct in this file; see
  audit-registry defect below where the consumer collapses both fields with `??`.

Verdict: math correct; the anytime-validity claim is now honest at the source; fail-open on groups is real.

## server/services/nfl-candidate-findings.js (404 lines)

Purpose: the discovery → robustness → promotion → live-veto ledger over `analyzeErrors` segment findings.
Tables: reads/writes `nfl_candidate_findings`, `nfl_candidate_finding_seasons`; reads
`nfl_blind_audit_runs` (246). Consumers: nfl-auto-picks.js:134 (live veto), nfl-model-growth.js:256
(season-end orchestrator), routes (status/promote — not in assigned set).

Flow:
1. `runCandidateFindingsForSeasonEnd(season)` (245-288): skip if a blind audit is running; replay one season,
   `analyzeErrors` (Holm + effect gate + LOSO); each flagged segment → `recordDiscoveryFlag` (145-175):
   first flag → `pending_confirmation`; second, different-season flag → `discovered` and hash frozen (171-173).
   Then every `discovered|validating` finding not already touching this season gets `recordHoldoutTest`
   (278-284).
2. `recordHoldoutTest` (207-235): `assertSeasonRoleAvailable`, `assertRuleUnchanged` (209, outside the
   try), `proposeAdjustment` (mechanical "stop betting this segment"), `passed = helped_holdout === true`
   (218), then `nextHoldoutState` (193-199): any fail → rejected; ≥3 passes → flagged_for_review.
3. `promoteFindingToShrink` (366-387): state must be `flagged_for_review`, direction must be `weak`, actor
   required, `assertRuleUnchanged`, then `UPDATE … state='promoted'`.
4. `promotedFindingVeto` (311-342): for each `promoted` finding whose segment_key is in `segmentsFor(bet)`,
   veto; stale hash → skip and report (325-336).

Time semantics: holdout is "seasons not used for discovery of this finding". It is NOT "seasons after the
model was developed". The earliest genuine holdout for finding 1 is 2026; three passes need 2026, 2027, 2028;
earliest lawful promotion is early 2029.

Can a finding be promoted without out-of-sample confirmation? Through the exported API, no: promotion
requires `flagged_for_review`, which only `nextHoldoutState` sets after 3 passes / 0 fails. But:

Defects:
- **P1 — the only live finding is already stale and will crash the season-end cycle; it can never be renewed.**
  `assertRuleUnchanged` recomputes `segmentRuleHash` (49) whose `implementation` is the 186-file
  code-identity closure (nfl-replay.js:~1000 `codeIdentity(['services/nfl-replay.js','services/stats-util.js',
  'services/nfl-policy.js'])`). Finding 1's stored hash (09-09, old git scheme) ≠ current (`bfc269cc…`).
  At 2026 season end, `recordHoldoutTest` throws at line 209 — `assertRuleUnchanged(finding)` sits OUTSIDE the
  `try` at 213 — and the loop at 280-284 has no per-finding isolation, so `runCandidateFindingsForSeasonEnd`
  throws; nfl-model-growth.js:256 calls it bare inside the cycle's `try`, whose `catch` (302-307) marks the
  whole `nfl_model_growth_runs` row `error` and rethrows: online_neural, risk_lab, player_learning and
  expert_council settlement after line 256 do not run. The comment at 319-324 ("stops the automatic pipeline
  outright") makes this deliberate, contradicting C08's "Isolate one stale finding's failure rather than
  aborting unrelated evaluation." Renewal is impossible: `segment_key TEXT NOT NULL UNIQUE` (024:31),
  `registerManuallyObservedFinding` throws "already exists" (125), `recordDiscoveryFlag` returns
  `already_past_discovery` (157-158). C08's "renewed same-label rule gets new evidence" is open.
  snippet: `assertRuleUnchanged(finding);` (209) / `for (const finding of eligibleForHoldout) { … holdoutActions.push(recordHoldoutTest(finding, season, config)); }` (280-284)
- **P2 — identity is too wide to ever survive three seasons.** The closure hashes db/index.js,
  migrations/000_legacy_schema.js, betting/nfl/strategy/t60-runner.js, every db/schema file (186 files,
  `complete:false`). Any edit anywhere in that graph re-stales every finding; memoised per process
  (`_trainingAuditCodeHashCache`). A predicate identity should hash `segmentsFor` and the specific bucket
  helpers (nfl-rolling-leaders, nfl-availability, nfl-news-signal) — a declared manifest as C08 asks — not the
  DB layer. snippet: `const current = segmentRuleHash(segment);` (49).
- **P2 — holdout "confirmation" is a directional coin flip with no effect size or minimum n.**
  `passed = result.helped_holdout === true` (218) where nfl-replay.js:~815 `helpedHoldout = (holdAdj.roi ?? -9)
  > (holdBase.roi ?? -9)`. Dropping a segment raises ROI iff the segment's own ROI in that season is below the
  season average — ≈50% for a null segment, so P(3 straight passes | no effect) ≈ 12.5%; a holdout season with
  2 matching bets counts. Nothing checks `uncertainty(...)`, a minimum matching-bet count, or MIN_EFFECT_ROI on
  the holdout side. Contrast discovery (Holm + effect gate + LOSO). §9.2 asks for declared effect and paired
  weekly resampling.
- **P2 — development seasons can serve as holdout for algorithmic findings.** No global "development
  seasons" floor: a finding first flagged on 2021/2022 accepts 2023–2025 as holdout. `POST
  /profitability/model-growth/run` takes `body.season` (routes/nfl-betting.js:232) and the cycle calls
  `runCandidateFindingsForSeasonEnd(season)` when `season_complete`, so 2023, 2024, 2025 can be fed in order
  today. The manual path (122-139) locks every seen season precisely because the authors know 2021–2025 were
  inspected (the code comment at nfl-replay.js:466-470 says the pattern was seen "pooled across all 5 audited
  seasons"); the algorithmic path has no equivalent. §9.2: "Rearranging them does not make them newly unseen."
  snippet: `assertSeasonRoleAvailable(finding.id, season, 'holdout');` (208) — only checks per-finding role.
- **P2 — promotion trusts a mutable `state` column, not the evidence rows.** `promoteFindingToShrink` checks
  `finding.state !== 'flagged_for_review'` (369) and nothing else about evidence; the tests reach promotion by
  `UPDATE nfl_candidate_findings SET state='flagged_for_review'` (test 104, 116, 158, 221). No trigger, no
  lifecycle-event table, no recount of `nfl_candidate_finding_seasons` (≥3 holdout passes, 0 fails, all holdout
  seasons > max discovery season). One SQL statement is the whole gate. §9.4: software success alone never
  qualifies authority.
- **P3 — `promotedFindingVeto` fails safe but authority text is inflated.** Reason string (339) says "proven
  unreliable across N+ seasons" using the count of *discovery* seasons, not holdout confirmations.
- **P3 — `rejected` is terminal but not evidence-preserving for re-discovery.** A rejected key blocks any
  future discovery (157-158 returns already_past_discovery) — acceptable as a trial-register behaviour, but
  there is no versioned key to record a redefinition.

Verdict: the state machine is honestly designed and the API cannot promote without three passes, but (a) the
one real finding is dead and will take the season-end cycle down with it, (b) the holdout test is far weaker
than the discovery test, (c) development seasons are not fenced, (d) promotion is a column value.

## server/services/nfl-candidate-analysis.js (313 lines)

Purpose: champion-vs-candidate robustness report (attribution, fixed-volume, edge calibration, ablations,
cutoff-safe reliability replay, season-drop, 2021 opening season, macro diagnosis). Writes
`nfl_candidate_robustness_audits` (302-307). Route: POST at routes/nfl-betting.js:746. Consumed by
nfl-diagnostic.js:144 (`latestCandidateRobustnessReport`).

Time semantics: opened historical replay (labelled as such, 279). `historicalReliabilityReplay` (63-112) is
cutoff-safe within the replay: examples for week w are appended after the week's decisions (96-102). But
`feature_snapshot.model_trace` comes from `replaySeason`, whose fits may be later-cutoff (C07) — inherited, not
this file's defect.

Math checked: `unitsFor` payout (12-13) correct for Won at American price; edge buckets (38-40); break-even
110/210 = 0.5238 (192); cover logic (81-84) correct (home covers iff actual_margin + home_spread > 0).

Defects:
- **P2 — hard-coded conclusions presented as computed diagnosis.** `verdict: 'The candidate is not
  profitable…'` (211), `data_integrity.state: 'not_primary_failure'` (219-222), `regime_instability.state:
  'critical'` (233-236), `openingSeason.diagnosis` (183-187, "Opening weights are now learned only from
  2018-2020…") are string constants independent of the numbers beside them. Same class as C16 ("overstates what
  it tested"). If the candidate ever became profitable the saved report would still say it is not.
  snippet: `verdict: 'The candidate is not profitable. The failure is primarily forecast/selection quality…',` (211)
- **P3 — `unitsFor` pays any non-Push/non-Lost result as a win** (12-13): a void/unknown `result` is credited
  the win payout. Replay bets are settled today, but C09 asks for explicit unknown/void states.
- **P3 — `signalAblations` runs 9 full five-season replays** (51-61) synchronously per report; fine for a
  manual POST, but it re-tunes ("harmful/helpful") on the opened window — labelled (289).

Verdict: useful development diagnostic; the constant verdict strings must go.

## server/services/nfl-diagnostic.js (161 lines)

Purpose: aggregator of health/evidence reports (profitability, news, sources, scheduler, candidate audit,
robustness, consistency, reliability, coordination, neural replay, council, latency, postgame truth).
Reads `news_items` (21-26) and `nfl_historical_signal_replay` (52-57); no writes. Served at
routes/nfl-betting.js:219 (`live=1` or cached report).

Math: `ats_direction_rate` (54-56) excludes ties with market; fine. `avg_lag_minutes_7d` uses MAX(0, …).

Defects: P3 — `bottlenecks[0].severity: 'critical'` (84) and priority-4 text (99-102) are constants; the
"finding" strings are templated but severities are not derived. Otherwise a projection with no inference.

Verdict: acceptable; no statistical claims of its own.

## server/services/nfl-slice-diagnostic.js (148 lines)

Purpose: council accuracy/calibration cut by season/week/matchup/roof/specialist/confidence/coverage from
`nfl_weekly_expert_examples` joined to `game_lines` (109-114). 2021 quarantined (18). Consumed by
nfl-blind-audit.js:589 and route :211.

Math: implied direction probability P = Φ(|f|/u) (92) — correct for a normal residual forecast; ECE weighted
by n (102-103); `readable` floor 30 (19). Directional rate excludes null `directional_correct`.

Defects:
- P3 — `matchupType` maps a NULL spread to `pickem_to_3` (`Number(game.spread ?? 0)`, 34) rather than
  `unknown`; only a missing game row is 'unknown'.
- P3 — `summarize.rmse` mixes observed and unobserved rows only via `Number.isFinite(squared_error)`; fine
  given nulls, but `coverage` denominators differ between `rows` and `directional_calls` without saying so.

Verdict: sound; labels every slice with its sample as the plan asks.

## server/services/nfl-abstention-audit.js (195 lines)

Purpose: grades every replay decision by what the policy did (taken vs declined by reason). Reads through
`replaySeason` only; memoised (108-117); served through report-cache.js:35 and routes/betting-hub.js:26.

Math: Wilson (45-52) correct; two-proportion pooled z (59-76) correct with erf approx (A&S 7.1.26 form);
`unitsFor` (31-36) consistent with replay. Verdict thresholds: settled<100 → "too small"; lower Wilson bound
> break-even → "DECLINED A PROFITABLE POOL".

Defects:
- P3 — both intervals ignore weekly clustering the rest of the codebase insists on (`uncertainty` cluster
  bootstrap); §9.2 asks for paired weekly resampling. Pool comparison is between eligible and ineligible
  decisions of the same weeks; a z-test on independent proportions overstates precision.
- P3 — `_cache` (108) is process-lifetime keyed only by seasons|markets; a replay-config change or new settled
  2025 games do not invalidate it (comment says "cleared with the model cache", but `clearAbstentionAuditCache`
  is only exported, not wired here).
- P3 — declined pool includes `weekly_capacity` (bets the model wanted); the by_reason split handles it, but
  `selection_works` headline lumps it into "refused".

Verdict: honestly labelled hypothesis generator; not evidence.

## server/services/nfl-coordination-audit.js (63 lines)

Purpose: machine-readable statement of what reaches the decision. No DB writes; probes
`calibratedCoverProbability` at (current UTC year, 0.5, 0) (14-15).

Defects: P3 — `production_state: calibrationQualified && neural.production_eligible ? 'review_eligible' :
'abstain_no_proven_edge'` (60-61) derives a "review_eligible" label from two software flags with no forward
economic evidence; `verdict`/`hard_truths` (48-55) are constants. Not authoritative (nfl-profitability decides),
but a reader could quote it.

Verdict: descriptive only.

## server/services/nfl-specialist-audit.js (115 lines)

Purpose: per-specialist scale/conviction/duplication audit on the latest expert rows (2021 excluded).

Math: RMSE vs zero-forecast (53); correlation (26-31) Pearson; consensus rule ≥5 agree (84-86).

Defects:
- P3 — `verdict` bands (54-57): own < 0.995·market → "removes error: a real, small signal" — a 0.5% RMSE
  reduction on a few hundred games with no interval is labelled "real".
- P3 — `clears_breakeven` (61) compares a directional-correctness rate to the −110 break-even 0.5238; the
  directional rate is not a priced win rate (pushes/prices absent), so the comparison is nominal.
- P3 — `fitExpertCoordinator(9999, 1, { auditRunId })` (109-110) trains on every row of the run
  (`season<9999`), i.e. in-sample over the same games the audit scores, while the comment (101-102) calls the
  result "the scale each has earned walk-forward".
- P3 — duplicates threshold 0.3 in code (73) vs "|r| ≥ 0.5" in the finding text (96); the text filters ≥0.5 so
  the sentence is consistent, but `duplicates` array mixes both.

Verdict: descriptive; labels mostly honest; the "walk-forward" claim at 101-102 is not.

## server/services/nfl-passing-diagnostic.js (155 lines)

Purpose: attempts × YPA error decomposition; component-replacement comparisons via clustered paired bootstrap;
oracle attribution barred from promotion.

Math: decomposition identity (22-23) exact: (pA−aA)·pY + aA·(pY−aY) = pA·pY − aA·aY. Squared-error split
(65-68) with 2·cov term reconstructs total. Walk-forward history (115-142): prior rows only; appended after
grading; rows come from `propReplayRows` which iterates seasons ascending and weeks sorted ascending
(nfl-props.js:79, 93), so chronology holds. Bootstrap clustered by game (43).

Defects: P3 — `history.length >= 2` and `actualAttempts > 10` gates are undeclared thresholds; fine for a
diagnostic. None material.

Verdict: sound.

## Tests

- test/nfl-candidate-findings.test.js (237): covers discovery flags, same-season no-op, E11, hash
  match/mismatch, veto fail-safe, strong refusal, Rule 1, `nextHoldoutState` pure logic, actor gates, blind-audit
  deferral, manual registration, veto scope. **Gap (P2):** the only path to `flagged_for_review` —
  `recordHoldoutTest` with a real `proposeAdjustment` — is never exercised; every promotion test flips `state`
  by SQL (104, 116, 158, 221) and says the real path "is exercised separately" (156-157, 218-220), but no test
  in the repo references `recordHoldoutTest` (grep). The P1 crash above (stale hash thrown outside the try,
  loop without isolation) is therefore untested.
- test/always-valid-significance.test.js (114): simulation under true null with declared σ=1 confirms peeking
  inflation for the naive test (>0.15) and control for mSPRT (≤0.09, i.e. a 1.8× slack over nominal 0.05);
  plug-in path asserted `anytime_valid:false`. It does not test that a consumer refuses to gate on
  `p_fixed_sample_only` repeatedly (see audit-registry).
- test/nfl-slice-diagnostic.test.js (78): fixture with quarantine, matchup, roof, specialist, confidence and
  coverage buckets; reasonable.
- test/paired-bootstrap-clustering.test.js (117): coverage study proves ungrouped under-coverage (<0.85) and
  grouped ~0.90; line 111-117 enshrines the silent groups-length fallback (defect above).

## Cross-file: what the C17 consumers actually do

- audit-registry.js:219-227 — `const alwaysValidP = alwaysValid ? (alwaysValid.p_always_valid ??
  alwaysValid.p_fixed_sample_only) : null; const alwaysValidSignificant = alwaysValid ? alwaysValidP <
  correctedAlpha : null; … passed = require_significance ? (meetsThreshold && significant && alwaysValidSignificant)`.
  **P2:** the C17 relabel is collapsed by `??`, so a plug-in, single-endpoint p gates exactly as the
  anytime-valid one would, and it is compared to the Šidák-corrected alpha (a cross-hypothesis correction) —
  two different corrections applied to one number. Mitigation in the DB: no audit has ever supplied a sequence
  (`always_valid_p` NULL on all 15 rows), so this has never fired. Also `p_value` from producers is compared to
  the same Šidák alpha (200-201).
- decay-watch.js:172 — calls with no sigma in a repeatedly-run monitor (the exact §9.3 continuous-monitoring
  case), labels it "repeated-look p (NOT anytime-valid)" and still sets `decayed/reversed` flags. Honest label,
  unqualified method; all runs so far `insufficient_data`.

## Answers to the reader questions

1. Holm: correct implementation (stats-util 262-267); used in `analyzeErrors` over all segments with n≥minBets
   in one single-season call (nfl-replay 691). The family is "everything tested this run", not "everything ever
   tested" — Phase-3 two-season reconfirmation is the cross-run control; §9.2's trial register is not written
   anywhere (segments below minBets or failing Holm leave no ledger row).
2. Paired bootstrap: correct percentile/cluster bootstrap; fails open on mis-sized `groups`.
3. Always-valid: mSPRT formula correct; anytime-validity honestly conditional on declared σ; the gating
   consumer (audit-registry) ignores the distinction; none adopted in practice (all NULL) — C17's "none adopted"
   holds as an operational fact.
4. Findings ledger: API cannot promote without 3 holdout passes; but the holdout pass is a directional coin
   flip, development seasons are not fenced for algorithmic findings, promotion trusts a mutable column, the
   single live finding is already stale, and a stale finding will abort the season-end cycle. Earliest lawful
   promotion of finding 1, if it were not stale: after the 2028 season.
