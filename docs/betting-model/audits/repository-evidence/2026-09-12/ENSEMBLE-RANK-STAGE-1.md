# Ensemble reduction, stage 1: measure the effective rank

Giant Plan section 7.2 item 2, first stage. **Measurement only — no weight, blend,
gate or forecast was changed.**

Date: 2026-09-12
Branch: `model-2026-09-12-bigbuilds` (from `build-2026-09-12-v2-integration`)

---

## The claim under test

Both audits independently concluded that `server/services/nfl-ensemble.js` carries
~31 components of which only ~2-3 carry genuinely independent information, that the
rest are correlated restatements, and that the blend is largely a shrinkage toward
the market's own price (roughly `forecast ≈ 0.68 + 0.632·market`). Section 8.6's
family ablation found only 2 of 31 conclusively contributing.

That is a statement about the rank of a matrix, and rank is measurable. This stage
builds the instrument that measures it.

## What was built

| File | Purpose |
| --- | --- |
| `server/services/nfl-ensemble.js` | `componentPredictionStream()` — the cutoff-safe walk-forward replay loop, **extracted from** `fitEnsemble` so the diagnostic and the production fit cannot drift. Also `ensembleReplayInputs()` and `componentIds()`. |
| `server/services/nfl-ensemble-rank.js` | The diagnostic: correlation matrix, Jacobi eigendecomposition, three effective-rank metrics, per-component loadings, VIF-based redundancy, a greedy independent basis, and the market-shrinkage regression. |
| `scripts/ensemble-rank-report.mjs` | CLI that produces and persists a report. |
| `test/nfl-ensemble-rank.test.js` | 16 tests, most of them known-answer validations of the linear algebra. |
| `test/helpers/seed-ensemble-fixture.js` | A deterministic league whose feature space has a **chosen** number of latent factors. |

### The refactor is provably behaviour-preserving

`fitEnsemble`'s replay loop moved into `componentPredictionStream`. To prove that
moved nothing else, `fitEnsemble`'s complete output (champion and candidate fits,
all 31 component records, every weight, RMSE, slope, t-statistic and gate flag) was
dumped on a fixed fixture **before** the refactor and again **after**:

```
diff fit-baseline.json fit-after.json   ->   identical
```

Plus the existing ensemble/replay/integrity suites: 140/140 pass.

## Why two spaces are measured, not one

- **`raw_margin`** — each component's projected home margin. These are near-guaranteed
  to be collinear: every component is mostly answering "is the home team better",
  and they agree because it is usually obvious. **A low rank here is expected and
  is not a finding.**
- **`market_residual`** — forecast minus the market's margin. The market already
  prices the obvious, so only the deviations can carry an edge. **This is the space
  the audits' question is about**, and it is the report's headline.

A subtlety worth recording: subtracting one common quantity (the market) from every
column removes a shared term but introduces another — the market's own error, which
every residual then carries with the same sign. So the residual space is not
automatically *less* collinear than the raw space, and the diagnostic does not
assume it is. On the fixture it is in fact *more* collinear (mean |r| 0.65 vs 0.41).

## Three rank metrics, deliberately

Quoting whichever is most flattering is how this kind of analysis goes wrong.

- **participation ratio** `(Σλ)²/Σλ²` — strictest; reads low when one direction
  dominates.
- **entropy rank** `exp(H)` of the normalised eigenvalues (Roy & Vetterli) — counts
  any direction carrying appreciable variance; reads higher with a long small tail.
- **PCs for 90/95/99 %** — assumption-free.

When they disagree, the disagreement is the finding: low participation ratio with a
high 95 % count means *one* dominant signal plus a crowd of small ones, which is a
different problem from three equal signals.

Redundancy per component uses the variance-inflation identity
`R²_j = 1 − 1/(R⁻¹)_jj` — regression on **all** other components, not a pairwise
max-|r| screen. A test pins the case that separates them: a component that is the
exact sum of three others is fully redundant while correlating only ~0.58 with each,
which a max-|r| screen clears.

---

## Validation

Known-answer tests (all passing):

| Case | Expected | Measured |
| --- | --- | --- |
| `[[2,1],[1,2]]` | λ = 3, 1 | 3, 1 (1e-9) |
| 8 independent noise columns | rank ≈ 8 | participation 7.5+, entropy 7.5+ |
| 24 columns from **3** latent factors | rank ≈ 3 | participation 2.2–4.2, 3 PCs for 90 % |
| 24 columns from **8** latent factors | rank ≈ 8 | participation > 5, ≥7 PCs for 90 % |
| exact affine copy of a column | unique variance ≈ 0 | R² > 0.999, twin named |
| sum of three independent columns | fully redundant, low pairwise r | R² > 0.99, max \|r\| < 0.75 |

The 3-factor and 8-factor pair matters: the first test alone would also pass code
that always answers "3".

---

## What was measured, and what was NOT

### NOT measured: the real ensemble

**The effective rank of the production ensemble on real NFL history was not
measured, and no number in this document should be read as that measurement.**

The only populated database in this repository is `server/data.sqlite`, which this
session was instructed never to open (a live process is capturing real games into
it), and every run was required to point `GRIDIRON_DB_PATH` at a fresh `/tmp` path.
There is no other real-history source in the tree — `docs/evidence/historical/` holds
prose and summary JSON, not game-level rows. The repository's own
`test/helpers/requires-real-history.js` states the applicable rule directly: a
synthetic fixture could be tuned to satisfy any assertion about real data, which
would prove only that the fixture was tuned.

So the honest answer to "does the measured effective rank match the ~3 the audits
claimed" is: **not yet known.** The instrument to find out now exists and is
validated. One command answers it:

```bash
cp server/data.sqlite /tmp/rank-read-only.sqlite     # a human, against a quiesced DB
GRIDIRON_DB_PATH=/tmp/rank-read-only.sqlite SCHEDULER_DISABLED=1 \
  NODE_OPTIONS='--import ./test/offline-guard.mjs' \
  node scripts/ensemble-rank-report.mjs --before-season 2025 --label real-2025
```

### Measured: the pipeline, end to end, on a synthetic league

The fixture's team-week features are each a fixed linear combination of a **chosen**
number of hidden factors plus independent noise, so its correlation structure is a
property of the generator, not of football. Full report:
`docs/evidence/2026-09-12/ensemble-rank-synthetic-fixture.json`.

3-factor fixture, cutoff 2024 wk 1, 27 margin-producing components over 952 complete
games:

| | raw_margin | market_residual |
| --- | --- | --- |
| participation ratio | 3.68 | **1.93** |
| entropy rank | 4.98 | **3.18** |
| PCs for 90 / 95 / 99 % | 5 / 6 / 10 | 5 / 6 / 9 |
| top eigenvalue share | 42.5 % | 70.9 % |
| mean \|r\| off-diagonal | 0.41 | 0.65 |

Raising the fixture to 8 latent factors moves `raw_margin` participation from
3.68 → **6.08** and PCs-for-90 % from 5 → 8. The pipeline therefore tracks the true
dimensionality end to end, through the real component models, not just in unit tests.

All 31 catalog components are accounted for. The 4 absent from the margin matrix are
named with reasons rather than silently dropped: `pace_total` and `weather_total`
forecast **game totals only** (out of scope for a margin-space analysis, not a
failure), and `availability` / `roster_strength` abstained on every game because the
fixture seeds no injury reports or depth charts.

Fixture structure worth noting for the real run: PC2 is cleanly the **Rating systems**
family (massey, colley, pythagorean, melo, dynamic_state) while PC1 absorbs the
efficiency block, which is the shape the audits predicted.

### An incidental finding that does not depend on the fixture

`market_shrinkage.market_residual` came back as exactly `blend = 0 + 1·market`,
R² = 1, mean departure 0 — because **zero components cleared the residual gate**
(`residual_gate.passed` is empty). When that happens the production research
forecast *is* the market, by design, not by shrinkage. The report now surfaces
`residual_gate` alongside the regression so a slope of 1 is not misread as a
shrinkage finding when it is a gate finding. Whoever runs this on real data should
read those two fields together.

---

## Caveats this report carries in its own output

1. Effective rank is measured on component **outputs**, not on their skill. A
   perfectly independent component that is also perfectly wrong raises the rank
   without helping anything. Pair this with `fitEnsemble`'s residual-skill statistics
   before acting.
2. Redundancy is not uselessness. A component with `r2_vs_all_others ≈ 1` adds
   nothing the rest do not already say, but removing it *and its correlates together*
   removes real signal.
3. Listwise deletion is used so the correlation matrix is positive semi-definite
   (pairwise-complete assembly can yield negative eigenvalues and meaningless rank
   numbers). The cost is reported as `rows_complete` vs `rows_total`, not hidden.

## Next stage

`greedy_independent_basis` in the report is the actionable output: components in the
order of how little the previously-chosen ones explain them. On the real run, the
step at which `r2_explained_by_prior` saturates is the candidate cut point — but
only after cross-checking each survivor's residual-skill statistics, per caveat 1.
