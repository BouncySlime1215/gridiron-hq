# G18-research-python — line-by-line audit of the Python research lab

Reader: G18-research-python. Date of audit: 2026-09-11 (NFL Week 1 weekend).
Repo: `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` (read-only).
Scope: `research/*.py`, `research/betting/**/*.py`, `research/README.md`,
`research/requirements.txt`, `server/data/*/latest.json`,
`server/data/*/*/preregistered.json`, `server/data/*/*/manifest.json`,
`server/data/analyst-notes-2026.json`, `server/data/draft-audit-signals-2026.json`.

36 files, 29,981 lines, every line read. No Python was run. `data.sqlite` was
not opened. No process was touched.

---

## 0. Executive summary

The Python lab is, on the whole, unusually honest research code. It preregisters,
it publishes negative results, it names its own proxies, and its module docstrings
argue rather than assert. The headline findings below are not "this lab is
dishonest"; they are "several of the guarantees the lab advertises are not
currently realized on disk, and three specific numbers it publishes are wrong or
misleading."

Five things a reader needs to know:

1. **Every frozen report on disk is `-v1`. The code on disk is `-v2`.** All four
   labs were edited after their last run. The consequence is that
   `model_discipline` (539 lines) and `drift.py` (704 lines) — 1,243 lines of
   carefully-built, well-tested guard machinery — have **never produced a single
   verdict in a frozen artifact**. Both are exercised only by unit tests. The UI
   panels that render them are permanently empty. (D-01)

2. **The leakage guard is real but almost never binding, and it does not cover
   every experiment.** It runs on real data, it is proven against a synthetic
   leak, and it found nothing: max single-feature out-of-fold AUC 0.60 against a
   0.985 threshold, max R² 0.0091 against a 0.98 threshold. But it runs on the
   cover target only (6 scans) plus one pooled spreads-movement scan. The totals
   movement target, the quantile target, the ranker and the market-anchored logit
   are never scanned, contrary to `research/README.md:117-118`. (D-05)

3. **TPOT is selected by an unfair comparison, and it changed the published
   result.** TPOT searches hundreds of pipelines against the exact inner folds its
   score is then computed on, and that score is compared with `min()` against
   fixed candidates that never got a search. TPOT wins the inner comparison in
   8 of 12 tree-lab cells and then loses out of sample in 7 of those 8. In
   market-lab it flipped the published pooled totals ROI from −28.6% (two earlier
   same-data runs) to +2.0%. (D-02, D-03)

4. **book_lag_lab's "8 of 8 cells beat their baseline" is not supportable.** Two
   independent defects: the verdict counts a cell as passing when only one of its
   two models beat baseline (the magnitude model lost in all 6 cells), and the
   next-move label is built from forward-filled quotes, which fabricates
   "no move" whenever a book simply was not quoted — while the features encode
   exactly that staleness. (D-04, D-06)

5. **The only positive, holdout-confirmed result in the whole suite is a fantasy
   one**, and it is not Python: `role-scenario-lab` (Package D) improves touches
   MAE 2.473 → 2.429 on the 2025 holdout, CI90 [−0.074, −0.017]. It is also the
   result built on `player_week_usage`, the table `draft-audit-signals-2026.json`
   documents as having a corrupted gsis crosswalk for at least six named
   high-usage players. (D-07)

Nothing in this file set has staking authority, feeds a live prediction, or writes
to the database. Two files in scope *do* reach a user-facing decision path:
`analyst-notes-2026.json` and `draft-audit-signals-2026.json`, both consumed by
`server/services/draft-assist.js`.

---

## 1. Wiring map

### 1.1 Python → Python

```
market_lab.py ──┬── model_discipline.py   (check_fold, record, summarize)
                └── drift.py              (scan_lab_fold)

tree_lab.py ────┬── market_lab.py         (stamp, digest, atomic_json,
                │                          american_profit, settlement,
                │                          time_folds, FrozenTimeCV,
                │                          cluster_interval)
                ├── leakage.py            (detect_feature_leakage)
                ├── model_discipline.py
                └── drift.py

expert_selector_lab.py ─┬── drift.py      (detect_distribution_drift)
                        └── model_discipline.py

book_lag_lab.py ────────┬── model_discipline.py
                        └── drift.py      (DRIFT_VERSION constant ONLY)

research/betting/nfl/dataset.py ── imported by NOTHING except its own test
```

Verified at `research/tree_lab.py:67-70`, `research/market_lab.py:31-32`,
`research/expert_selector_lab.py:97,99`, `research/book_lag_lab.py:130-131`.

All imports are bare module names (`from market_lab import ...`), which works
only because Python puts the script's own directory on `sys.path[0]`. Running any
lab as `python -m` or from a different entry point breaks every import. That is
also why the planned move to `research/betting/nfl/` is marked
`research_path_sensitive` in `docs/reference/architecture/folder-map.csv:217-226`.

### 1.2 Python → data

```
data.sqlite ──ro──> market_lab.build_dataset          (game_lines, nfl_team_week_features,
                                                       nfl_odds_archive)
data.sqlite ──ro──> tree_lab.build_dataset            (same + roof, per-team rest_days)
data.sqlite ──ro──> expert_selector_lab.load_council  (nfl_weekly_expert_examples)

server/data/evidence-datasets/<hash>/rows.jsonl ──> book_lag_lab.load_evidence_dataset
                                                    (NEVER opens data.sqlite)

tree_lab.emit_oof ──> <run>/<market>-<season>-<target>-oof.json
                  ──> expert_selector_lab.load_tree_oof   (move target ONLY — see D-08)
```

### 1.3 Lab output → Node app

```
server/data/market-lab/latest.json        ┐
server/data/tree-lab/latest.json          │
server/data/book-lag-lab/latest.json      ├─> server/services/nfl-research-lab.js
server/data/expert-selector-lab/latest.json│      (readSchema, accepts v1 AND v2)
server/data/news-event-impact/latest.json ┘           │
server/services/role-scenario-lab.js ─────────────────┤
                                                      v
                                        server/routes/nfl-market.js:33
                                        (researchLabStatus — a display endpoint)
                                                      v
                                        client/src/pages/betting/ResearchLab.tsx
```

**Nothing else consumes any lab output.** `nfl-research-lab.js` is imported by
exactly one file outside itself (`server/routes/nfl-market.js:33`) and only for
`researchLabStatus` / `researchMasterPlan`. No prop model, no spread model, no
staking path, no pick endpoint reads any of it. The lab suite is a read-only
research display. The `authority: 'research_only'` and
`production_changed: false` fields present in every report are accurate.

The reader is honest about the v1/v2 gap. `nfl-research-lab.js:17-24` explains
why it accepts both, and `:160-165` notes that `null` on `model_discipline` /
`drift_scans` "means the run predates that check, which the UI renders
differently from the check having run and found nothing." So the wiring is
correct; the blocks are simply always null against today's data.

### 1.4 The two fantasy JSONs — the only artifacts that reach a decision

```
server/data/analyst-notes-2026.json ──> draft-assist.js:961 analystNotes()
                                        ├─> draft-assist.js:943  (player dossiers)
                                        └─> routes/drafts.js:1056 (LLM prompt,
                                            top-5 _strategy entries)

server/data/draft-audit-signals-2026.json ──> draft-assist.js:982 auditSignals()
                                          └─> draft-assist.js:991 realizationFor()
                                              (position × overall-rank tier
                                               multiplier, shrunk by n/30,
                                               clamped to [0.6, 1.3])
```

These two are the only files in my scope with a live consumer.

---

## 2. Per-file sections

### 2.1 `research/README.md` — 215 lines

**Purpose.** Operator documentation for all four labs plus the leakage scanner.

**Accuracy.** Mostly excellent and unusually candid (it publishes the Package F
negative result in the README itself, lines 203-212, with the exact MAE numbers).
Three overstatements:

- `README.md:117-118` — "It runs against the real dataset on every experiment
  (see `leakage_scans` in the report)". It does not. See D-05.
- `README.md:39-40` (this text lives in `book_lag_lab.py`, echoed by README's
  Package B section) — the tape "polls at a MEDIAN gap of roughly one hour". The
  measured value in the frozen report is **360.221 seconds** (6 minutes):
  `server/data/book-lag-lab/latest.json` → `panel_summary.native_step_seconds`.
- `README.md:8` documents `--tpot-minutes 0.5`; the published run used 0.1
  (`server/data/market-lab/latest.json` → `protocol.tpot_minutes_per_outer_fold`).

**imported_by.** Referenced by `docs/evidence/contracts/research-packages-2026-09-08.md:56`
and `docs/CLAUDE-NEXT-STEPS.md`. No code importer (it is a README).

**Verdict.** Active, high quality, three stale claims.

---

### 2.2 `research/requirements.txt` — 18 lines

**Purpose.** Pins for the isolated research venv: `tpot==1.1.0`,
`scikit-learn==1.7.2`, `setuptools<81`, `lightgbm==4.7.0`, `xgboost==3.4.1`,
`catboost==1.2.10`, `scipy==1.18.1`.

Every pin is exact, and lines 3-4 and 13-18 explain *why* each pin exists
(`stopit` still imports `pkg_resources`; scipy is a direct import of Package F
even though sklearn pulls it transitively). This is good practice.

The `setuptools<81` pin is vindicated by the frozen evidence: the second
market-lab run failed every TPOT fold with
`ModuleNotFoundError: No module named 'pkg_resources'`
(`server/data/market-lab/20260908T152747Z-7f69ded8/report.json` → `errors`).

Missing: `joblib` is imported directly by `market_lab.py:29` and `tree_lab.py:65`
and is not listed (it arrives transitively via scikit-learn). Same argument the
file itself makes for scipy at lines 13-18. P3.

**imported_by.** None (a manifest).

**Verdict.** Active, good.

---

### 2.3 `research/leakage.py` — 97 lines

**Purpose.** The second-kind leak detector: a feature computed from
post-decision-time information. Fits one single-feature model per column per
chronological fold and flags any column whose out-of-fold skill is implausibly
close to perfect.

**Key functions.**
- `_fold_r2(values, y, folds)` :34 — mean per-fold R² of a univariate
  `LinearRegression`.
- `_fold_auc(values, y, folds)` :49 — mean per-fold AUC of a univariate
  `LogisticRegression(max_iter=200)`.
- `detect_feature_leakage(X, y, folds, feature_names, *, task, r2_threshold=0.98,
  auc_threshold=0.985, min_folds=2)` :64 — returns
  `{version, task, folds_used, skipped, thresholds, features[], flagged[]}`.

**Data read/written.** Pure function. Reads arrays, returns a dict. No I/O.

**Is the guard real?** Yes, with three qualifications.

*Real:* It executes against the real dataset (7 scans present in
`server/data/tree-lab/latest.json` → `leakage_scans`), it reuses the experiment's
own chronological folds (the docstring at :70-73 argues why that matters), it
never silently drops a flagged column (:74 "the caller decides"), and
`research/test_tree_lab.py:42-81` proves it catches an injected
`leaky = y + N(0, 1e-6)` in both regression and classification while leaving an
honest `0.15*y + noise` feature and a pure-noise control alone.

*Narrow:* The thresholds are 0.98 R² / 0.985 AUC. The observed maxima on real
data are 0.0091 R² and 0.6025 AUC. The scanner can only catch a feature that is
essentially the label wearing a different name. Its own docstring says exactly
this (:19-24: "This is a heuristic, not a proof… A feature could leak weakly…
without tripping a single-feature threshold"), and
`docs/evidence/2026-09-09/AUDIT-EVIDENCE.md:340` says the same. Believe the
docstring, not the README.

*Incomplete coverage:* See D-05.

**Defect — D-11 (P3).** `_fold_r2:39` and `_fold_auc:54` validate
`np.isfinite(xt).all()` on the **training** slice only, never on `xv`. A column
with a non-finite value in a validation slice produces `NaN` predictions →
`r2_score` returns `NaN` → `np.mean` returns `NaN` → `float(nan) >= 0.98` is
`False`. A genuinely leaking column with one NaN in a validation fold is silently
never flagged, and the report records `score: NaN`, which
`market_lab.atomic_json`'s `allow_nan=False` would then reject at write time —
so the run would crash on save rather than mis-report. Worth fixing for the
silent-skip half.

```python
 39         if not np.isfinite(xt).all() or np.unique(xt).size < 2:
 40             continue
```

**imported_by.** `research/tree_lab.py:68`, `research/test_tree_lab.py:23`. No
Node importer.

**Verdict.** Active. Honest and well-tested, but narrower than the README claims
and not run on every target.

---

### 2.4 `research/market_lab.py` — 329 lines

**Purpose.** The pilot (Package C baseline): opening-to-closing spread/total
movement regression, four candidate families plus bounded TPOT, three outer
seasons, expanding whole-week inner folds with a 7-day settled-label embargo.

**Key functions.**
- `build_dataset(db_path)` :71 — opens SQLite `?mode=ro` + `BEGIN` for a
  consistent snapshot (:72-74), builds per-team result history with a 3-day
  publication proxy (:84-86), joins `nfl_odds_archive` pinnacle open/close pairs,
  and applies six drop rules recorded in `dropped`.
- `time_folds(rows, folds=3)` :149 — expanding whole-week chronological folds with
  an independent label purge at :158-160.
- `evaluate(rows, pred)` :179 — MAE, CLV, paper ROI at archived prices,
  week-clustered bootstrap intervals, drawdown.
- `cluster_interval(rows, values)` :169 — ratio-of-sums bootstrap over
  (season, week) blocks, 1500 draws, 2.5/97.5 percentiles. Returns `None` below 8
  weeks.
- `settlement(market, positive, line, margin, total, price)` :64 — correct for
  both markets and pushes; verified by `test_market_lab.py:6-12`.

**Chronology.** The guard block (:112-122) is careful: both opening quotes must be
within 60 s of each other (:113), the close must be strictly after the decision and
strictly before kickoff (:113,116), the two sides must be the same contract
(:121), and both prices must be real American prices (:118). The decision instant
is `max(ot, nt)` (:115) — the later of the two opening stamps, which is the
conservative choice. I could not find a way for a post-decision value to enter a
feature.

**What it found.** `server/data/market-lab/latest.json`:

| market | selected per season | pooled MAE | no-move MAE | gain CI | bets | ROI | ROI CI |
|---|---|---|---|---|---|---|---|
| spreads | no_move ×3 | 1.3235 | 1.3235 | [0.0, 0.0] | 0 | — | — |
| totals | tpot, tpot, no_move | 1.4472 | 1.4117 | **[−0.0599, −0.0138]** | 104 | +2.05% | [−0.176, +0.220] |

Spreads: the baseline won every fold, zero paper bets, exactly zero edge. Totals:
the selected model is **significantly worse than doing nothing** (the MAE-gain
interval lies entirely below zero) and its +2.05% ROI interval straddles zero.
This is fully consistent with the settled "no prediction edge vs the close"
finding. Nothing here should be re-litigated.

**Defect — D-02 (P2): TPOT's inner score is a selection-biased maximum.**

```python
269                     automl.fit(X,y)
270                     fitted=automl.fitted_pipeline_
271                     models['tpot']=fitted
272                     losses=[mean_absolute_error(y[va],clone(fitted).fit(X[tr],y[tr]).predict(X[va])) for tr,va in cv]
273                     scores['tpot']=float(np.mean(losses))
...
279             selected=min(scores,key=scores.get)  # frozen before any outer outcomes scored
```

`automl.fit` searches with `cv=FrozenTimeCV(cv)` — the same folds. `scores['tpot']`
is then the CV score of the pipeline that *won* a search over those folds, i.e.
the maximum of many draws. Every other candidate is a fixed configuration that
got one draw. `min(scores, ...)` then compares a maximum-of-many against
singletons. The comment "frozen before any outer outcomes scored" is true and
beside the point: the bias is inside the inner comparison, not against the outer
season.

The frozen data shows this is not theoretical. In totals 2023 and 2024 TPOT's
inner MAE beat `no_move` by a hair (1.4474 vs 1.4521; 1.4087 vs 1.4262), won
selection, and then lost out of sample (1.4164 vs 1.3968; 1.3356 vs 1.2580). Two
of six folds selected the wrong model for this exact reason.

**Defect — D-03 (P3): `latest.json` is "newest wins" with no superseded-run record.**

`server/data/market-lab/` holds **three completed runs of the same protocol on the
identical dataset** (`dataset_hash c0067d19…` in all three), 8 minutes apart, and
the published `latest.json` is the last:

| run dir | code_hash | TPOT status | totals selections | totals pooled ROI |
|---|---|---|---|---|
| `20260908T152001Z-7f69ded8` | 7f69ded8 | crashed (libomp) | no_move, extra_trees, no_move | **−28.6%** |
| `20260908T152747Z-7f69ded8` | 7f69ded8 | crashed (pkg_resources) | no_move, extra_trees, no_move | **−28.6%** |
| `20260908T152845Z-334b4b45` | 334b4b45 | ran | **tpot, tpot**, no_move | **+2.0%** ← published |

To be fair: runs 1 and 2 had TPOT fail *entirely* (errors quoted in
`report.json` → `errors`), so run 3 is an environment fix, not result shopping.
But `market_lab.run()` writes `latest.json` unconditionally at :233 and the report
carries no `supersedes` field, so a reader of `latest.json` cannot tell that two
prior complete runs of the same preregistered protocol exist on disk and showed a
pooled totals ROI of the opposite sign. Add a `supersedes: [run_id, …]` field.

**Preregistration.** Honoured. `preregistered.json` is written at :232, after
`build_dataset` but before the first fit, with `markets: []`, `status: "running"`,
and a `code_hash` and `dataset_hash` that match the final report exactly. Verified
for all three runs.

**Minor.** :318 records package versions only at the end, so a crashed run has no
environment record. :210 `run_dir.mkdir()` without `exist_ok` (collision needs two
runs in the same second with the same code — acceptable).

**imported_by.** `research/tree_lab.py:67`, `research/test_market_lab.py:3`,
`research/test_tree_lab.py:22`. No Node importer; `nfl-research-lab.js:93-94`
reads its *output*.

**Verdict.** Active. Chronology sound, result honest and negative, model selection
biased toward TPOT.

---

### 2.5 `research/model_discipline.py` — 539 lines

**Purpose.** A pre-fit observation-to-parameter check whose numerator is
target-type-specific, with a Kish design-effect discount for clustering.

**Key functions.**
- `_icc_one_way(values, clusters)` :207 — standard one-way ANOVA ICC(1).
- `cluster_design_effect(y, clusters)` :239 — `1 + (mbar−1)·ICC`, with explicit,
  readable handling of no-key (optimistic, says so), single-cluster (design effect
  = n), and non-estimable ICC.
- `effective_observations(y, *, target_type, …)` :279 — six numerators:
  rows (continuous), minority class (binary), follow events (hazard),
  `n·min(τ, 1−τ)` at the binding τ (quantile), rows with per-expert availability
  reported (simplex), top-graded items (ranking).
- `check_fold(...)` :406 — never raises; returns `pass` / `fail` /
  `not_applicable` with a prose `reason`.
- `enforce` :495, `record` :512, `summarize` :520.

**Assessment.** This is the best-argued module in the set. The 172-line docstring
cites Peduzzi et al. 1996 for events-per-variable, derives the quantile numerator
from the asymptotic variance `τ(1−τ)/f(q)²`, and explains at :132-158 why it
refuses PCA/Lasso compression (it would change the declared model between folds of
one preregistered experiment and break the per-column leakage scan). The
`graded_ranking` branch labels itself `basis_confidence: 'analogy'` (:381) —
self-flagging the weakest of the six.

`research/test_model_discipline.py` (299 lines) covers the documented example
(660 rows / 40 positives → 40 observations, :29-34), the hazard case (96 rows /
12 events, :69-75), the quantile binding (900 rows → 90 at τ=0.1, :77-84), the
simplex under-support case (:213-220), and every degenerate input.

**Defect — D-01 (P2): none of this has ever run. See section 3.**

**Defect — D-12 (P3): `graded_ranking` on an all-equal label reports full power.**

```python
378         top = float(np.sum(y >= (float(np.max(y)) - 1e-9))) if rows else 0.0
379         raw = top
```

If every grade is identical (e.g. every training opportunity graded 0 because the
week had no positive-profit opportunity), `max(y) == 0` and every row counts as
"top-grade", so `raw = rows` and the fold reports its full row count as effective
observations. The correct reading is that a fold with no grade separation has no
ranking information at all. Compare with the `continuous_regression` branch, which
explicitly handles the constant-label case at :316-318 and returns 0.0.

**Defect — D-13 (P3): `test_model_discipline.py:291-295` tests the wrong thing.**

```python
291     def test_every_python_research_lab_imports_it(self):
292         for lab in ('market_lab.py', 'tree_lab.py', 'book_lag_lab.py', 'expert_selector_lab.py'):
295                 self.assertTrue('model_discipline' in src, f'{lab} does not import model_discipline')
```

This asserts the *string* appears in the source. It passes today while zero
frozen reports contain a `model_discipline` block. The guarantee the test stands
for is that verdicts reach the report; nothing tests that.

**imported_by.** All four labs (`market_lab.py:31`, `tree_lab.py:69`,
`book_lag_lab.py:130`, `expert_selector_lab.py:99`) and
`research/test_model_discipline.py:20`. Rendered (when present) by
`nfl-research-lab.js:27` `disciplineOf` and
`client/src/pages/betting/ResearchLab.tsx:313` `DisciplinePanel`.

**Verdict.** Active in code, **inert on disk**. Excellent design, zero realized
output.

---

### 2.6 `research/drift.py` — 704 lines

**Purpose.** Distributional drift between a fold's training window and its scoring
season, calibrated against NFL season-boundary behaviour rather than a
credit-scoring constant.

**Key functions.**
- `classify_feature_role(name)` :185 — `availability` / `market` / `model`, with
  availability checked first so `opening_overround_available` is a pipeline
  statement, not a market one (:188-191).
- `population_stability_index(...)` :220 — training-quantile edges, half-count
  continuity correction, exact-proportion path for binary columns.
- `psi_noise_reference(n_train, n_score, bins)` :258 — the analytic null
  `(1/n_a + 1/n_b)·χ²_{bins−1}` (Yurdakul 2018). **This is the module's central
  contribution**: the docstring's table at :32-35 shows the conventional
  "PSI > 0.1 = investigate" line sits *below* the 95th percentile of pure sampling
  noise at this project's fold sizes.
- `normalized_wasserstein(...)` :278 — W1 in units of the training IQR.
- `season_boundary_reference(...)` :298 — pooled PSI over consecutive season pairs
  per role, 95th percentile, with a `weak` fallback when the window holds one
  season.
- `joint_drift_classifier(...)` :361 — the part that earns its place: an
  `ExtraTreesClassifier` domain classifier with a **group-level permutation null**
  (whole weeks reassigned, :457-469) and per-fold AUC averaging rather than pooled
  OOF AUC — with the reason given as a measured fact at :441-443 ("the first live
  run of this module produced AUCs of 0.38 and 0.41 … purely from that artefact").
- `_verdict_for(...)` :509 — `stable` / `within_league_variation` / `elevated` /
  `market_regime_shift` / `abnormal` / `feed_break_suspected` / `not_computable`.
- `detect_distribution_drift(...)` :561, `scan_lab_fold(...)` :670.

**Assessment.** Rigorous. `research/test_drift.py` (376 lines) is the strongest
test file in the set: it validates the analytic PSI null against a 400-draw
empirical null to within 0.03 (:98-111), asserts the conventional 0.1 threshold
*would* false-alarm at these sizes (:113-125), tests the hard negative direction
(an ordinary season shift must not flag, :173-184), and pins the tree-vs-linear
domain-classifier choice as a test so a future "simplification" back to logistic
regression fails (:301-318).

**Defect — D-01 (P2): never run. See section 3.** `market_lab.py:302-312` and
`tree_lab.py:1070-1083` both call `scan_lab_fold` for six folds each; neither
report on disk contains `drift_scans`.

**Defect — D-14 (P3): `calibration_weak` requires *every* role to be weak.**

```python
638     weak = all(bool(r.get('weak')) for r in reference.values())
```

`season_boundary_reference` marks a role weak whenever it pooled fewer than 8
observations (:335,350). With 86 features the `availability` and `model` roles
will clear 8 easily while the `market` role (about 8 columns) may not. In that
case `market`'s verdicts use the noise-floor fallback while `calibration_weak` is
`False` and the summary never says so. `_verdict_for` does carry the per-role
`weak` into its prose (:544-546), so the information is not lost — but the
top-level flag the UI reads (`ResearchLab.tsx:333` `DriftDeclinePanel`) can be
`False` while a role is uncalibrated.

**Defect — D-15 (P3): dead branch.**

```python
424     n_splits = 3 if uniq.size >= 6 else 2
425     if uniq.size < 4:
426         return {'skipped': True, ...}
...
445         splitter = GroupKFold(n_splits=n_splits) if uniq.size >= n_splits else KFold(n_splits=n_splits)
```

After the `uniq.size < 4` guard, `uniq.size >= n_splits` is always true. The
`KFold` fallback is unreachable — which is fortunate, because a `KFold` here would
split weeks across folds and defeat the group discipline the function exists to
enforce. Delete the branch rather than leave a trap.

**imported_by.** `market_lab.py:32`, `tree_lab.py:70`,
`expert_selector_lab.py:97`, `book_lag_lab.py:131` (constant only),
`research/test_drift.py:32`. Rendered by `ResearchLab.tsx:333`.

**Verdict.** Active in code, **inert on disk**. Best-tested module, zero realized
output.

---

### 2.7 `research/tree_lab.py` — 1,123 lines

**Purpose.** Package C extended. Three targets (movement regression, cover/over
classification, residual quantile regression), 6+ families per target plus a
genuine market-only baseline in every comparison, an LGBMRanker branch, a
market-anchored logit branch, leakage and drift scans, and `emit_oof` for
Package F.

**Key functions.**
- `build_dataset(db_path)` :125 — 86 features. Chronology block (:191-204) copied
  verbatim from `market_lab` by design (:41-44), plus overround, roof, per-team
  rest, a primetime proxy from the kickoff hour (:230-236), a 3-game recent-form
  window, `*_available` flags and `*_age_days` columns for every lagged input, and
  the five specified residual interactions (:266-300) — each with an inline
  comment naming the proxy and what it is *not*.
- `market_no_vig_prob` :99, `logit` :112, `sigmoid` :117.
- `emit_oof(...)` :448 — persists per-row per-candidate held-out predictions with
  an explicit `guarantee` string and a warning to the consumer (:465-469) that the
  stacker must itself be fit chronologically.
- `evaluate_classification(rows, proba, market_prob)` :516 — bets only on a
  `PROB_EDGE = 0.02` disagreement with the de-vigged market, with the reason given
  at :518-520.
- `run_ranker` :599, `run_market_anchored_logit` :673, `run_movement` :744,
  `run_classification` :798, `run_quantile` :886, `run` :953.

**Honesty notes worth keeping.** The interaction comments (:266-300) say plainly
that interactions 1-3 are proxies because "this project has no per-player
roster/snap feed wired into this extractor". The `limitations` block (:983-1000)
repeats it, and `docs/evidence/2026-09-09/AUDIT-EVIDENCE.md:332` independently
confirms the proxy list. `run_quantile`'s docstring (:887-890) states the absence
of a TPOT quantile search rather than skipping it silently. The ranker's `note`
(:664-666) explicitly demotes NDCG to informational.

**What it found.** `server/data/tree-lab/latest.json` (86 features, 1,795 rows,
2,268 s wall clock, 0 errors):

- **Movement, spreads:** `no_move` selected all three seasons. Gain CI `[0,0]`.
- **Movement, totals:** `tpot` selected all three seasons; gain CI entirely
  negative in 2023 and 2024, positive only in 2025.
- **Cover:** `tpot` selected in 5 of 6; `beats_market_log_loss` **false** in 11 of
  12 candidate-selected cells. Paper ROI negative in 5 of 6.
- **Quantile:** `market_only` selected in 5 of 6. Held-out coverage is respectable
  (τ=0.9 observed 0.835 / 0.922 / 0.877 on spreads). Coherence violations reported
  raw (LightGBM up to 10.2% of rows).
- **Ranker:** ROI −16.8% (spreads) and −9.2% (totals) on top-3 picks per week.
  NDCG 0.76 / 0.79 — exactly the trap the `note` warns about.
- **Market-anchored logit:** shrinkage **0.0** selected in both markets, i.e. the
  inner CV concluded the feature model adds nothing and the answer is the market
  unchanged. The cleanest statement of the no-edge result in the whole suite.

**Defect — D-04 (P2): TPOT selection bias, same mechanism as D-02, larger effect.**

```python
773             models['tpot'] = automl.fitted_pipeline_
774             losses = [mean_absolute_error(y[va], clone(models['tpot']).fit(X[tr], y[tr]).predict(X[va])) for tr, va in cv]
775             scores['tpot'] = float(np.mean(losses))
...
782     selected = min(scores, key=scores.get)
```

and identically at :851-858 for classification. The cover branch makes the bias
unmistakable: TPOT posts the **lowest inner log loss in every single cover cell**
(0.6806 / 0.6895 / 0.6889 / 0.6656 / 0.6817), always beating `market_only`
(~0.693) and `coin_flip` (0.6931) — then out of sample it scores 0.8025 / 0.7121 /
0.7048 / 0.6887 / 0.7210, worse than the market in 4 of 5 and worse than a coin
flip in all 5. Across movement and cover, TPOT won 8 of 12 selections and lost out
of sample in 7 of them. Every headline `log_loss`, `brier` and `roi` at the fold
level is produced by that biased selection.

The fix is standard: score TPOT on a fold held out from its own search (nested
CV), or exclude it from `min()` and report it separately as a search diagnostic.

**Defect — D-05 (P2): the leakage scan does not cover every experiment.**

```python
833         leak = detect_feature_leakage(X, y, cv, names, task='classification')
...
1089     full_move_rows = [r for r in data if r['market'] == 'spreads' and r['season'] < 2025]
1094         leak = detect_feature_leakage(Xf, yf, cv_full, names, task='regression')
1095         leakage_reports.append({'market': 'spreads', 'season': '<2025 pooled', 'target': 'move', **leak})
```

Those are the only two call sites (confirmed by grep across `research/`). Result:
7 scans in the frozen report — 6 cover (every market × season) and 1 pooled
spreads movement. **Never scanned:** totals movement, the `outcome` quantile
target (`run_quantile`, :886 — a different label entirely), the ranker's
profit-graded target, and the market-anchored logit. `README.md:117-118` says "It
runs against the real dataset on every experiment". Either scan the other targets
or correct the README.

**Defect — D-09 (P2): the totals quantile branch reports spread key numbers.**

```python
581     margins = [abs(r['actual_margin']) for r in rows]
...
932     key_mass = key_number_push_mass(train)
950         'key_number_push_mass_train': key_mass}
```

`run_quantile` is called for both markets (:1021), and `key_number_push_mass`
always keys off `actual_margin`. The totals quantile result therefore carries a
`key_number_push_mass_train` block describing **game margins**, not totals.
Verified in the frozen report: the totals 2025 block reports a 15.7% mass at
margin 3 with spike ratio 3.38 — identical in kind to the spreads block (15.5%,
3.26). For a totals contract the meaningful push mass sits at total scores like
37/41/44/51, and none of that is measured. A reader looking at the totals quantile
section is shown a spread diagnostic labelled as if it belonged there.

Secondary issue in the same function: `KEY_NUMBERS = [3, 7, 10, 4, 6, 14, 1, 2]`
(:82) includes numbers adjacent to the real spikes, so their `spike_ratio` is
contaminated by the neighbour average — margin 4 reports 0.43 and margin 2 reports
0.48 purely because 3 is their neighbour. Reported as if they were anti-spikes.

**Defect — D-16 (P3): the logit and ranker branches skip the settled-label cutoff.**

```python
1035             train_final = [r for r in rows_market if r['season'] < 2025]
...
1044             cover_rows = [r for r in rows_market if abs(r['outcome']) > 1e-9]
1045             train_c = [r for r in cover_rows if r['season'] < 2025]
```

Every other branch applies `stamp(r['label_at']) < outer_cutoff` on top of the
season filter (`run_movement:749`, `run_classification:805`, `run_quantile:895`).
These two bonus branches apply only the season test — the exact "common half-right
mistake" that `research/betting/nfl/dataset.py:238-240` was written to name. No
actual leak results (the 2024 season settles in January, the 2025 season opens in
September), but it is an inconsistent guarantee in two of the report's branches.

**Defect — D-17 (P3): the logit discipline label omits the season.**

```python
691     record(discipline, check_fold(package='C', label=f'{train[0]["market"]}/market_anchored_logit',
```

Every other verdict label carries `{market}/{season}/{target}/{fold}`. This one
carries only the market, so the verdict cannot be located in the report the way
its siblings can.

**Defect — D-18 (P3): `beats_market_log_loss` is decided by float noise.**

The published logit result reports `log_loss: 0.6939137339320574` vs
`market_log_loss: 0.6939137339320572` and `beats_market_log_loss: false`. With
shrinkage 0.0 the model *is* the market, so the strict `<` at :538 makes the
report literally say the market fails to beat itself. Use a tolerance.

**Preregistration.** Honoured. `preregistered.json` written at :1004 before any
fit, `markets: []`, `code_hash` and `dataset_hash` matching the final report
(`2e46b49a…`, `503cabbd…`).

**imported_by.** `research/test_tree_lab.py:24`. Its `emit_oof` output is read by
`research/expert_selector_lab.py:323` `load_tree_oof`. Its report is read by
`nfl-research-lab.js:105-106` and rendered at `ResearchLab.tsx:161`.

**Verdict.** Active. The most substantial file in the set; three published numbers
are wrong or mislabelled.

---

### 2.8 `research/expert_selector_lab.py` — 944 lines

**Purpose.** Package F. A simplex-constrained (non-negative, sum-to-1) ridge
stacker over experts, with a mixture-of-experts gate on disagreement / coverage /
week at 2 and 3 bins, benchmarked against market-only, static-equal-weight and the
production coordinator.

**Key functions.**
- `simplex_ridge(P, y, alpha, mask)` :134 — SLSQP with a sum-to-1 equality
  constraint and `[0,1]` bounds; availability-masked rows **renormalize** rather
  than letting an absent expert contribute zero (:139-143 explains why that
  distinction is the difference between "learning to abstain" and "missing data").
- `apply_weights` :174, `week_cluster_interval` :187 (2000 draws over week blocks),
  `cluster_families` :210 (single-linkage union-find on |pearson r| ≥ 0.90),
  `load_council` :250, `council_matrix` :290, `load_tree_oof` :323,
  `effective_weights` :362, `select_alpha` :379, `fit_and_predict` :401,
  `walk_forward` :474, `family_ablation` :522, `contribution` :543,
  `declaration` :577, `expert_drift_scan` :683, `verdict_for` :825, `run` :873.

**What it found.** `server/data/expert-selector-lab/latest.json` — a clean,
complete negative:

| substrate | rows | experts | any trial passed (MAE) | (MSE) | significantly worse than market |
|---|---|---|---|---|---|
| council | 831 | 18 | **False** | False | 1 (`gate:week:3`, 2024) |
| tree:spreads:move | 660 | 7 | **False** | False | 1 (`gate:disagreement:2`, 2025) |
| tree:totals:move | 685 | 7 | **False** | False | **5** (global and 4 gates, 2024) |

No configuration beat both baselines with a week-clustered interval excluding
zero, on either metric, on any substrate. Seven configurations were significantly
*worse* than simply taking the market. `verdict_for:866-868` states this as a
complete result per the declaration, which is exactly right.

**Preregistration — honoured in form, two gaps in substance.**

*Form:* `declaration()` is written to `preregistered.json` at :897, four lines
before the first substrate is scored at :905. `declaration_written_at`
(21:22:15.49) precedes `created_at` (21:22:20.97) in the frozen report. Verified.

**Defect — D-08 (P2): a declared trial was never run, and the report is silent.**

```python
667             'the same on the tree OOF substrate for movement and cover targets'],   # trials_planned
...
882     tree = load_tree_oof(args.oof_dir, 'move') if args.oof_dir else None
```

`load_tree_oof` is called once, hard-coded to `'move'`. The six cover OOF files
exist on disk and are never opened:

```
server/data/expert-selector-lab/oof-source/20260908T211554Z-e1c875cd/
  spreads-2023-cover-oof.json   totals-2023-cover-oof.json
  spreads-2024-cover-oof.json   totals-2024-cover-oof.json
  spreads-2025-cover-oof.json   totals-2025-cover-oof.json
```

A preregistered trial that is not run and not reported as un-run is the one thing
preregistration is supposed to make impossible. Either run it or add it to
`known_limitations`.

**Defect — D-10 (P2): the declared objective is not the implemented objective.**

```python
600             'non-negative ridge with coefficients summing to 1: min_b sum(y - Pb)^2 + alpha*sum(b^2) '
```
(`declaration`, and identically in the module docstring :12 and `README.md:157`)

```python
161         return float(np.mean(resid ** 2) + alpha * np.sum(b ** 2))
```
(`simplex_ridge.objective`)

`sum` in the declaration, `mean` in the code. The ridge penalty is therefore
effectively `n·alpha` times stronger relative to the declared form, and the
declared `ALPHA_GRID = [0, 0.001, 0.01, 0.1, 1.0, 10.0]` (:114) does not mean what
the preregistration says it means on an 831-row fold. The function's own docstring
(:135) is the *correct* one — it says `/n` — so the divergence is between the
docstring and the three places that restate it. The negative result is not
threatened (the market-only column can still take weight 1.0 at any alpha), but a
reader reconstructing the experiment from the preregistration would build a
different estimator.

**Defect — D-19 (P2): reads the live database without a snapshot transaction.**

```python
260     conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
261     conn.row_factory = sqlite3.Row
262     rows = conn.execute("""
```

Compare `market_lab.py:72-74` and `tree_lab.py:136-138`, which both issue
`con.execute('BEGIN')` for a consistent read while the collector may be writing,
and `research/betting/nfl/dataset.py:89-100`, whose docstring calls that
"a correctness property, not a nicety". This lab omits it. Today the query is a
single `SELECT … ORDER BY audit_run_id, id` so the exposure is small, but the
guarantee the sibling labs advertise is absent here. The path is also interpolated
raw rather than via `Path(db_path).resolve().as_uri()`, so a path containing `?`
or `#` would be mis-parsed as URI syntax.

**Defect — D-20 (P2): `atomic_json` here permits NaN; the sibling labs forbid it.**

```python
122     tmp.write_text(json.dumps(value, indent=2, sort_keys=True, default=str))
```

vs `market_lab.py:57` and `book_lag_lab.py:166`, which both pass
`allow_nan=False`. A NaN reaching this writer (e.g. `mae` on an empty slice, or
`np.std` of a one-element array in `load_tree_oof:344`) serializes as a bare
`NaN` token, which is **not valid JSON**. `nfl-research-lab.js:16` wraps the parse
in try/catch and returns `null`, so the whole Package F section would silently
vanish from the Research Lab page rather than erroring. No NaN is present in the
current file — I checked — but the guard is missing.

**Defect — D-21 (P3): family clustering uses near-all seasons.**

```python
769     train_mask = np.array([s != max(set(seasons)) for s in seasons])
770     families, pairs = cluster_families(P[train_mask], mask[train_mask], columns)
```

"Training rows only" here means "everything except the final season", but
`walk_forward`'s first fold trains on 2022 alone and scores 2023. Families are
therefore computed partly from seasons that some folds score. Families only drive
the ablation robustness check, and at |r| ≥ 0.90 every expert is a singleton
anyway (`families: 18` for 18 columns) — which the code discloses at :781-782
("family ablation below is equivalent to leave-one-expert-out and is reported as
such rather than as a stronger test"). Low impact, but it is a training/scoring
boundary crossed silently.

**The metric amendment.** `metric_amendment_after_first_run` (:668-674) discloses
that MSE was added as a secondary metric *after* the first scored run. This is
real, and the evidence is on disk: run `ac6a3436` (21:19:38) has neither
`trials_meeting_rule_on_secondary_mse_metric` nor `significantly_worse_than_market`
in its verdicts; run `4514de3d` (21:22:15), three minutes later, has both. The
amendment's argument — that it can only make the selector look better, so it
cannot be a search for a flattering framing — holds, and the second addition
(`significantly_worse_than_market`) makes the result look *worse*. Disclosed in
the preregistration text itself. I record it as honest rather than as a defect,
but it is a genuine post-hoc metric addition and a reader should know it happened.

**Testing.** `research/test_expert_selector_lab.py` (291 lines) proves the two
load-bearing properties directly: weights are non-negative and sum to 1 (:42-47),
the blend cannot leave the envelope of its experts even with a 1e6 haywire column
(:49-71), `market_only` can take weight > 0.95 outright (:73-84), availability
masking renormalizes instead of biasing toward zero (:97-106), and gate edges come
from training rows only (:197-210).

**imported_by.** `research/test_expert_selector_lab.py:12`. Report read by
`nfl-research-lab.js:121-122`, rendered at `ResearchLab.tsx:261-301`.

**Verdict.** Active. Result trustworthy and correctly negative; the
preregistration has two substantive gaps (D-08, D-10) and the DB read is less
careful than its siblings.

---

### 2.9 `research/book_lag_lab.py` — 1,054 lines

**Purpose.** Package B. Who moves the price first and who follows. Reads a frozen
Package A evidence dataset (never `data.sqlite`), builds per-event book panels,
produces a symmetric lead/lag map, and fits three targets: next-move
probability/size, time-to-follow (discrete-time hazard), and delay survival.

**Key functions.**
- `EventPanel` :260 — `observed` (real rows), `filled` (forward-filled up to
  `MAX_FORWARD_FILL_STEPS = 3`), `moves` (from `observed` only).
- `lead_lag_matrix(panels)` :360 — symmetric; explicitly **not** fed back as a
  feature (:364-367: "a matrix built from the whole dataset would leak into any
  fold that reused it").
- `target1_rows` :420, `hazard_rows` :628, `run_target1` :516, `run_target2` :671,
  `run_target3` :762, `route_opportunities` :790, `hawkes_feasibility` :831,
  `write_protocol` :869, `run` :931.

**What it found.** `server/data/book-lag-lab/latest.json` — 44 events, 11 books,
native poll gap 360.2 s, 1,922 confirmed moves.

Genuinely interesting and worth Nick's attention: **Pinnacle has the lowest
leader share of any readable book with meaningful volume** — 11 leads vs 20
follows, `leader_share` 0.355. Bovada (0.569), bodog (0.628) and betrivers (0.65)
lead more often. On a one-week tape with n=11-66 per book this is suggestive, not
established, but it is the opposite of the standard assumption and it is exactly
the kind of execution-side observation that matters given the settled finding that
the only measured edge is line-shopping and execution. `sharp-lag.js` hardcodes
Pinnacle as the reference; this tape does not support that.

**Defect — D-06 (P1): the next-move label is built from forward-filled quotes.**

The class docstring states the invariant:

```python
264     `filled[book][i]` is the same thing carried forward for up to
265     MAX_FORWARD_FILL_STEPS grid steps, for use only in cross-sectional
266     FEATURES ("what do the other books show right now"), never to invent a
267     move that was not actually observed.
```

The label construction violates it:

```python
442                 for h in HORIZON_STEPS:
443                     j = i + h
444                     if j >= len(panel.grid):
445                         continue
446                     target = panel.filled[book][j]
447                     if target is None:
448                         continue
449                     delta = target['line'] - own['line']
450                     out.append({**base, 'horizon': h,
451                                 'moved': int(abs(delta) >= MIN_MOVE[market]),
452                                 'delta': delta})
```

When a book is not quoted at step `j`, `filled[book][j]` returns its own row from
up to three steps earlier — frequently `own` itself — so `delta = 0` and
`moved = 0`. That is a fabricated negative label for a period in which the book's
line was simply not observed. The measured base move rate is 0.7-1.1%, so these
fabricated zeros sit inside the majority class of an extremely rare-event target.

This is a leak, not merely a bias, because the feature set encodes precisely the
staleness that generates the fabricated label: `own_steps_since_move` and
`coverage` are both in `FEATURE_KEYS_T1` (:416-417). A model can lower its log
loss by learning "this book has been quiet and is thinly covered, so the
forward-filled label will read 0" — which is a statement about our polling, not
about the market.

`research/test_book_lag_lab.py:62-69` appears to guard this invariant, but it
asserts it on `panel.moves` (which correctly uses `observed`) and never touches
`target1_rows`. The test passes while the label path breaks the rule.

Minimum fix: use `panel.observed[book][j]` for the label and drop the row when it
is `None` (unobserved is not "no move"), or carry an `observed_at_target` flag and
report the two populations separately.

**Defect — D-04b (P1): the headline verdict counts half-failing cells as passes.**

```python
973         for h, cell in target1[m].items():
974             if cell.get('readable'):
975                 readable_cells += 1
976                 if not cell['probability_model']['beats_baseline'] and not cell['magnitude_model']['beats_baseline']:
977                     failing_cells += 1
```

A cell fails only when **both** its models lose. In the frozen report the
magnitude model loses in **all six** next-move cells (`zero_delta` wins every
time: 0.0042 vs 0.0079 / 0.0051 vs 0.0093 / 0.0061 vs 0.0107 for spreads, and the
same pattern for totals), yet every cell is scored as a pass. The published
verdict reads:

> "8 of 8 readable target/market/horizon cells beat their baseline out-of-fold"

and `per_cell_baseline_failures` is `[]`. The accurate statement is "6 of 6
next-move probability models beat a constant-rate baseline; 6 of 6 next-move
magnitude models lost to predicting zero; 2 of 2 time-to-follow models beat the
marginal hazard." That verdict string is rendered verbatim in the UI at
`ResearchLab.tsx:192`.

**Defect — D-22 (P2): the baselines are scored in-sample, the models out-of-fold.**

```python
538         base_rate = float(np.mean(y_move))
539         base_pred = np.full(len(y_move), base_rate)
540         baseline_prob = {'name': 'no_move_marginal_rate', 'mean_loss': r4(binary_log_loss(y_move, base_pred))}
```

and identically at :687-689 for `marginal_hazard_by_step`. Both baselines are
fitted on all rows and scored on all rows, while `logit_cv` and `hgb_cv` come from
`group_kfold_eval`. They are then placed side by side in one `candidates` dict
(:605-612, :724-726) and compared with `min()`. The direction of the bias favours
the baseline, so it does not manufacture the "models win" result — but the numbers
are presented as comparable and are not.

**Defect — D-23 (P2): `hawkes_feasibility` contradicts itself.**

```python
845     verdict = (bool(params_needed) and total_moves > 0 and fallback_share is not None
846                and fallback_share < 0.15 and total_moves >= 5 * params_needed)
```

On the real data: 1,922 moves ≥ 5 × 110 = 550 ✓, fallback share 0.0861 < 0.15 ✓,
so the frozen report carries `"would_be_feasible": true`. The prose verdict in the
same object is a hard-coded no-go string ignoring that flag, and it is the string
the UI renders (`ResearchLab.tsx:203`):

> "…the current tape only has 1922 confirmed moves across 11 books against 110
> pairwise kernel parameters … Fitting one now would overfit…"

17.5 moves per parameter is above the module's own declared bar. Further, the
module docstring's two stated reasons are contradicted by its own measurements:
":62-65" claims "a visible minority of books stamp `book_updated_at` exactly equal
to our own poll time on a meaningful share of rows" (measured: 8.6%, below the
module's own 15% threshold), and ":69-71" claims "the number of genuine moves per
book this week is in the single digits to low tens" (measured: 1,922 / 11 ≈ 175
per book). The go/no-go is "checked fresh every run … not assumed"
(`README.md:47-48`) — and then the assumption overrides the check.

**Defect — D-24 (P2): opportunity routing is degenerate and the count is inflated.**

```python
794     thresholds = {'paper_opportunity': 0.70, 'refresh': 0.30}
...
801             survival = t3['delay_survival'].get('30', {}).get('survival_probability')
...
817                     state = ('paper_opportunity' if survival >= thresholds['paper_opportunity']
818                              else 'refresh' if survival >= thresholds['refresh'] else 'watch')
```

`survival` is a single scalar per market (0.9997 spreads / 0.9986 totals) that
does not vary by opportunity, so every gap routes to the same bucket. The frozen
result is `{'paper_opportunity': 8904}` with zero `refresh` and zero `watch` — a
three-state classifier that has never produced two states. Worse, that 30-second
survival is itself an **extrapolation** of a constant-hazard fit through a
360-second poll gap (`extrapolated: true` on the same object), so the routing is
driven entirely by a modelling assumption about a horizon never observed.

The 8,904 count is also not 8,904 bettable opportunities: the loop counts one
entry per (leader-move, follower) pair, so one stale follower is re-counted once
for every book that moved ahead of it. `ResearchLab.tsx:206` renders these counts
as headline chips with no denominator.

**Defect — D-25 (P3): hard-coded event count contradicts the measured one.**

`report['limitations'][0]` (:1025) says "The tape spans one NFL week (48 events,
one capture window)". `panel_summary.events` in the same report says **44** — four
events were dropped by `build_all_panels` (:349-353) for having fewer than two
books or fewer than four grid steps. 48 is the upstream figure from
`server/data/evidence-datasets/latest.json` → `events`. The modelled number is 44.

**Preregistration.** `write_protocol` is called at :947 before any target runs at
:956-959, so ordering is honoured. But unlike the other three labs the protocol
carries no `run_id`, `code_hash` or dataset row-count binding — only
`scope.source_dataset_hash` and a self-asserted `written_before_evaluation: True`
(:871). It is the weakest preregistration artifact of the four.

**Positives worth keeping.** `lead_lag_matrix` is genuinely symmetric and
`test_book_lag_lab.py:87-97` enforces it with an AST check that no book name
appears as a literal anywhere outside the docstring. The split-policy limitation
(:900-906) states plainly that GroupKFold-on-event is weaker than the plan's
chronological requirement and that this run's numbers should be treated as
superseded once more weeks exist. `cluster_interval` (:193) is defined and never
called — dead code (P3).

**imported_by.** `research/test_book_lag_lab.py:6`. Report read by
`nfl-research-lab.js:111-112`, rendered at `ResearchLab.tsx:190-211`.

**Verdict.** Active. The most problematic file in the set: the only lab publishing
a positive headline, and that headline does not survive inspection.

---

### 2.10 `research/betting/nfl/dataset.py` — 278 lines

**Purpose.** The extracted shared cutoff-safe chronology that
`docs/CLAUDE-NEXT-STEPS.md:456` and `:673` asked for — "Extract a shared
cutoff-safe dataset builder from the overlapping `market_lab.py` and `tree_lab.py`
logic."

**Key functions.** `stamp` :59 (more permissive than the labs': handles `datetime`
objects and `%Y-%m-%d` / `%Y-%m-%d %H:%M:%S`), `read_only_connection` :89
(`?mode=ro` + `BEGIN`), `load_games` :103, `rest_by_team_week` :111,
`build_chronology` :123, `load_team_week_features` :156, `history_before` :181,
`features_before` :187, `american_profit` :198, `fold_cutoff` :217,
`eligible_training_rows` :231, `shared_setup` :258.

The docstring is the sharpest statement of the problem anywhere in the repo:

> "Two copies of a chronology is two chronologies. They agree today because
> someone kept them in step by hand; the first time one is fixed and the other is
> not, two experiments quietly stop being comparable, and nothing fails."
> (`dataset.py:13-15`)

**Defect — D-26 (P2): it is orphaned. The duplication it was written to remove is
still live in both labs.**

Neither `market_lab.py` nor `tree_lab.py` imports it — confirmed by reading every
import line in both files (`market_lab.py:17-32`, `tree_lab.py:52-70`) and by
`grep -rn "betting" research/*.py`, which returns one unrelated docstring hit.
`sys.path` manipulation in `test_dataset.py:20-21` is the only thing that loads
it.

`tree_lab.py:41-50` still carries the comment saying the chronology is
copy-pasted, and `tree_lab.py:991-993` still lists the duplication as a live
limitation in every published report. `docs/CLAUDE-NEXT-STEPS.md:87` records slice
6 as "implemented … The shared cutoff-safe chronology is extracted and
parity-tested" — extracted, yes; adopted, no.

**Defect — D-27 (P2): the parity test does not test parity with the labs.**

```python
159     def test_market_lab_and_tree_lab_agree_with_the_shared_chronology(self):
...
166             # Recompute the labs' own inline chronology, exactly as both files
167             # write it today, and require identical output.
168             con = sqlite3.connect(Path(db).resolve().as_uri() + '?mode=ro', uri=True)
...
180                 ready = d + timedelta(days=3)
```

The test re-types the labs' chronology inline (`test_dataset.py:171-188`) rather
than importing `market_lab.build_dataset` or `tree_lab.build_dataset`. That is a
**third** copy of the logic. If `market_lab.build_dataset` changes tomorrow, this
test still passes and still reports parity. It proves `dataset.py` agrees with the
test file, which is not the guarantee the class name claims.

**Defect — D-28 (P3): `features_before` has different semantics from both labs.**

```python
187 def features_before(pbp, team, decision_at):
188     """The latest team-week feature set publishable strictly before the cutoff."""
```

It returns the single latest feature set. Both labs average the last **eight**
(`market_lab.py:134-137`, `tree_lab.py:253-257`). `history_before` accepts a
`limit` parameter and can reproduce the labs' 8-game window; `features_before`
cannot. Adopting `dataset.py` as-is would silently change every play-by-play
feature in both labs.

Also: `dataset.american_profit('x')` returns `None` (it goes through `float()`),
while `market_lab.american_profit('x')` raises `TypeError` at `math.isfinite`.
`test_dataset.py:152` asserts the shared behaviour; nothing asserts the labs
match it.

**imported_by.** `research/betting/nfl/test_dataset.py:23` only. Listed as
`keep / new_this_round_verified` in
`docs/reference/architecture/folder-map.csv:211`.

**Verdict.** **Orphaned.** Correct code, correctly reasoned, zero adoption.

---

### 2.11 Test files — 1,316 lines

| file | lines | what it actually proves |
|---|---|---|
| `test_market_lab.py` | 33 | Settlement math incl. pushes and a `None` price; `time_folds` purges labels and keeps weeks whole; a zero prediction abstains. Small but load-bearing. |
| `test_tree_lab.py` | 170 | The injected-leak proof (regression + classification), quantile coherence detection, calibration coverage, key-number spike, no-vig probability, digest/fold determinism. |
| `test_book_lag_lab.py` | 147 | Forward-fill goes stale after the max gap; sub-threshold moves are not moves; a missing quote is a gap not a move (**on `moves`, not on the label** — see D-06); no hardcoded book name via AST check; hazard extrapolation direction. |
| `test_drift.py` | 376 | The strongest file here. Analytic PSI null vs a 400-draw empirical null (δ 0.03); the conventional 0.1 threshold demonstrably false-alarms; ordinary season shift is NOT flagged; injected source change and dark feed ARE; market vs model role treatment on an identical shift; the joint check catches a correlation-only change a logistic classifier cannot. |
| `test_model_discipline.py` | 299 | Every target-type numerator, the ICC/design-effect edge cases, all degenerate folds, strict-vs-report plumbing, an AST authority check that the module contains no `sqlite3`/`kelly`/`stake`. Weakened by :291-295 (see D-13). |
| `test_expert_selector_lab.py` | 291 | Simplex constraint holds; the blend cannot leave its experts' envelope even against a 1e6 column; `market_only` can win outright; masking renormalizes; gate edges are training-only; the drift scan excludes `market_only` and flags a coverage collapse. |
| `test_dataset.py` | 201 | Publication lag, week-end = last game, strictly-earlier lookups, per-team rest, drop-not-default, the both-conditions training filter, payout parity. Weakened by :159-197 (see D-27). |

All seven are synthetic-data only; none touches `data.sqlite`. Coverage of pure
logic is good. The systematic gap: **no test asserts that a run's frozen report
contains a `model_discipline` or `drift_scans` block**, which is the exact
guarantee that turns out to be unmet.

---

### 2.12 `server/data/*/latest.json` and the manifests

`server/data/evidence-datasets/05ed3ece6d9b4590/manifest.json`,
`server/data/news-event-impact/6b0ff0f28bf577ba/manifest.json` and
`server/data/role-scenario-lab/099899267f1f752b/manifest.json` are **byte-identical**
to the corresponding `latest.json` (verified with `diff -q`). `latest.json` for
those three is a copy, not a pointer. For market-lab / tree-lab / book-lag-lab /
expert-selector-lab, `latest.json` is a copy of the newest run's `report.json`.

**`evidence-datasets/latest.json`** — 752,954 rows scanned, 752,954 accepted,
**0 dropped, quarantine `[]`**, 48 events, 11 books, `reconstructed: 0`. This is
the frozen tape `book_lag_lab` inherits its chronology guarantees from
(`book_lag_lab.py:6-9`). Worth noting: a chronology guard that has never rejected
a single row out of 752,954 is unexercised, not proven. The manifest's own
limitation #4 says exactly this — "A quarantine count of zero for a rule means the
tape never violated it here, not that the rule is unnecessary." Honest.

**`news-event-impact/latest.json`** — Package E. 30 events, 24 verified claims,
6 quarantined, and `"skipped_no_quote_pair": 24` → **0 usable rows** against a
minimum of 20. Verdict: "only 0 claims paired with a post-claim quote — below 20;
no model comparison is reportable yet". A correct, complete null. Its
`provenance.verdict` ("every claim was observed at or after its publication time")
is the one chronology guard in this set that has a real pass/fail record: 30
events checked, 0 flagged.

**`role-scenario-lab/latest.json`** — Package D, and the **only positive result in
the entire audited set**:

| season | metric | baseline MAE | scenario MAE | mean diff | CI90 | significant |
|---|---|---|---|---|---|---|
| 2024 discovery | touches | 2.572 | 2.500 | −0.0707 | [−0.1125, −0.0285] | **yes** |
| 2025 holdout | touches | 2.473 | 2.429 | −0.0457 | [−0.0742, −0.0170] | **yes** |
| 2024 discovery | yards | 21.375 | 21.484 | +0.1094 | [−0.122, +0.328] | no |
| 2025 holdout | yards | 21.533 | 21.669 | +0.1362 | [−0.041, +0.311] | no |

Verdict: "Real, holdout-confirmed improvement on touches." Split policy is
chronological (fit 2022-2023, discovery 2024, holdout 2025), the changepoint
threshold was frozen on fit seasons before scoring, and the bootstrap is
block-resampled by team-week. This is directly on Nick's stated priority (fantasy
first: it predicts RB/WR/TE touches when a same-position teammate is
Questionable/Doubtful/Out).

Two caveats the file itself records. First, the declared market-only baseline was
**never evaluated** — `nfl_prop_quote_snapshots` only covers 2026-09-02 onward, so
there is no historical prop tape to grade against; stated as a limitation rather
than dropped. Second, `cascade_conservation_audit`: 30 of 110 starters checked
(**27.3%**) have `cascades()` beneficiary multipliers that, summed across
teammates, promise more total extra opportunity than the starter himself ever used
per game — George Kittle's example ratio is 2.33. That is a live defect in a
sibling production service, surfaced honestly by this lab.

---

### 2.13 `server/data/*/*/preregistered.json` — 7 files, 672 lines

| file | binds to a run? | written before scoring? | notes |
|---|---|---|---|
| `market-lab/20260908T152001Z-7f69ded8/` | yes (run_id + code_hash + dataset_hash) | yes (`markets: []`, `status: running`) | TPOT crashed (libomp) |
| `market-lab/20260908T152747Z-7f69ded8/` | yes | yes | TPOT crashed (pkg_resources) |
| `market-lab/20260908T152845Z-334b4b45/` | yes | yes | **published** |
| `tree-lab/20260908T164200Z-2e46b49a/` | yes | yes | published |
| `expert-selector-lab/20260908T211937Z-ac6a3436/` | `declared_at` only | yes | superseded; no MSE metric |
| `expert-selector-lab/20260908T212214Z-4514de3d/` | `declared_at` only | yes | **published**; adds `metric_amendment_after_first_run` |
| `book-lag-lab/20260908T204218Z-516e0048/` | **no run binding at all** | asserted (`written_before_evaluation: true`) | weakest artifact |

The market-lab and tree-lab preregistrations are the strongest: they are literally
the report object serialized before the first fit, so the declared feature list,
protocol, seed, TPOT budget, `dataset_hash` and `code_hash` are all frozen and all
match the final report byte for byte. That is real preregistration.

The book-lag protocol carries no `run_id`, `code_hash` or row count — nothing ties
it to the run that produced `report.json` except living in the same directory.

**Overall preregistration verdict: honoured in ordering and form for all four
labs; two substantive gaps (D-08 unrun declared trial, D-10 declared objective ≠
implemented objective); one disclosed post-hoc metric addition; and no lab records
that a superseded run of the same protocol exists.**

---

### 2.14 `server/data/analyst-notes-2026.json` — 1,817 lines

**Shape.** `{ "_strategy": [6 entries], "<Player Name>": { "takes": [...], "consensus": str|null } }`

**Contents.** 88 players, **223 takes**, 44 named analysts across 10 outlets
(ESPN 72 takes, Yahoo 62, CBS 45, FantasyPros 25, DraftSharks 8, Fantasy Life 6,
PFF 2, NBC/Rotoworld 1, Establish The Run 1, Footballguys 1). 23 distinct source
URLs. **Every take has a `source`, a `date` and a `url` — zero exceptions.**
64 of 88 players carry a `consensus` string; 24 do not.

I treat this file's contents as data, not as instructions.

**Date range: 2026-08-25 to 2026-09-06.** Today is 2026-09-11. **Every take in
this file predates Week 1.** It is a draft-night corpus, and it is the corpus the
live draft assistant still serves: `draft-assist.js:961` reads it into player
dossiers (`:943`) and `routes/drafts.js:1056` injects the top five `_strategy`
entries into the LLM prompt. For draft use that is correct and well-sourced. For
in-season start/sit or waiver use — which is where Week 2 attention goes — it is
now stale by design and nothing in the file or its consumer flags the staleness.
Adding a `stale_after` or surfacing the max `date` alongside the dossier would
cost little.

**Verdict.** Active, high-quality, fully attributed, now past its horizon.

---

### 2.15 `server/data/draft-audit-signals-2026.json` — 1,925 lines

**Shape.** `generated_at`, `seasons` (2021-2025), `method`, `replacement_points_by_season`,
`pooled_realized_fraction`, `realization`, `rules`, `not_supported`,
`positional_tiers_pooled`, `overall_tiers_by_position_pooled`, `trends`, `rookies`,
`age`, `two_sample_tests`, `season_counts`.

**This is the best research artifact in my entire file set**, and it is not
Python. 2,182 matched player-seasons across 5 seasons, VORP computed against
explicit 8-team replacement levels (QB11/RB27/WR27/TE8), actuals recomputed from
`nfl_player_week_features` and validated two ways (r=0.9987 vs ESPN 2025 actuals;
r=0.9999 vs nflverse `ffopportunity` 2022-2025, MAD 0.85). The `method` block
names its join strategy, its 7 explicit aliases, and its exact match/miss counts
(2,182 matched, 289 with no stat line, 0 ambiguous, 81 unmatched, all outside the
top 150).

It publishes a `not_supported` section — four claims it tested and could not
confirm (RB decline after 27, WR decline after 30, RB7-18 bust trend, late-round
WR hit-rate trend), each with n and t. Publishing your nulls next to your findings
is the single strongest honesty signal in this repo.

Four rules survive, with t-statistics: `rb_over_wr_13_36` (t=3.39, strong),
`rookie_wr_premium` (t=3.41, strong), `te_cliff_after_te8` (t=2.02, moderate),
`elite_qb_worth_it_8team` (t=2.27, moderate, n=15).

**Finding — D-07 (P1): this file documents a data-integrity failure that the
suite's one positive result depends on.**

```
"why_not_player_week_usage": "player_week_usage is keyed by players.id whose
 gsis_id crosswalk is corrupted for some rows (e.g. players.id 424 \"Noah Gray\"
 holds Travis Kelce's gsis 00-0030506; Isiah Pacheco row points at a 2026 rookie),
 so Kelce/Kamara/Andrews/Murray/Ridley/Pacheco had zero rows under their own ids.
 Not used."
```

This audit routed around the corruption by reading `nfl_player_week_features`
instead. But `role-scenario-lab` — the only holdout-confirmed positive result in
the whole set — states in its own manifest:

```
"note": "Read directly from player_week_usage and nfl_injuries via read-only
 SELECT; no rows written to data.sqlite by this module."
```

So the touches improvement (2.473 → 2.429, CI90 [−0.074, −0.017]) is measured on
the table another shipped artifact documents as having a corrupted id crosswalk
for at least six named high-usage skill players — including a TE1 and two RB1s,
exactly the population whose touches the scenario model reallocates. This does not
mean the result is wrong. It means the result has not been shown to be right, and
the check is cheap: re-run the reallocation against `nfl_player_week_features` and
confirm the interval still excludes zero.

**Wiring note (not a defect against my files).** `draft-assist.js:991-997`
consumes only `realization[position][tier].multiplier` and returns a neutral `1`
whenever it is `null`. The data sets `multiplier: null` for every tier at or below
replacement — for RB that is the whole `61-100` and `101-150` range — and tells
the consumer what to use instead: *"slot value below replacement … multiplier
undefined; use vorp_plus_per_pick"*. The RB `61-100` cell realized **19.5 VORP+
per pick against an expected 6.5** (a 3× realization, n=63, hit rate 0.492). The
consumer discards that and returns 1. The strongest late-round signal in the file
is computed, published, and then thrown away at the boundary.

**Verdict.** Active, excellent, and it contains a finding the rest of the suite has
not acted on.

---

## 3. The central cross-cutting finding (D-01)

Every frozen report on disk is schema `-v1`. Every lab on disk is `-v2`. The
`code_hash` recorded in each report differs from the current file hash:

| lab | report schema | report `code_hash` (first 16) | current sha256 (first 16) |
|---|---|---|---|
| market_lab | `market-lab-v1` | `334b4b45f4608136` | `e705dfe69a696a79` |
| tree_lab | `tree-lab-v1` | `2e46b49a536d8b23` | `fe96a95cf412cb2b` |
| expert_selector_lab | `expert-selector-lab-v1` | `4514de3d98236371` | `5716ee74d3d5e9df` |
| book_lag_lab | `book-lag-lab-v1` | `516e0048160f3a89` | `1ae6fec7ddbea493` |

Key presence in the four published reports:

| report | `model_discipline` | `drift_scans` / `drift_scan` | `leakage_scans` |
|---|---|---|---|
| market-lab | **absent** | **absent** | absent (never had one) |
| tree-lab | **absent** | **absent** | present, 7 scans |
| expert-selector-lab | **absent** | **absent** | n/a |
| book-lag-lab | **absent** | **absent** | n/a |

Consequences:

1. `model_discipline.py` (539 lines) and `drift.py` (704 lines) have produced zero
   verdicts in any frozen artifact. They are, today, tested-but-unexercised.
2. The specific checks that would have caught other findings in this audit never
   ran. book_lag_lab's next-move cells report n = 122,789 rows drawn from **44
   games in one week**; `model_discipline`'s `discrete_time_hazard` and
   `binary_classification` numerators with event-level clustering exist precisely
   to say "this is 44 clusters, not 122,789 observations", and they were not in
   the report.
3. The Research Lab UI renders `DisciplinePanel` (`ResearchLab.tsx:151,181,207,272`)
   and `DriftDeclinePanel` (`:333`) against data that is always `null`.
4. `nfl-research-lab.js:17-24` handles this correctly and for a stated good
   reason: pinning the readers to `-v2` "would have silently dropped that evidence
   from the page, which is worse than not having the new checks at all". The
   reader is right. The gap is that nobody re-ran the labs afterwards.

The fix is a re-run, not a code change. `market_lab.py` and `tree_lab.py` are the
two that touch `data.sqlite`, and a live T-60 capture runner is currently active on
port 5177 — both open the DB `?mode=ro` with `BEGIN`, so a re-run is safe, but it
should be scheduled deliberately rather than during capture.

---

## 4. Answers to the focus questions

**What each module does.** Section 2. Briefly: `market_lab` = pilot movement
regression; `tree_lab` = three targets × seven families + ranker + anchored logit;
`expert_selector_lab` = simplex-constrained conditional stacker over experts;
`book_lag_lab` = cross-book lead/lag, next-move, time-to-follow, delay survival;
`drift` = distributional drift with an NFL-calibrated reference; `leakage` =
single-feature label-copy detector; `model_discipline` = pre-fit
observation-to-parameter check; `betting/nfl/dataset.py` = the extracted shared
chronology nobody imports.

**What they found.** Three complete negatives and one positive. Market-lab: no
edge, `no_move` wins spreads outright, totals selection significantly worse than
doing nothing. Tree-lab: nothing beats the market on cover log loss, the quantile
branch picks `market_only` in 5 of 6, the ranker loses money, the anchored logit
selects shrinkage 0.0 (= take the market). Expert-selector: no configuration beat
both baselines on any substrate on either metric; seven were significantly worse.
Book-lag: claims 8 of 8 — see D-04b/D-06, the claim does not hold. The one
positive is `role-scenario-lab`, holdout-confirmed on touches, and it is a fantasy
result, not a betting one.

**Is any result consumed by the Node app?** Only for display. `nfl-research-lab.js`
reads all five reports and exposes them through one route
(`server/routes/nfl-market.js:33`) to one page (`ResearchLab.tsx`). No prediction,
pick, staking or prop path imports any of it. The two files in scope that *do*
reach a decision are `analyst-notes-2026.json` and `draft-audit-signals-2026.json`,
both via `draft-assist.js`, both on the fantasy side.

**Was preregistration honoured?** Ordering and form: yes, all four labs, verified
against the frozen artifacts. Substance: two real gaps — a declared trial that was
never run and never reported as un-run (D-08), and a declared objective that
differs from the implemented one (D-10). Plus one disclosed post-hoc metric
addition, and no lab records superseded runs of the same protocol (D-03).

**Is the leakage guard real?** Yes — it runs on real data, it reuses the
experiment's own folds, it is proven against a synthetic leak, and it found
nothing on a target whose maximum single-feature R² is 0.0091. But it is narrow by
construction (it can only catch an approximate label copy, as its own docstring
says at :19-24), and it covers 7 of the roughly 14 fitted target/market/season
combinations — not "every experiment" (D-05). The more serious point is that the
*other* two guards that were supposed to complement it, `model_discipline` and
`drift`, have never run at all (D-01) — and one genuine label-construction leak
(D-06, book_lag_lab's forward-filled next-move label) sits in a lab that no
leakage scan covers.

---

## 5. Suggested order of work

1. **D-06 + D-04b** — correct book_lag_lab's label and its verdict arithmetic,
   then re-run. Its published headline is currently the only positive claim in the
   suite and it is not supportable.
2. **D-07** — re-run `role-scenario-lab` against `nfl_player_week_features`. One
   query change confirms or kills the only holdout-confirmed result in the set.
3. **D-01** — re-run all four labs so `model_discipline` and `drift_scans` land in
   a frozen report. 1,243 lines of guard machinery currently produce nothing.
4. **D-02/D-04** — take TPOT out of `min(scores, ...)`, or score it under nested
   CV. It changed the selected model in 10 of 18 cells across two labs.
5. **D-05, D-09** — scan the remaining targets; make `key_number_push_mass`
   market-aware.
6. **D-08, D-10** — run the declared cover trial (or record why not); reconcile
   `sum` vs `mean` in the declared objective.
7. **D-26/D-27** — adopt `dataset.py` in both labs and make the parity test import
   the labs. Until then the duplication warning in every tree-lab report is
   accurate and the shared module is dead weight.
8. Fantasy-side, lowest cost / highest relevance this week: surface the
   `realized_vorp_plus_per_pick` fallback in `realizationFor`, and stamp
   `analyst-notes-2026.json` with its horizon.
