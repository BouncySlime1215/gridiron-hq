# N11 — Genetic Programming Feature Discovery / Symbolic Regression (bucket: new)

## Repo grounding (read-only checks against fantasy-football-dashboard)

- Gridiron already runs TPOT (genetic-programming-based pipeline search AutoML) in `research/tree_lab.py`
  (1123 lines) and its predecessor `research/market_lab.py`. TPOT is installed as `TPOT-1.1.0` in
  `research/.venv` (the modern unified TPOT — `EpistasisLab/tpot2` was merged into mainline TPOT as v1.0+
  and the standalone `tpot2` repo is now marked DEPRECATED on GitHub). Trial artifacts already exist:
  `server/data/market-lab/20260908T152845Z-334b4b45/*-tpot-trials.json` and
  `server/data/tree-lab/20260908T164200Z-2e46b49a/*-tpot-trials.json`.
- No `gplearn`, `PySR`, or `symbolic` regression string appears anywhere in the codebase (`grep -rn
  "gplearn|PySR|symbolic"` across `.py`/`.js`, excluding `node_modules`/`.venv`, returns nothing except the
  TPOT trial-file names). Confirmed: genetic-programming **feature discovery / symbolic regression** is a
  genuinely new capability, distinct from TPOT's pipeline search. TPOT searches over fixed sklearn
  operators/hyperparameters; gplearn/PySR/FEAT search the space of mathematical *expressions* built from
  raw features — a different (and complementary) tool.
- `research/tree_lab.py` already has real anti-overfitting infrastructure that a GP tool would plug into
  directly:
  - `research/leakage.py` — `detect_feature_leakage`, run against every feature set before it's trusted.
  - `research/model_discipline.py` (539 lines) — `effective_observations()` and `check_fold()` compute a
    fold's *true* independent-observation count (e.g. "a 660-row fold with 40 positives has 40
    observations, not 660"; quantile branches get ~10% effective mass at the extreme tau). This is the
    exact machinery a GP search's multiplicity needs to be checked against.
  - `research/drift.py` — `scan_lab_fold`, already wired into the report.
  - `time_folds`/`FrozenTimeCV` from `market_lab.py` — walk-forward, season-boundary-respecting CV, never a
    random split.
- Row-count / sample-size reality check (why this matters for the "does GP overfit at this N" question):
  `build_dataset` in `tree_lab.py` pools `game_lines` rows filtered `season<=2025`, evaluated per season
  2023/2024/2025 — i.e. roughly 270 games/season, a few hundred to ~1,000 pooled rows for the game-level
  markets (spreads/totals movement, cover). That is a *small-N* regime by any AutoML-benchmark standard
  (see SRBench numbers below, real-world PMLB sets run 47–1,000,000 rows; Gridiron's game-level tables sit
  at the low end). Player-props tables (`server/services/nfl-props-player-features.js`,
  `nfl-props-player-features-weekly.js`) and the fantasy weekly feature store
  (`server/services/nfl-weekly-feature-store.js`) are player-week granularity — thousands of rows across
  seasons — a meaningfully larger and more GP-tractable sample.
- `server/services/nfl-ensemble.js` (1423 lines) is confirmed present; FOUND's blend defect is real code to
  attach a fix to. `server/services/nfl-team-strength.js` and
  `server/betting/nfl/strategy/teaser-leg-rates.js` also confirmed present.
- `251,591 rows of play-by-play` (per FOUND) — did not re-derive this number myself (READ-ONLY constraint,
  no DB queries beyond schema-level grep), taking it as given from tonight's findings; `nfl-features.js`
  (514 lines) is the hand-built feature extractor FOUND says is the only consumer of that table.

## Primary sources (read in full where marked)

### 1. La Cava et al., "Contemporary Symbolic Regression Methods and their Relative Performance" (SRBench), NeurIPS 2021 Datasets & Benchmarks Track. arXiv:2107.14351. **Read in full (ar5iv full text).**
- 14 symbolic-regression methods + 7 ML baselines (incl. XGBoost, LightGBM, random forest) across 252 PMLB
  datasets: 122 synthetic ground-truth problems + a mix of real-world "black-box" sets (46 of them ranging
  47–1,000,000 rows, 2–124 features).
- Ground-truth recovery (zero noise): AIFeynman recovers the exact equation 53% of the time — nearly double
  the next best (GP-GOMEA, 27%). But **that advantage disappears above 0.01 noise**, where GP-based methods
  (DSR, gplearn, AFP_FE, AFP) take over. This is the single most load-bearing number for Gridiron: NFL
  betting/fantasy features are noisy, not clean-physics data, so the noise-robust GP family — not the
  noise-fragile deep-learning-in-symbolic-form methods — is the right class of tool to even consider.
- On real-world black-box data: Operon (a GP-based method) produces significantly more accurate models than
  every other method on test-set R² (p ≤ 6.5e-05), while producing models 1–3 orders of magnitude smaller
  than gradient boosting. Operon, GP-GOMEA and DSR form the accuracy/complexity Pareto front.
- Honest limitation for Gridiron: SRBench's real-world sets are still mostly hundreds to thousands of rows
  and NOT strongly adversarial/noisy in the way a market-efficient betting line is — SRBench doesn't test
  "is there a real signal here at all," only "given there is one, can GP find a compact form for it."
  Gridiron's betting problem (market already near-efficient, -2.28 CLV, 78% adverse moves) is closer to
  "there may be no signal" than SRBench's benchmark regime. That gap is the honest caveat this candidate
  set has to carry.

### 2. Cranmer, "Interpretable Machine Learning for Science with PySR and SymbolicRegression.jl," 2023. arXiv:2305.01582. **Read in full (ar5iv full text).**
- PySR/SymbolicRegression.jl: multi-population evolutionary GP search with an evolve→simplify→optimize
  loop; scales to thousands of cores.
- Introduces EmpiricalBench: 9 historically-discovered scientific equations (Hubble, Kepler III, Newton
  gravitation, Planck, Leavitt, Schechter, Bode, ideal gas, Rydberg), rebuilt from either original public
  data or literature-typical noise added to a clean generator.
  - PySR recovers 6 of 9 exactly (5/5 seeded trials each) — Hubble, Kepler III, Leavitt, Schechter, Bode,
    ideal gas — and **0 of 5 on Planck's Law and the Rydberg formula**. It is not a universal solver even on
    genuinely clean, historically-real relationships; roughly a third of even favorable physics problems
    fail outright.
  - Explicit author-acknowledged bias: "because we are the authors of PySR, we are ... more likely to be
    running in a stable environment than ... a package which we are unfamiliar with" — a direct admission of
    home-court benchmarking bias to discount when reading any GP tool's own benchmark claims.
  - No systematic noise/sample-size sweep is reported in the paper — a real gap; PySR's own EmpiricalBench
    does not answer "how does accuracy degrade as N shrinks or noise rises," which is exactly the question
    Gridiron needs answered before trusting it on ~270-row seasons.

### 3. Žegklitz & Pošík, "Model Selection and Overfitting in Genetic Programming: An Empirical Study," 2015. arXiv:1504.08168. **Read in full (ar5iv full text).**
- 6 datasets (4 synthetic: Two Spirals 3000 rows, Cluster-in-Cluster 1240, Halfkernel 1200, Sphere 1500; 2
  real: Forest Fires 517, Wisconsin Breast Cancer 569), 70/30 split, 96 runs/dataset, comparing standard GP
  against validation-set methods (Backwarding, Validation Start) and random-sampling variants (RST,
  Random Interleaved, VRST) meant to control overfitting.
- **Headline honest result**: plain, unmodified GP with model selection on the full training set matched or
  beat every fancier overfitting-control variant on every dataset (e.g. Two Spirals: median test error
  0.326 standard vs 0.325 best RST variant — statistically indistinguishable). The authors' conclusion is
  explicit: technique effectiveness is "highly data dependent," and none of their overfitting-avoidance
  machinery reliably outperforms the naive approach.
- Direct implication for Gridiron: don't buy a fancy overfitting-control scheme on faith — the deciding
  factor is a correct, held-out, chronologically-frozen evaluation (which `tree_lab.py`'s `FrozenTimeCV`
  and `model_discipline.py` already provide), not the specific GP internals.

### 4. La Cava, Singh, Taggart, Suri, Moore, "Learning Concise Representations for Regression by Evolving Networks of Trees" (FEAT), ICLR 2019. arXiv:1807.00981. **Read in full (ar5iv full text).**
- 100 PMLB regression datasets, 60-minute compute budget/dataset. FEAT vs XGBoost: statistically
  indistinguishable top predictive performance (p = 1.0), but FEAT's models are within 1 order of magnitude
  of the size of plain ElasticNet and 2–4 orders of magnitude smaller than XGBoost/RF/MLP (p < 1e-16).
- No sample-size-stratified breakdown is given (an explicit gap noted on inspection) — same honest caveat as
  source 2: none of the flagship symbolic-regression benchmarks directly answers "what happens at N≈300."

### Supporting / secondary evidence (searched, not fetched in full — flagged as such)
- Allen & Karjalainen (1999), *J. Financial Economics* 51(2):245–271, "Using Genetic Algorithms to Find
  Technical Trading Rules": the canonical result that GP-discovered S&P 500 trading rules showed some
  in-sample predictive ability but were **outperformed by simple buy-and-hold out-of-sample after
  transaction costs** — the closest real-world analogue to "GP search against a near-efficient market,"
  which is exactly Gridiron's betting-model situation (zero edge vs. the close). Not fetched in full (paper
  is paywalled/PDF-scan); cited via secondary summaries and consistent across multiple independent
  descriptions.
- White (2000), *Econometrica* 68(5), "A Reality Check for Data Snooping": the formal statistical test for
  correcting significance when many trading rules/strategies have been searched — directly relevant to any
  GP search's multiplicity problem, and to FOUND's separately-flagged missing trial registry. Not fetched in
  full (paywalled).
- Zhang, Chen, Xue, Banzhaf, Zhang, "Sharpness-Aware Minimization for Evolutionary Feature Construction in
  Regression," 2024, arXiv:2405.06869: 58 real-world regression datasets, GP feature construction augmented
  with a sharpness-reduction term beats plain GP and 6 complexity-control baselines, explicitly targeting
  "limited number of instances" regimes — read at abstract depth only (not marked read-in-full); cited as
  the most current pointer toward small-sample-safe GP feature construction, worth a deeper read before
  actually building candidate C1 below.

## GitHub repos (metadata pulled live via `gh api`; one shallow-cloned and inspected)

- **trevorstephens/gplearn** — 1,885 stars, BSD-3-Clause, pushed 2026-08-14 (actively maintained).
  Shallow-cloned to `github/trevorstephens__gplearn` (5.0MB, no node_modules/venv). Inspected
  `gplearn/genetic.py` directly: `SymbolicRegressor` (line 605) and `SymbolicTransformer` (line 1206) both
  subclass scikit-learn mixins (`RegressorMixin`/`TransformerMixin`) with a standard `.fit(X, y)` API —
  drops into `tree_lab.py`'s existing `make_pipeline`/`StandardScaler` pattern with no adapter code.
  `parsimony_coefficient` (default 0.001, constructor line 182) is a first-class complexity penalty — the
  practical anti-overfitting knob the Žegklitz/Pošík honesty check says matters more than exotic validation
  schemes. **Adopt: call** (pip-installable, pure Python/Cython, no external solver).
- **astroautomata/PySR** (formerly MilesCranmer/PySR) — 3,756 stars, Apache-2.0, pushed 2026-09-11 (this
  week). Requires a Julia backend (SymbolicRegression.jl) — heavier install than gplearn, higher-ceiling
  search (distributed, SIMD-fused operators) but more infra to babysit next to a live game-capture process.
  **Adopt: call, but only as an offline/monthly deep-audit tool**, not wired into the weekly research-lab
  run, given the install footprint and the READ-ONLY-repo mandate against disturbing the live server.
- **cavalab/feat** — only 38 stars, GPL-3.0, last pushed 2025-03-07 (stale ~18 months). Academically
  well-documented (ICLR 2019 paper, source #4 above) but thin community/maintenance signal.
  **Adopt: reference-only** — read the paper's method, don't take a maintenance dependency on the repo
  itself; gplearn covers the same conceptual ground (evolved-tree feature transformer) with 50x the stars
  and current commits.
- **cavalab/srbench** — 319 stars, GPL-3.0, pushed 2026-08-13 (active). Not a library to depend on in
  production; **adopt: reference-only** as the evaluation-methodology template (how to honestly score a
  symbolic-regression method against ground-truth vs. black-box splits) if Gridiron ever wants to compare
  gplearn vs. PySR vs. plain HistGB itself.
- **EpistasisLab/tpot2** — 250 stars, LGPL-3.0, explicitly marked DEPRECATED (merged into mainline
  `EpistasisLab/tpot` as v1.0+, which is what Gridiron's `TPOT-1.1.0` already is). **Adopt: avoid** — nothing
  to do here, Gridiron is already past this fork; noted only to close the loop on "is there a newer TPOT to
  adopt" (no — already on it).

## Candidates

See structured output. Summary of the mix: 2 fix-tagged (ensemble blend, team-strength blend) directly
naming a FOUND defect where GP/symbolic search is genuinely the right tool class; 1 fix-tagged governance
candidate (permutation-null + multiplicity gate) that patches the missing-trial-registry defect specifically
for this new tool class; 4 new-capability candidates (game-level feature discovery in tree_lab.py, fantasy
weekly-feature discovery, play-by-play aggregate feature discovery, PySR as an offline interpretability
audit) that Gridiron has no equivalent of today.

## Do-not-do list (see structured output `do_not_do`)
