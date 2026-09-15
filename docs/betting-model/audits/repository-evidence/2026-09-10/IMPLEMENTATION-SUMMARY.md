# Implementation summary — 2026-09-10, following Codex's CLAUDE-NEXT-STEPS.md

Written by Claude (Fable 5.1 → Sonnet 5, same continuous session) working
directly on local `main`, on top of Codex's own first-repair commits
(`fcf7e1f`, `cbf66ce`, `3f19e25`, `4a9a9c1`). This is section 13's required
return: what changed, what was verified, what is deliberately deferred, and
an honest recommendation. It supplements — does not replace — the plan
(`docs/CLAUDE-NEXT-STEPS.md`) and its evidence appendix
(`docs/evidence/2026-09-09/AUDIT-EVIDENCE.md`).

## 0. Run 32 — the same protocol, post-fix, run to completion

After every fix in section 1 was committed and the tree verified clean,
blind-audit run 32 (`nfl-blind-week-chain-v1`, weeks 5-18 of 2021-2025,
identical protocol/policy/thresholds to runs 27 and 31) was preregistered
and run to completion. It sealed all 70 weeks with no failures.

| | Run 27 (audited baseline) | Run 32 (post-fix) |
|---|---:|---:|
| Spread | 153 bets, 72-78-3, **-11.855u, -7.75% ROI** (48.0%) | 156 bets, 74-79-3, **-11.088u, -7.11% ROI** (48.4%) |
| Total | 48 bets, 23-24-1, -2.945u, -6.13% ROI | 48 bets, 23-24, -2.945u, -6.10% ROI (unchanged — `opp_adjusted` only touches margin, never total) |
| Moneyline | 344 bets, 108-236, -40.615u, -11.81% ROI | 346 bets, 110-236, -33.868u, -9.79% ROI |
| **Combined** | 545 bets, 203-338-4, **-55.414u, -10.17% ROI** | 550 bets, 207-339, **-47.901u, -8.71% ROI** |

`compareAuditRuns(27, 32)` confirms all 70 overlapping weeks **differ** (0
unchanged) — unlike run 31, which was byte-identical to run 27 because no
code changed between them. This is the expected, honest signature of a real
code change: the blind audit replays with `blendMode: 'raw'` (its long-
standing default, per finding M06 — it does **not** exercise the
`market_residual` blend's residual-skill gate at all), so the fix that
actually moved these numbers is **M13**'s `opp_adjusted` repair — a real
component margin changed for real games. M01, M05, E4, E11/M12 are
correctness/integrity fixes that are either not wired into production
(M01), gate a mode this replay doesn't use (M05), or govern data this replay
never touches (E4, findings governance) — they were not expected to move
these numbers, and did not.

**Read this correctly:** a ~0.6-percentage-point spread ROI improvement on
one 70-week replay is well within the noise this project's own bootstrap
intervals already established (run 27's spread-only 95% ROI interval:
[-23.2%, +7.4%]; run 32's: [-22.1%, +8.0%] — nearly identical width and
center) — it is a mechanically explained, small, likely-coincidental movement
from
fixing one duplicate/broken component, **not evidence of a newly discovered
edge**. The spread record is still solidly negative, the interval still
spans zero, and the calibration gate that would ever authorize a real bet
remains correctly blocked. Nothing here changes the standing conclusion:
no proven spread edge against the closing line.

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

## 1b. Section 8.6 — does each feature family earn its influence?

Section 8.6 asks for "a compact table naming each existing source family,
actual consumer, paired later-block change, uncertainty, cost, and
keep/simplify/test-connection decision," and for **three separate answers**
per family: margin forecast, cover/push probability, and economic policy.

Two defects had to be fixed before the table could mean anything.

**The family list was a hardcoded four-element array** while the ensemble has
five families. Because `families` acts as a whitelist in `ensembleLine`,
every `without:X` configuration silently dropped **roster availability too** —
so every ablation this harness had ever produced measured the removal of two
families while reporting one. The list is now derived from the model catalog
(`da59af2`).

**The comparison used a different universe per configuration.** Each variant
selects its own bets: 204 for the full ensemble, 112 without efficiency, 432
for ratings-only. Comparing those ROIs compares three different cohorts of
games, and a variant can "win" by betting less often on a luckier subset.
`nfl-family-contribution.js` (`27c50e2`) scores every configuration on the
**intersection** of games all of them forecast — 1,424 games across 2021-2025,
identical for all six configurations — and reports all three answers.

### The baseline, before any family is removed

| | Full ensemble | The number it has to beat |
|---|---:|---:|
| Margin MAE (1,424 games) | 10.095 | market 9.762 |
| Cover Brier (1,391 decided) | 0.2580 | a constant 0.5 forecast scores 0.250 |
| Predicted pushes | 20.1 | 33 actually occurred |
| Units / ROI | -10.30u | -5.10% |

Three findings, none of them flattering, all of them on the same games:

1. **The model forecasts margin worse than the closing line does** — 10.095
   against 9.762. It is not adding information to the market; it is losing
   some.
2. **The cover probabilities carry no usable information.** A Brier of 0.2580
   is worse than a constant 50% guess (0.250). The distribution is labeled
   `research_distribution_only` / `production_eligible: false` in the code,
   and this measurement is why that label is correct.
3. **Push mass is understated by about 40%** — 20.1 predicted against 33
   realized. Pushes are a real fraction of spread outcomes and the
   distribution under-weights them.

### The table

Uncertainty is a paired weekly-cluster bootstrap of (variant − full ensemble)
on the common universe, 4,000 deterministic trials. Paired means the same
resampled weeks are scored under both configurations, so week-to-week noise
cancels rather than being counted twice.

| Family | Actual consumer | Margin MAE change | Cover Brier change | Economic (ROI, bets) | Cost | Decision |
|---|---|---|---|---|---|---|
| **Efficiency** | 17 models, production | **−0.079** CI [−0.132, −0.027] | −0.0010 CI [−0.003, 0] | +7.2% vs −5.1%, 112 vs 204 bets, CI [−0.024, +0.272] | 55% of the ensemble | **simplify** |
| **Rating systems** | 6 models, production | **−0.054** CI [−0.094, −0.014] | −0.0020 CI [−0.003, 0] | −3.8% vs −5.1%, 169 vs 204 bets, CI [−0.090, +0.119] | 19% of the ensemble | **simplify** |
| **Market** | 2 models, production | **+0.153** CI [+0.120, +0.187] | +0.0030 CI [+0.002, +0.004] | −2.4% vs −5.1%, 292 vs 204 bets, CI [−0.050, +0.103] | 6% of the ensemble | **keep** |
| **Context** | 4 models, production | +0.000 CI [−0.008, +0.008] | +0.0010 CI [0, +0.001] | −4.4% vs −5.1%, 263 vs 204 bets, CI [−0.070, +0.083] | 13% of the ensemble | **keep** |
| **Roster availability** | 2 models, production | +0.003 CI [−0.007, +0.011] | +0.0000 CI [0, +0.001] | −6.1% vs −5.1%, 202 vs 204 bets, CI [−0.046, +0.027] | 6% of the ensemble | **keep** |

A negative margin change means the ensemble forecast the same games **better
without** that family.

### What the table says

**The two market models are the only thing carrying real signal.** Removing
them is the single conclusive degradation in the whole comparison, and it is
by far the largest effect: +0.153 of margin error from 2 of 31 models.
Everything else in the ensemble is either neutral or a mild drag.

**Twenty-three of the thirty-one models make the margin forecast worse.**
Efficiency (17 models) and rating systems (6) both show conclusive
improvements when removed. This is a direct measurement of something this
project has long suspected from the outside: the ensemble's size is not
buying accuracy.

**Context and roster availability are measurably inert.** Four context models
and two availability models move the margin forecast by less than 0.01 points
of MAE, with intervals straddling zero. They are not harmful; they are not
doing anything either. Both are kept, because inconclusive evidence is not
grounds for removal, but neither should be counted as a working input.

**The ROI column is the one to distrust, and it demonstrates why section 8.6
demanded a common universe.** `without:Efficiency` shows +7.2% against the
baseline's −5.1% — a swing that looks decisive and is not. Its bet count
falls from 204 to 112, and its paired interval [−0.024, +0.272] includes
zero. The apparent profit is the variant declining to bet, not forecasting
better. Read on its own, that number would have justified a change the
forecast evidence does not support.

### Two honest caveats on the "simplify" verdicts

**The effects are conclusive but small.** 0.079 and 0.054 points of margin
error against a ~10-point error. The decision rule requires a paired interval
excluding zero and does not impose a minimum effect size, so it returns
"simplify" for both. The rule was written before these results were
generated, and it is reported as written — revising it after seeing the
output is exactly the outcome-guided selection section 8.6 says must be
counted rather than hidden as a diagnostic.

**Nothing here promotes anything.** Section 8.6's own words: "this opened
period cannot promote a tuned family set." A removal would need confirmation
on genuinely later observations before any live configuration changes. The
report is a diagnostic and the module changes no production path.

Raw output: `docs/evidence/2026-09-10/family-contribution-2021-2025.json`
(three-answer comparison) and `feature-ablation-2021-2025.json` (the older
ROI-only ablation, preserved for comparison, and the reason the common
universe was necessary).

## 1c. Work completed after the earlier draft of section 2

| Item | What it addresses | Commit |
|---|---|---|
| E5 | Shopped-line and teaser prices were computed from a half-win proxy; now from real win/loss/push transition probabilities, with the reference line passed explicitly because the relation is not symmetric | `826e078` |
| E6 | The decision board was a mutable latest-view that overwrote what the model decided before a line moved; now an append-only tape keyed to include policy version, with a board hash that excludes wall-clock | `6d8245f` |
| E7 | The delay preview reported fills nobody observed; horizons past captured coverage are now distinguished by basis rather than presented as modeled carry-forward | `6fc652a` |
| E8 | Settlement finality was asserted, not evidenced; terminal outcomes, finality bases and a settlement-correction event that deliberately does not advance the materialized status | `df78c25` |
| E9 | Accepted tickets were disconnected from CLV grading; a read-only projection makes idempotency structural rather than enforced by convention | `6526aac` |
| E10 | The collector reported failures and no-ops as healthy | `4df9c8a` |
| E2 | Picks were gated on fair-price edge alone; now also on expected return at the offered price. The historical replay policy sets `minExpectedReturn: null` explicitly and normalization uses an `in` check rather than `??`, so the production default cannot resurrect it and the blind audit stays unchanged — pinned by its own invariant test | `799b2d7` |
| 8.6 family fix | The ablation silently dropped a whole family from every configuration | `da59af2` |
| 6.3 capacity | Sequential T-60 capacity: cutoff batches processed chronologically, ranked only within a batch, released slots returning only to later batches | `3c8b25c` |
| 6.3 packet | The T-60 evidence packet: three clocks kept apart, missing recorded as an observation, unevidenced availability quarantined | `27c50e2` |
| WP15 | All 38 remaining documents relocated to their dispositioned destinations; one active plan and an index remain | `fd92048` |
| 8.6 table | Three answers per family on one common universe, paired uncertainty | `27c50e2` |

## 2. Deliberately deferred, and why

An earlier draft of this section listed work packages 1 and 3 as deferred.
They were subsequently completed in the same session and are recorded in
section 1c above; this section now lists only what genuinely remains.

- **Work package 4 remainder and work package 6** (freeze one spread
  experiment, begin prospective collection). These are blocked on time, not
  on engineering. A prospective T-60 evaluation requires actual calendar
  weeks of NFL games played after the freeze; there is no way to produce that
  by writing code. The machinery they need is now built (see section 1c: the
  cutoff protocol, the sequential capacity rule, the evidence packet, the
  decision tape, the CLV projection), so the remaining step is to declare the
  freeze and wait for real weeks.
- **Physical folder reorganization** (~261 server files into the new ownership
  tree). The plan's own words: "Do not move hundreds of model files in one
  unreviewable commit," and "Finish the full folder disposition without
  letting cosmetic moves delay the first complete workflow." It changes zero
  model behavior and zero audit numbers, and it is the highest-regression-risk
  mechanical work in the brief. The manifest
  (`reference/architecture/folder-map.csv`) and target tree
  (`FOLDER-REORGANIZATION.md`) remain the governing reference. Documentation
  reorganization — the part that could be done safely and reviewably — was
  completed (`fd92048`).
- **PFF external player grades.** `nfl_external_player_grades` is empty
  because no licensed source is configured, not because of a sync bug.
  Nothing was written to manufacture data that does not exist.

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

**Recommendation:** advance on infrastructure and integrity — every fix in
sections 1 and 1c is real, tested, and safe to keep. Do not advance on money
authority. Nothing here establishes a spread edge, and the calibration gate
remains correctly blocked.

Section 1b sharpened that conclusion considerably, and it is the most
important thing this session produced. On 1,424 common games the ensemble
forecasts margin **worse than the closing line** (10.095 against 9.762), its
cover probabilities score **worse than a constant coin flip** (Brier 0.2580
against 0.250), and it **understates push mass by about 40%**. Those are not
inferences from betting results, which are noisy and selection-dependent;
they are direct measurements of the forecast itself, on a fixed universe,
against the number it has to beat.

The family table says where the signal actually is: the **two market models**
are the only conclusive contributor in a 31-model ensemble, and removing
either the 17 efficiency models or the 6 rating-system models measurably
**improves** margin accuracy. The ensemble's size is not buying accuracy.

The honest next steps, in the plan's own order:

1. **Work package 6** — declare the frozen spread experiment and start
   collecting real prospective weeks. Everything it depends on is now built.
   No amount of further engineering substitutes for played games.
2. **Confirm the two "simplify" candidates on later observations** before
   changing any live configuration, as section 8.6 requires. The effects are
   conclusive but small, and were measured on the same opened development
   period that produced them.
3. **Treat the cover distribution as unusable until it is recalibrated.** It
   is already labeled `production_eligible: false`; section 1b is the
   measurement that justifies the label, and any future economic claim built
   on those probabilities is built on a forecast that scores worse than 0.5.

What has NOT changed: the standing conclusion that there is no proven spread
edge against the closing line. Every measurement added tonight points the
same direction as the audit history, more precisely and from a different
angle.
