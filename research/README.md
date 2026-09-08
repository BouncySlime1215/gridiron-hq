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
