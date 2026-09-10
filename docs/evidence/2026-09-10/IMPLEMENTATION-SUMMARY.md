# Implementation summary — 2026-09-10, following Codex's CLAUDE-NEXT-STEPS.md

Written by Claude (Fable 5.1 → Sonnet 5, same continuous session) working
directly on local `main`, on top of Codex's own first-repair commits
(`fcf7e1f`, `cbf66ce`, `3f19e25`, `4a9a9c1`). This is section 13's required
return: what changed, what was verified, what is deliberately deferred, and
an honest recommendation. It supplements — does not replace — the plan
(`docs/CLAUDE-NEXT-STEPS.md`) and its evidence appendix
(`docs/evidence/2026-09-09/AUDIT-EVIDENCE.md`).

## 1. What changed, and the evidence for each

| # | Finding | File(s) | What changed | Regression test | Commit |
|---|---|---|---|---|---|
| M01 | Reversed Bayesian prior-weight formula (should be σ²/(σ²+nτ²), was τ²/(τ²+nσ²)) | `nfl-preseason-blend.js` | Fixed formula; `prior_variance` now measures actual year-over-year prediction error (previously never used the prior season's value at all); `per_game_variance` computed on the same MOV-dampened scale the blend uses; added `asOfSeason` cutoff so a historical prediction never calibrates from later seasons | 14 tests (was 8), incl. explicit monotonicity in both directions, precision-weighted-mean identity, no-leakage-across-seasons | `c83b348` |
| M13 | `opp_adjusted` component algebraically reduced to plain `off_epa-def_epa` (mathematically identical to the existing `epa_net` component); `rest_travel` never measured travel | `nfl-ensemble.js` | `opp_adjusted` now performs a real first-pass strength-of-schedule adjustment using each team's actual opponents (`c.schedule`, new); renamed/re-documented `rest_travel` honestly (kept its `id` stable for provenance continuity) | 2 new tests proving two teams with identical raw EPA but different schedules now get different margins | `c83b348` |
| M07 | Opener comparison field claimed "Same picks" while silently reselecting the side | `nfl-replay.js` | Split into `same_side_opener_regrade` (actual side, held fixed) and `opener_side_reselected_counterfactual` (a different, explicitly-flagged selection policy); run summary now reports both with accurate notes | 5 new tests | `d958b24` |
| E11 | Season-end orchestrator censored holdout years for any finding re-flagged by that year's own discovery scan, even when no DB row was written (`already_past_discovery`) | `nfl-candidate-findings.js` | Removed the redundant, buggy tracking set; the existing `alreadyUsed` DB check is now the sole, correct guard | 1 new test, direct root-cause reproduction | `d958b24` |
| M12/E12 | `segmentRuleHash` hashed only labels, not the predicate implementation; a "strong" (profitable) finding could be promoted through the same veto that only ever means "stop betting here" | `nfl-replay.js`, `nfl-candidate-findings.js` | Hash now folds in this codebase's own content hash (reuses `saveTrainingAudit`'s pattern); holdout tests throw on a stale hash, the live veto fails safe (no crash); `promoteFindingToShrink` now refuses any `strong`-direction finding | 5 new tests | `d958b24` |
| M05 | Residual-skill gate fit its slope and graded its own significance on the identical rows | `nfl-ensemble.js` | Explicit chronological sort of the walk-forward week loop, then a genuine 70/30 earlier-block-fit / later-block-score split; `ENSEMBLE_FIT_VERSION` bumped v8→v9 so no artifact fit under the old formula is reused | Existing authority-test fixture extended (needed proportionally more history to clear the now-genuinely-stricter held-out bar — expected) | `53ea635` |
| E4 | `attemptAcceptance`'s corridor/suspect-price safety gates read `modelLine`/`marketLine`/`fairProbability` from the request body; the UI never sent them, so both checks silently reported "not evaluated" on every real acceptance | `nfl-execution-lifecycle.js`, `nfl-execution-decision.js`, `nfl-execution-pipeline.js`, `nfl-market.js`, migration `026` | Three new columns freeze the model's forecast on the opportunity at open time; `attemptAcceptance` now derives all three server-side from the persisted opportunity, ignoring anything the caller supplies | 1 new regression test proving caller-supplied values are now inert | `ee548e6` |
| WP0 §3,5,7,8 | No reusable "truthful evidence record" generator existed; comparisons were one-off hand-written SQL | new `nfl-audit-overview.js` | `auditOverview(runId)`: per-market breakdown, spread-only bootstrap CI, season/week coverage with an explicit weeks-1-4 flag. `compareAuditRuns(a,b)`: compares saved `result_hash` per week — no replay needed | 7 new tests, verified against real run 27/31 data | `404566b` |
| WP0/15, WP16§16.3 | Competing planning docs; no CI | doc deletions, `docs/evidence/contracts/profitability-policy-v1.3.md`, `.github/workflows/ci.yml` | Removed 5 docs marked "delete superseded" (verified no runtime reader first); froze the one plan section (`nfl-policy.js`'s 200/75 gates) actually cited by running code at its new location, values unchanged; added a bounded, hermetic, credential-free CI workflow, verified to pass every step locally before committing | full suite green + all 5 CI steps run locally | `a7bcf00` |

Already done by Codex before this session started (not re-litigated here):
M04 (challenger exclusion authority), M06 (calibration/serving-graph parity),
E1 (canonical event/decision-quote resolution), E3 (contract/price/settlement
integrity fixtures) — see `docs/evidence/2026-09-09/AUDIT-EVIDENCE.md`'s own
"first repairs" section and commits `fcf7e1f`/`3f19e25`.

**Full test suite after every slice above: 1246–1247 tests, 0 failures, 1
pre-existing skip** (re-verified after each commit, not just once at the
end). `npm run typecheck`, `npm run lint`, `npm run build`, and
`npm run start:smoke` all pass locally with the exact commands the new CI
workflow runs.

## 2. Deliberately deferred, and why

This plan is genuinely large — 16 work packages, several explicitly
multi-week in nature (a real prospective T-60 evaluation requires actual
calendar weeks of NFL games, not engineering time). The items below were
assessed and consciously not attempted tonight, in order of what the plan's
own "Suggested effort allocation" and "Delivery order" sections imply should
matter least among what remains:

- **E5** (execution-slate shopped-line/teaser win-probability formulas are
  heuristic, not empirically fit) and **E6/E7-remainder/E8-remainder/E9/E10**
  (append-only decision-run layer, censored/pending previews, settlement
  correction events, one unified CLV ledger, collection-health reporting) —
  all real, audit-identified defects in the **forward paper-execution loop**,
  which has recorded **zero** real opportunities, lifecycle events, or
  settled tickets at last inspection (`nfl_execution_opportunities: 0`,
  per the evidence appendix). None of these affect the historical blind-audit
  numbers this session's other work (and the audit run below) actually grades.
  Fixing them properly, to the same standard as M05/E4 above, is real,
  bounded, sequential work — not something to rush through in the time
  remaining without risking exactly the kind of half-verified change this
  brief exists to prevent.
- **Work package 3** (a genuine T-60 decision-time protocol) — the plan
  itself specifies this needs a unified temporal-data interface spanning
  quotes, injuries, news, and weather, all currently cut off at WEEK
  granularity throughout this codebase, not literally at kickoff-minus-60-
  minutes. Building that properly is a multi-file architectural project on
  the scale of tonight's earlier Phase 0-3 work, not a bolt-on. Attempting a
  shortcut version risked producing something that LOOKS like a T-60
  protocol without actually being decision-time-safe, which is worse than
  not building it.
- **Work package 4 remainder, Work package 6** (freeze one spread experiment,
  begin prospective collection) — correctly sequenced AFTER work package 3;
  premature without it.
- **Physical folder reorganization** (moving ~261 server files into the new
  ownership tree) — the plan's own words: "Do not move hundreds of model
  files in one unreviewable commit," and "Finish the full folder disposition
  without letting cosmetic moves delay the first complete workflow." This is
  the single largest, highest-mechanical-effort, highest-regression-risk
  piece of the entire brief, and it changes zero model behavior or audit
  numbers. Deferred in full; the manifest (`folder-map.csv`) and target tree
  (`FOLDER-REORGANIZATION.md`) remain the governing reference for whenever
  it is undertaken.
- **~24 of the ~29 old planning/reference documents** marked "migrate content
  then delete" — 5 were removed tonight (nothing to extract). The rest
  (e.g. `PROFITABILITY_PLAN.md`, 1101 lines) contain measured results and
  experiment contracts the plan explicitly says must be preserved before
  deletion; only the one section actually cited by running code was
  extracted tonight. Deleting the rest without first verifying every unique
  measurement survives would violate the plan's own preservation rule.

None of the above blocks running the historical audit below — it grades the
existing replay/ensemble/policy code, all of which the fixes above directly
improved the correctness of.

## 3. Architecture map (abbreviated)

```
data → forecast → calibration → policy → quote refresh → ledger → settlement → evaluation
```

- **Forecast**: `nfl-ensemble.js` (raw + market-residual blend; M04/M05/M13
  fixed tonight/earlier), `nfl-online-neural.js` (eligible-for-review, not
  auto-promoted), `nfl-preseason-blend.js` (staged, M01-fixed, still not
  wired to production).
- **Calibration**: `nfl-cover-calibration.js` (M06 — now bound to the exact
  served forecast identity via `nfl-forecast-identity.js`).
- **Policy**: `nfl-policy.js` (`NFL_PRODUCTION_POLICY`, frozen 2018-2020
  thresholds; `FORWARD_SAMPLE_TARGETS` now cites its frozen contract at
  `docs/evidence/contracts/profitability-policy-v1.3.md`).
- **Findings governance**: `nfl-candidate-findings.js` (E11/M12/E12 fixed
  tonight — a season can never change role, a stale predicate hash is
  caught, a "strong" finding can never be shrink-vetoed).
- **Execution** (paper-only, zero real usage): `nfl-execution-pipeline.js` →
  `nfl-execution-lifecycle.js` → `nfl-execution-decision.js` (E4 fixed
  tonight) → `nfl-execution-replay.js`/settlement.
- **Evaluation**: `scripts/nfl-blind-audit.mjs` (the historical replay engine
  this brief's audit below runs), `nfl-audit-overview.js` (new tonight —
  the corrected, market-split scoreboard and run-comparison tool).

## 4. Honest advance/stop recommendation

**What improved:** two real math bugs fixed (M01, M13's `opp_adjusted`) that
were previously either mis-weighting a staged signal or silently duplicating
an existing one; one real optimism-in-evaluation bug fixed (M05) that made
the residual-skill gate look more permissive than it should ever have been
(it has never once passed on real data, before or after — this fix makes
that "never passes" honest rather than "never passes despite an inflated
test"); three real governance/integrity bugs fixed in the findings pipeline
(E11, M12, E12) that would have let repeated bad patterns dodge scrutiny and
let a future "profitable-looking" segment get vetoed by mistake; one real
security/integrity bug fixed in execution (E4) closing a path where a client
could silently bypass two safety checks; one genuinely new, tested reporting
capability (the audit overview) that makes every future audit self-
documenting instead of hand-assembled by SQL.

**What did not change:** none of tonight's fixes touch the mechanism this
project already established as the reason there is no proven spread edge —
the ensemble is structurally anchored to the market (M04/M05 confirm the
residual gate has never passed; M13's `opp_adjusted` fix is a correctness
improvement to a component whose family already collapses to ~3 independent
signals per tonight's earlier audit workflow). Run 27's historical spread
record (153 bets, 72-78-3, -11.85 units, -7.75% ROI) is unaffected — none of
tonight's changes retroactively alter graded history, by design; only a NEW
run (below) reflects the corrected code, and it uses the identical frozen
policy/thresholds, so a different result would mean something in the
ensemble's actual behavior changed, not that history was rewritten.

**Recommendation:** advance on infrastructure/integrity (all of section 1's
fixes are real, tested, and safe to keep); do not advance on money authority
— nothing here establishes a spread edge, and the calibration gate remains
correctly blocked. The honest next steps, in the plan's own priority order,
are work package 3 (a genuine T-60 protocol) and completing work package 1's
remaining execution-integrity items (E5-E10), both scoped for a dedicated
follow-up rather than compressed into this session's remaining time.
