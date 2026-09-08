# NFL market research lab

Read `docs/NFL_RESEARCH_MASTER_PLAN_2026_09_08.md` first. This is an offline research worker, independent of the web server and production model registry.

Use an isolated Python 3.11–3.13 environment, install `research/requirements.txt`, then:

```sh
python research/market_lab.py --db /absolute/path/to/server/data.sqlite --output /absolute/path/to/server/data/market-lab --tpot-minutes 0.5
```

The TPOT limit is **per outer fold and market** (six searches; three minutes requested search time for 0.5). Training, imports and final refits add overhead. Omit TPOT for a quick four-baseline run. Do not run concurrent workers against the same output directory. The worker opens SQLite read-only, extracts a consistent dataset, then releases it before fitting.

Every run keeps `preregistered.json`, `dataset.json`, report, per-fold predictions, selected model files and attempted TPOT pipelines. `latest.json` is the UI pointer. No files are loaded as executable models by the server, and no production pointers or bets are written. Joblib artifacts are local trusted research outputs only; never load untrusted model files.

The current dataset is reconstructed from past closing/opening quotes and conservatively lagged outcomes/play-by-play. Publication revisions, real fills and access are not known. ROI is an indicative historical paper simulation at archived prices. All 2022–2025 seasons have previously been explored and are permanently labeled development data.

The initial runner tests a small generic feature set and selects on inner MAE. It does not implement the full book-response, role-state, news-impact or execution-model program. See the master plan for those bounded agent assignments.

## Package B: `book_lag_lab.py` — who moves the price, and who follows

Unlike `market_lab.py`, this one does not query `data.sqlite` itself. It reads a
FROZEN Package A evidence dataset (`npm run build:evidence-dataset`, which
writes under `server/data/evidence-datasets/<hash>/`) so it inherits Package
A's chronology guarantees instead of re-deriving them:

```sh
npm run build:evidence-dataset   # once, or whenever you want a fresher tape
python research/book_lag_lab.py \
  --dataset-dir /absolute/path/to/server/data/evidence-datasets \
  --output /absolute/path/to/server/data/book-lag-lab
```

No new Python packages are required beyond `research/requirements.txt`
(scikit-learn/numpy, already pinned there). `--dataset-hash` pins a specific
frozen dataset instead of following `evidence-datasets/latest.json`.

Every run writes `preregistered.json` (the declared hypothesis, scope, split
policy and failure criteria, written **before** any model is scored),
`lead_lag_matrix.json` (a descriptive, symmetric book-relationship map — no
book is hardcoded as the sharp reference), `trials.json` (every model fit,
including the ones that lost to baseline), `panel_summary.json`, and
`report.json`. `latest.json` is the UI pointer, in the same shape convention
`server/services/nfl-research-lab.js` already uses for `market_lab.py`.

Read the module docstring in `book_lag_lab.py` before touching it — it
explains, with the numbers behind each decision: why a Hawkes/marked-
point-process model is explicitly NOT attempted against the current tape
(checked fresh every run by `hawkes_feasibility()`, not assumed), why the
plan's 5s/30s/2m/10m execution-delay buckets are produced by extrapolating a
fitted continuous-time hazard rather than replayed (the tape's own native
poll cadence is coarser than all four), and why the cross-validation split is
`GroupKFold` on the game rather than the plan's requested chronological
week-embargoed split (the tape currently spans one NFL week — there is no
second week yet to hold out).

Run `python -m unittest research/test_book_lag_lab.py` (or
`python -m unittest discover research`) to exercise the pure logic — panel
construction, forward-fill staleness, lead/lag crediting, the Hawkes go/no-go
check, and the hazard-to-survival extrapolation — against small synthetic
panels, independent of the real database.

## tree_lab.py — the extended tree/TPOT factory

`tree_lab.py` is a sibling script, not a replacement: `market_lab.py` and its
`server/data/market-lab/` report are untouched and keep working. Run it the
same way, against the same database, writing to a different output directory:

```sh
python research/tree_lab.py --db /absolute/path/to/server/data.sqlite --output /absolute/path/to/server/data/tree-lab --tpot-minutes 1.5
```

Install `lightgbm`, `xgboost` and `catboost` from `research/requirements.txt`
alongside the existing pins (all three installed and fit cleanly in testing;
no extra system OpenMP setup was needed here, unlike the TPOT pilot's earlier
note about that dependency).

What's different from the pilot:

- **Three targets, not one**, all built from the same extended, decision-time-safe
  dataset (`tree_lab.build_dataset`, a close relative of `market_lab.build_dataset`
  — see that function's docstring for exactly why it is a second extractor
  rather than a shared import, and the risk that creates): opening-to-closing
  **movement** regression (reproduced here for a fair same-features comparison
  against the pilot), **cover/over** classification, and **quantile** regression
  of the market residual (`outcome` = how many points the pregame favorite/Over
  side beat the opening number by; its sign is the cover/over label, push
  excluded; the value itself is the quantile target).
- **Six-plus families per target**: the pilot's ridge/HistGB/ExtraTrees, plus
  LightGBM, XGBoost and CatBoost, plus a genuine **market-only baseline** in
  every single comparison (de-vigged opening price for classification/logit,
  empirical training-set quantiles for the quantile branch, `no_move` for
  regression) and a `coin_flip` sanity check for classification.
- **The five specified residual interactions** (market movement × QB
  uncertainty, O-line continuity × opponent pressure, pace × pass catchers,
  forecast revision × stadium exposure, rest/travel × game time), each built
  as an actual feature column — see `build_dataset`'s inline comments for the
  exact proxy used and why (this project has no per-player roster/snap feed
  wired into this extractor, so 1–3 are explicit proxies from available
  team-week aggregates, not confirmed personnel data).
- **Missingness flags and age-of-information features** for every lagged
  input (`*_available`, `*_age_days`), following the same convention the
  pilot already used for its smaller feature set.
- **A ranker branch** (`LGBMRanker` over per-(game,side) opportunities),
  evaluated by real paper ROI on the top-3 ranked picks per week — NDCG is
  reported alongside it, explicitly labeled informational-only.
- **A market-anchored logit branch**: `logit(p) = logit(p_market) + shrinkage
  * (logit(p_hat) - logit(p_market))`, with `shrinkage` chosen by INNER
  chronological cross-validation log-loss before the outer test season is
  scored — the exact leakage risk the master plan calls out by name.
- **Quantile coherence and key-number diagnostics**: a violation check (a
  higher quantile predicting a lower value), reported raw and after a
  monotonic sort; held-out coverage calibration; an empirical key-number
  push-mass histogram (computed from training rows only) showing the real
  spike at margins of 3, 7, 10, etc.
- **A leakage scanner** (`leakage.py`) that fits a single-feature model per
  column, per chronological fold, and flags any feature whose out-of-fold
  skill is implausibly close to perfect. It runs against the real dataset on
  every experiment (see `leakage_scans` in the report) and is proven against
  a synthetic injected leak in `test_tree_lab.py`.

**What this does not do**: no TPOT search for the quantile branch (TPOT has
no built-in multi-quantile pinball objective; building a bespoke one was out
of scope for this pass). No nfelo-based forecast-revision feature (this
project's nfelo vintages are not yet verified as true opening-time snapshots;
see the master plan's Package A audit). No shared multitask model between
spreads and totals (the master plan says to prove single-market value first).

**Report schema**: `tree-lab-v1`, written to `server/data/tree-lab/latest.json`.
This is a genuinely different shape from `market-lab-v1` (three targets and
six-plus families per market/season do not fit `{market, folds, candidates}`),
so it is a new file rather than a breaking change to the existing one.
`server/services/nfl-research-lab.js` reads both and exposes them side by
side as `experiment` (pilot) and `tree_experiment` (extended); the Research
Lab UI renders both as separate sections.

Run `python -m unittest test_market_lab test_tree_lab` from `research/` before
trusting any change to either script.

## Package F: `expert_selector_lab.py` — a selector that learns when experts are useful

```sh
python research/expert_selector_lab.py \
  --db /absolute/path/to/server/data.sqlite \
  --oof-dir /absolute/path/to/server/data/expert-selector-lab/oof-source/<run_id> \
  --output /absolute/path/to/server/data/expert-selector-lab
```

No new Python packages: it uses numpy plus `scipy.optimize` (already present
via scikit-learn). Report schema `expert-selector-lab-v1`, surfaced by
`server/services/nfl-research-lab.js` as `expert_selector_lab`.

**The Level-1 meta-learner** is the constrained form
`docs/MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08.md` part 2.6 names as its single
highest-leverage adoption — a non-negative ridge whose coefficients sum to 1:

```
min_b SUM_i (y_i - SUM_j b_j yhat_ij)^2 + alpha * SUM_j b_j^2   s.t. b_j >= 0, SUM_j b_j = 1
```

That makes it a bounded weighted average: it cannot subtract one expert from
another or invent a leveraged coefficient, so one expert going haywire on one
game cannot drag the blend outside the envelope of the experts themselves
(`test_expert_selector_lab.py` proves both properties). A market-only expert
competes on equal terms and may take weight 1.0 — "trust nothing here, take
the market" is a selectable outcome, not the absence of one.

**The out-of-fold prerequisite.** The master plan says F depends on C/D/E
producing frozen out-of-fold outputs. Checked on disk rather than assumed,
that was only partly true, so this lab uses two substrates with *separately
reported* guarantees:

- **`tree`** — `tree_lab.py` gained an `emit_oof()` that PERSISTS the per-row,
  per-candidate held-out predictions it already computed and then discarded.
  Nothing is refit and no model is scored on its own training rows: every
  expert was fit on seasons strictly earlier than the one it predicts, with a
  seven-day settled-label cutoff. Regenerate with
  `python research/tree_lab.py --db ... --output <dir>/oof-source --tpot-minutes 0`.
  TPOT is excluded as an expert on purpose: its selected pipeline is a
  different architecture in every fold, so it has no stable identity for a
  weight to attach to.
- **`council`** — `nfl_weekly_expert_examples` (28,723 labeled rows, 20
  experts, 831 games, 2022–2025). These are **retrospective backfills**: rows
  written 2026-09-01/02 while their `evidence_cutoff` is the historical
  kickoff. Cutoff-*simulated* walk-forward, not frozen-at-decision-time. Any
  council component whose own artifact was fitted on full history leaks here.
  Stated on every council result rather than buried.

`nfl_expert_forward_predictions` is the architecturally correct artifact —
append-only, immutability-triggered, captured before kickoff — but it holds
672 rows from a single unplayed week with **zero settlements**, so it can
train nothing today. It becomes the right substrate the moment weeks settle.
Packages D and E contribute no expert at all: D persisted only a manifest, and
E has never been run (a real run costs LLM API money).

**Relationship to the production coordinator.** This does not duplicate
`server/services/nfl-expert-coordinator.js`, which already does walk-forward
per-expert shrinkage, correlated-family clustering and Shapley attribution.
The coordinator's `k` is one *global* number per expert — shrink it to zero and
that expert is silent in every context forever. This lab asks whether weight
should change *with the situation*, and benchmarks the conditional gate against
the coordinator's own blend as a competing expert.

**Result: negative, and that is a complete Package F outcome.** No
configuration — global stacker, or a mixture-of-experts gate on disagreement,
coverage or week at 2 and 3 bins — beat BOTH the market-only and static
equal-weight baselines with a week-clustered interval excluding zero, on any
substrate, on either the declared MAE metric or the secondary MSE one. On the
council substrate the selector's MAE was 9.63/9.30/9.97 points against the
market's 9.49/9.29/9.99. Several configurations were *significantly worse*
than simply taking the market. Read `preregistered.json` (written before any
scoring) and the `verdict` block in `report.json` for the exact rule and the
per-fold numbers.

Run `python -m unittest test_expert_selector_lab` from `research/` before
trusting any change.
