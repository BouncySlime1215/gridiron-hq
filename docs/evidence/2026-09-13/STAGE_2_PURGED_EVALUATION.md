# Stage 2 — the purged evaluation

Giant Plan Step 2a-2d. Full numbers: `purged-evaluation-report.json` in this
folder (regenerate with `node scripts/run-purged-evaluation.mjs`, which
backfills a scratch copy of the registry and prints the same report — it
never touches `server/data.sqlite` except to read it).

## 1. The shared purged walk-forward protocol

`server/services/purged-walk-forward.js`. One reusable function
(`purgedWalkForwardFolds`/`purgedWalkForwardEvaluate`), not a one-off script:
train on seasons `1..n`, test on season `n+1`, roll forward, and PURGE any
training row whose own feature-lookback or label-horizon window overlaps the
test season's window (plus an optional embargo) — so a multi-week feature
(a rolling 3-game average, a season-to-date rate) cannot leak the test
period's information backward into a model about to be graded on it. Tested
in `test/purged-walk-forward.test.js` (11 tests): fold roll-forward, purge-
by-lookback, purge-by-horizon, embargo widening, and that every prior-season
row lands in exactly one of `trainRows`/`purgedRows`, never both.

## 2. The backfilled trial registry

`server/services/research-trials.js` is the first real caller of migration
038's general-purpose `research_trials` ledger (Giant Plan §8.3) — narrower
than `audit_registry` (§8.9's model-materiality ledger) or
`nfl_candidate_findings` (segment-bias ledger), and exactly the shape those
two didn't fit. Migration `046_research_trials_detail.js` adds `detail_json`
/ `source_ref` columns it needed to carry a trial's real identity and where
it came from.

`scripts/backfill-historical-trial-registry.mjs` populates it with **55 real
trials** across three real sources — git history, `server/data.sqlite`
(read-only), and one already-computed evidence artifact:

| kind | count | source |
|---|---:|---|
| `component_model_1of21` | 21 | git commit `73f930f` (2026-08-27): the real spread-ensemble `MODELS` list at the commit that reports "21 models against 15,096 closing lines, 0 clear the gate" |
| `audit_registry_hypothesis` | 15 | `server/data.sqlite:audit_registry`, read-only |
| `candidate_robustness_audit` | 6 | `server/data.sqlite:nfl_candidate_robustness_audits`, read-only |
| `family_ablation` | 5 | `docs/evidence/2026-09-10/family-contribution-2021-2025.json`, backed by `nfl_feature_ablation_audits#1` |
| `candidate_input_audit` | 5 | `server/data.sqlite:nfl_candidate_input_audits`, read-only |
| `residual_model_variant` | 1 | `server/data.sqlite:nfl_residual_audits#1`, read-only |
| `segment_definition_finding` | 1 | `server/data.sqlite:nfl_candidate_findings#1`, read-only |
| `segment_search_space` | 1 | `server/services/nfl-replay.js`'s real `segmentsFor()`/`analyzeErrors()` (the search space + `minBets` rule, not individual attempts — see gap below) |

**The stated gap, exactly as the task requires:** the script that produced
the "0 of 21" aggregate finding was never committed (or was deleted in one
of this project's own documented handoff-doc consolidations), so the
**individual** per-component observed statistic behind that headline does
not survive anywhere — not in the repo, not in git history, not in
`server/data.sqlite`. Each of the 21 components is registered with a real
**family-level** ablation-delta proxy instead (correlated components inside
the same family is exactly the structure the Geyer correction in step 3
exists to discount), flagged `individual_value_reconstructable: false` in
its `detail_json`, and excluded from the Sharpe cross-section in step 4 (no
real bet ledger exists for it). Likewise, `nfl-replay.js`'s `analyzeErrors()`
only ever returns segments that clear `minBets` (25, or 30 from the
season-end orchestrator) — segments that fail it are silently discarded and
never logged, in every historical run, by design. The search space and the
real threshold are registered; the specific dropped attempts are not
reconstructable and are not fabricated.

3 of the 55 registered trials are correctly left **unscored**: the one live
candidate finding still waiting on holdout confirmations, the segment
search-space declaration itself (a space, not a single scored trial), and
one `void` audit_registry row that never ran. 52 carry a real scored
outcome.

## 3. Effective trial count (Geyer)

`server/services/trial-statistics.js#effectiveTrialCount`, tested in
`test/trial-statistics.test.js` against an i.i.d. sequence (τ≈1) and a known
AR(1) process (τ recovers the right order of magnitude vs. the closed-form
`(1+φ)/(1-φ)`).

Applied to the real 52-trial sequence (chronological by `scored_at`, each
trial's heterogeneous metric mapped to one comparable standardized effect —
`run-purged-evaluation.mjs#standardizedEffect`):

```
n_raw        = 52
tau          = 1.636   (Geyer initial monotone sequence estimator)
n_effective  = 31.78
```

**Raw 52 is not 31.78 independent-equivalent looks at the data** — real,
measurable serial correlation, exactly what the task predicted ("each
attempt was informed by the prior one"), though milder than a naive
worst-case guess: this project's real trial history mixes genuinely
different question types (materiality tests, ROI comparisons, MAE deltas),
which dilutes the correlation a purely sequential "one candidate refined
into the next" history would show.

## 4. Deflated Sharpe ratio

Scoped to the **13 real trials with an actual bet ledger** (bets/wins/losses/
units) — the 3 candidate-variant families' real overall records plus
`audit_registry` rows 1 and 14 (assuming this project's own standard −110
convention, since neither persists the exact per-bet price). Everything else
in the registry (CLV-rate tests, calibration error, margin-MAE ablations)
answers a real question but has no wagering P&L attached, so a Sharpe ratio
does not apply to it.

```
best observed trial   = audit_registry #14, "football-first beats the
                         closing spread" (33-24, real, WORK_LOG)
sharpe (best)          = 0.1117    (n=57)
sharpe std across the
  13 real trials        = 0.0863
SR0 (expected best-of-N
  Sharpe under the null,
  N = 31.78 effective)  = 0.1809
DSR                     = 0.305
```

**The deflated benchmark (0.181) is already higher than the best raw Sharpe
ever observed (0.112).** Even before asking about statistical significance,
the best result this project's real history ever produced is smaller than
what ~32 effectively-independent chances at a null (no-skill) strategy would
be expected to produce by luck alone. DSR = 0.305 means under 1-in-3 odds
this observed best result reflects real skill rather than the expected
maximum of that many looks — consistent with, and now quantified underneath,
this project's standing "zero edge against the closing line" finding
(`docs/evidence/historical/path-to-profit-measurements.md`).

## 5. Probability of backtest overfitting (CSCV)

`server/services/trial-statistics.js#probabilityOfBacktestOverfitting`
implements Bailey, Borwein, López de Prado & Zhu (2015)'s combinatorially
symmetric cross-validation directly, tested against synthetic cases with
known ground truth (a strategy that dominates every period scores PBO near
0; pure-noise strategies land near chance).

Applied to the one real, same-window, multi-strategy per-period matrix this
project's surviving evidence provides — 4 real seasons (2022-2025) × 4 real
strategies (the champion-only baseline and the three `unified-all-inputs`
candidates, all from `nfl_candidate_input_audits`):

```
PBO = 0.167   (1 of 6 in-sample/out-of-sample splits showed overfitting)
```

**Read this as a demonstration on genuine data, not a high-power estimate.**
The low number is largely mechanical: three of the four strategies
(v1/v2-roster/v3-isolated-roster) are near-duplicates of each other in this
window and all dominate the champion-only baseline in most periods, so the
in-sample winner is almost always also above the out-of-sample median
regardless of any genuine skill. A real PBO estimate needs more, genuinely
distinct strategies and more periods than survive in this project's real
evidence — this project's own repeated documentation consolidations are
exactly why they don't.

## Commit

`server/migrations/046_research_trials_detail.js`,
`server/services/{purged-walk-forward,research-trials,trial-statistics}.js`,
`scripts/{backfill-historical-trial-registry,run-purged-evaluation}.mjs`,
`test/{purged-walk-forward,research-trials,trial-statistics}.test.js`, this
folder. 33 new tests, all passing; `npm run lint` and `npx tsc --noEmit`
clean. No write ever touched `server/data.sqlite` — every read against it
used `node:sqlite`'s `{ readOnly: true }` directly; every write went to a
scratch database under a temp directory (enforced defensively at the top of
the backfill script, which refuses to run against any path outside one).
