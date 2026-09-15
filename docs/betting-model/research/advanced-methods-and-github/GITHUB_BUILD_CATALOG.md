# GitHub Build Catalog — Gridiron Research Session, 2026-09-12

Source: 10 GitHub-fix (GF01–GF10) and 10 GitHub-new (GN01–GN10) researcher notes, plus
repos independently surfaced inside the F01–F18 and N01–N18 paper-based notes. Every repo
below was cloned (`--depth 1 --filter=blob:none`) or inspected via `gh api` file contents —
none judged by README alone; researchers report reading actual source files, with line
numbers, in essentially every row. `node_modules`/`venv` checked and absent in all clones.

Legend — **Adopt**: `port` (small, permissively-licensed, transcribe into Gridiron's
Node/JS or research/Python) · `call` (pip/npm-install and invoke as a dependency or offline
batch job) · `borrow-idea` (reimplement the method/pattern from scratch, not the code —
usually a license or language-mismatch reason) · `reference-only` (read for correctness-
checking or design inspiration, never touches Gridiron) · `avoid` (checked and rejected).

---

## Table 1 — FIX bucket (repos cited to correct an already-verified Gridiron defect)

| Repo | ★ | License | Last commit | What it actually does (verified in code) | Adopt | Exact Gridiron attachment | Effort |
|---|---|---|---|---|---|---|---|
| rtelmore/NFLSimulatoR | 19 | MIT-family | 2026-06-30 (active) | R drive/possession resampler; `sample_drives.R:82` does `new_yfog <- 100 - new_yfog` — the turnover field-position mirror, applied at one shared drive-boundary point | borrow-idea | `nfl-drive-sim.js:345-346` — add the same one-point flip to the shared turnover-return branch | hours |
| tim-foldy-porto/nflsim | 2 | none declared | 2026-07-26 (active) | From-scratch Python engine; `rules.py:184-201` independently confirms the same turnover-flip math; `clock.py` keeps one canonical `(quarter, quarter_seconds_remaining)` pair, never a raw seconds/denominator split; `transition_quarter()`/`_halftime()` are one shared state machine for fresh and resumed games | borrow-idea | `nfl-drive-sim.js` clock plumbing (defect 2) and `simulateRemainder()` (defect 6 — no second, simplified copy of the game loop) | days |
| martineastwood/penaltyblog | 220 | MIT | 2026-09-10 (active) | `ratings/elo.py`: HFA stored as continuous Elo points added to the home rating *before* the win-probability draw, never a post-hoc score bump; also ships 7 devig methods behind one dispatcher (`implied/implied.py`) and a `Backtest`/`Account` walk-forward pair with a structural `lookback < date` slice | call / port | `nfl-drive-sim.js:562` (HFA architecture); `nfl-devig.js` (7-method dispatcher pattern); replacement for the 5-7 duplicate audit engines | hours–days |
| traskcon/Monte-carlo-NFL | 3 | none declared | 2025-09-11 | Python MC sim; `__turnover()` couples the field-position flip and the possession swap in **one** function/statement pair, so you cannot flip one without the other | borrow-idea | Refactor pattern for `nfl-drive-sim.js`'s turnover branch (defect 1) | hours |
| nishs9/nfl-simulation-engine | 0 | MIT | 2026-02-11 | Flask/React sim; keeps `game_seconds_remaining` and `quarter_seconds_remaining` as two always-separate fields, decremented together, reset independently at halftime — exactly the fix for half/full-clock confusion; has NO overtime branch at all (real gap, not just Gridiron's) | borrow-idea | `nfl-drive-sim.js` clock plumbing (defect 2) | days |
| fivethirtyeight/nfl-elo-game | 348 | MIT | 2026-09-05 | Canonical 538 Elo; `HFA=65` Elo pts added to the rating diff pre-game, zeroed for `neutral==1`; MOV multiplier damps for expected blowouts | port | Independent Elo baseline (`nfl-baseline-elo.js`) to sanity-check `nfl-ensemble.js`/`nfl-team-strength.js`; HFA-as-pregame-shift pattern for drive-sim | hours (baseline) / days (HFA refactor) |
| greerreNFL/nfelohfa | 1 | none declared | 2026-09-12 | `BaseHFA.py`: rolling-window OLS + EMA gives a per-week, drifting league HFA level (never a constant); `AdjustedHFA.py` re-zeroes for neutral sites, layers travel/rest | borrow-idea | Replaces `homeFieldPoints=1.6` hard-coded at 3 call sites in `nfl-drive-sim.js` | hours (neutral-site gate) / days (full estimator) |
| nflverse/nfl4th | 22 | MIT | 2026-09-01 | `apply_win_prob.R`: `posteam_timeouts_remaining`/`defteam_timeouts_remaining` are required, per-play, decrementing WP-model inputs, not a value set once | reference-only | `nfl-drive-sim.js:453/461` — wire `simulateDrive`'s return to actually decrement the outer `timeouts` map | hours |
| nflverse/nflfastR | 541 | NOASSERTION (no LICENSE) | 2026-08-13 | `MODELS.R`/`helper_add_ep_wp.R`: xgboost WP model, `posteam_spread = if_else(home==1, spread_line, -1*spread_line)` — the exact away-team sign-flip fix; `monotone_constraints` structurally forbid a WP-moves-wrong-direction bug class; hard kneel-play probability override (0/1, no learned guess); explicit two-regime (pre/post-2012) OT branch with a forced terminal 0/1 state | borrow-idea (reimplement formulas — no redistribution license) | `nfl-live.js`/`nfl-sim-policy.js` away-spread bug; `nfl-drive-sim.js` kneel-inversion and missing-OT-regime bugs | hours (spread flip) / days (kneel override, OT regime) |
| greerreNFL/nfelo | 56 | none declared | 2026-09-11 | `offseason_regression.py`: per-prior z-score against a trained per-season sigma, then weighted blend with mean-reverted state; `elo_shift.py`: "resist the market" throttle — only speeds up the update when the model was *more* wrong than the market | borrow-idea | `nfl-team-strength.js` preseason/in-season blend (replaces unweighted `?? leaguePrior` fallback) | days |
| greerreNFL/nfelosrs | 8 | none declared | 2026-09-07 | `BayesianRankings.py`: textbook Gaussian-conjugate precision-weighted update run **per game, per team, every week** — prior for week N+1 is week N's posterior, carrying `stdev` as a first-class output | borrow-idea | `nfl-team-strength.js` — add a `teamStrengthWeekly()` recursive updater | days |
| sublee/glicko2 | 124 | BSD-3-Clause | 2026-09-07 | Faithful Glicko-2: `(mu, phi, sigma)` rating/deviation/volatility; `phi` is an off-the-shelf per-team uncertainty estimate | port | `nfl-team-strength.js` sibling `nfl-glicko.js` — first calibrated-uncertainty number on the team-strength inputs | days |
| mberk/shin | 105 | MIT | 2025-10-23 | Closed-form (n=2) and fixed-point-iteration (n>2) Shin solver, Rust-backed; test vectors against a published 3-way soccer market | reference-only (test oracle) | Regression-test fixture for a JS N-outcome Shin port | — |
| neeljshah/shin-devig | 1 | MIT | 2026-07-15 | Pure-Python, zero-dep, ~150 lines implementing multiplicative/additive/power/Shin side by side; independently proves n=2 Shin≡Additive | port | `nfl-devig.js` — add `powerDevig()`; the module Gridiron doesn't have | hours |
| opisthokonta/implied (R) | 9 | none declared | 2026-05-23 | 8-method R reference (incl. `bb`, `or`, `jsd`); confirms multiplicative is the acknowledged worst baseline | reference-only | Literature cross-check for `nfl-devig.js` method selection | — |
| johntwk/Diebold-Mariano-Test | 127 | MIT | 2017-12-07 | ~40-line DM statistic + Harvey-Leybourne-Newbold small-sample correction | port | Replace the ad hoc paired-t at `nfl-ensemble.js:1125-1129` | hours |
| ceweiss/ForecastComb (R) | 28 | GPL(>=2) | 2018-08-04 | Full textbook menu of combination weights (`comb_SA`=equal, `comb_BG`=inverse-MSE, `comb_CLS`, eigenvector weighting, etc.) | reference-only | Confirms `nfl-ensemble.js`'s unused `weighting:'equal'`/`'inverse_mse'` options are real, named, literature-standard methods worth actually benchmarking | — |
| arkhipov/temporal_tables (Postgres ext) | 1,050 | BSD-2-Clause | 2026-01-12 | `versioning()` BEFORE-trigger; retrofit recipe: add a `sys_period` column + history table, no rewrite of the live table | borrow-idea | Pattern (not code — Gridiron is SQLite) for a formal correction/supersession chain on `nfl_quote_tape` | days |
| scalegenius/pg_bitemporal | 163 | BSD-3-Clause | 2021-07-06 (stale) | Full bitemporal (valid-time + system-time) PL/pgSQL framework with correction functions | reference-only | Correction-pattern idea only (new row supersedes, never mutates) | — |
| xtdb/xtdb | 3,061 | MPL-2.0 | active | Full bitemporal Datalog/SQL DB, valid-time and system-time independently queryable | reference-only | Mental model for what `quoteSurface(..., at: atTime)` *should* mean (currently conflates the two clocks) | — |
| mikemiller442/Bivariate_Poisson_Soccer | 2 | none declared | 2020-01-07 | Real, runnable Stan models (`bivariate_poisson_model.stan`) for Karlis-Ntzoufras bivariate Poisson | reference-only | Design reference for F08/N1's dynamic bivariate-Poisson candidate | — |
| renenunezg/momentumnfl | 0 | MIT | 2026-09-10 (active) | NFL-specific, production-shaped: `solve_ridge()` = joint weighted-GLS ridge across all 32 teams at once, exponential recency weighting, versioned recommendation ledger | borrow-idea | Closest external analogue to `nfl-team-strength.js` + `model-governance.js` combined | days |
| Torvaney/mezzala | 40 | Apache-2.0 | 2021-10-19 | Clean composable static Dixon-Coles library (`BaseRate`/`HomeAdvantage`/`TeamStrength` blocks) | reference-only | Architecture reference for decomposing attack/defense/HFA into composable blocks | — |
| itamarsaacks/world-cup-forecasting | 0 | MIT | 2026-09-08 | From-scratch reproduction of Ley/Van de Wiele/Van Eetvelde weighted-MLE bivariate Poisson, independently confirms ~3-year optimal half-life | reference-only | Corroborates half-life-decay design for any refit team-strength model | — |
| LeoEgidi/footBayes | 59 | GPL-2 | 2026-09-09 (active) | `biv_pois_dynamic.stan`: Karlis-Ntzoufras bivariate Poisson + random-walk state-space attack/defense with 3 interchangeable evolution-variance specs (incl. Koopman-Lit) and a spike-and-slab commensurate-prior option; `neg_bin_dynamic.stan` mirrors it with NB overdispersion | port (as offline CmdStan/R sidecar) | `nfl-team-strength.js` (dynamic ratings) and props (NB overdispersion) — posterior exported as JSON, no Stan runtime in Node | days |
| pymc-devs/pymc-examples | 398 | MIT | 2026-09-09 (active) | Canonical Baio & Blangiardo hierarchical-Poisson notebook in current PyMC 5; real `arviz` diagnostic checklist (rhat/energy/hdi) | borrow-idea | Static baseline + `arviz`-style diagnostics Gridiron has none of anywhere | — |
| martineastwood/penaltyblog (Bayesian engine) | 220 | MIT | 2026-09-10 | Hand-rolled differential-evolution ensemble MCMC (Cython), hierarchical prior with learned team variance, Dixon-Coles-weighted NLL; `trace_dict` is plain numpy → trivially JSON-exportable | call | Cheap "always-available" Bayesian tier vs. footBayes's deeper/slower CmdStan tier | days |
| lbenz730/soccer_ha_covid | 13 | none set | 2021-05-28 (stale) | `bvp_goals_lambda3.stan`: shared-intercept Karlis-Ntzoufras construction with an empirical-Bayes pre/post-COVID HFA split — a second, published, independent confirmation of the standard covariance construction | reference-only | Corroborates the shared-intercept-term dependence pattern for teaser/SGP joint scoring | — |
| pjastam/r-bayesian-football-odds | 3 | MIT | 2022-09-02 | JAGS (not Stan/PyMC) hierarchical Poisson, small/educational | reference-only | Excluded on toolkit grounds; confirms the pattern recurs across toolkits | — |
| pmorissette/bt | 2,981 | MIT | 2026-09-12 (active) | `Backtest` deep-copies its `Strategy`, one `Result` object per run; `Node` tree with dirty-flag cache invalidation | borrow-idea | Pattern fix for the 5 duplicate CLV implementations — one ledger node, lazily recomputed, everyone reads it | days |
| mementum/backtrader | 23,238 | GPL-3.0 | 2024-08-19 (dormant) | `Trade` keeps `pnl`/`pnlcomm` as two never-conflated fields; a single `BackBroker` is the sole cash mutator | reference-only (license+dormant) | Design-only fix for CLV sign-convention disagreement | — |
| polakowo/vectorbt | 9,068 | Apache-2.0 + Commons Clause | 2026-08-02 (active) | Every order attempt — filled, ignored, *or rejected* — logged with a `status_info` reason code, one generic `Records` table for orders/trades/logs/drawdowns alike | borrow-idea (schema only) | A `bet_attempts` log with `status ∈ {filled, rejected, no_edge, cold_start_skip}` — fixes both the trial-registry gap and the fantasy cold-start silent skip | days |
| georgedouzas/sports-betting | 787 | MIT | 2026-07-28 (active) | `{provider}__{market}__{status}__{time}` odds-column grammar resolves "latest quote as of a snapshot" deterministically; `BaseBettor.bet()` picks only the highest-edge outcome per `complementary_events` group; `backtest()` is `TimeSeriesSplit`-gated, structurally cannot leak a fold | port | Direct answer to the 5-way CLV disagreement (one long odds table, CLV = closing−opening once) and a free first-cut correlation guard for teaser/same-game legs | days |
| mattymitch499-sketch/nfl-sgp-model | 0 | none declared | 2026-09-10 (active) | Rust research repo: leave-one-out z-standardization, Rüschendorf rank-transform `uniform_scores`, `empirical_joint()` (nonparametric empirical copula), dependency-free `bvn_upper` Genz/Drezner-Wesolowsky quadrature, and a difference-bootstrap transport-validation test with a documented prior false-positive bug fixed | borrow-idea (no license — reimplement from public-domain math) | `teaser-leg-rates.js` team-leg×player-prop extension; `nfl-prop-correlation.js`'s Gaussian copula upgrade path | days |
| sdv-dev/Copulas | 652 | Business Source License 1.1 | 2026-09-07 | Gaussian, Clayton/Gumbel (asymmetric tail dependence), and pure-Python vine copulas | call (offline Python fit → JSON params) | Escalation path once same-game team-leg×prop correlation clears significance | days |
| vinecopulib/pyvinecopulib | 126 | MIT | 2026-09-10 (active) | C++/pybind11 vine-copula engine, automatic family selection (Gaussian/t/Clayton/Gumbel/Frank/Joe/BB1-8) by AIC/BIC per edge | reference-only | "Correct, complete" tool if Gridiron ever needs 3+-leg same-game parlays — not needed for the current fixed 2-leg teaser product | — |
| DanielBok/copulae | 163 | MIT | 2025-02-07 (stale) | Archimedean copulas + an `exchangeability` goodness-of-fit test (`C(u,v)=C(v,u)`) | reference-only | Cheap symmetry check before investing in any full copula fit | — |
| moj-analytical-services/splink | 2,398 | MIT | 2026-09-10 (active) | Fellegi-Sunter probabilistic linkage; graded comparison ladders (exact→Jaro-Winkler tiers) each with a learned m/u weight; `match_weight=Σlog2(m/u)` → calibrated match probability; SQL blocking rules | borrow-idea | `nfl-contract-key.js` `eventKey()`/`contractKey()` — add a hand-tuned (non-EM) confidence score on top of the existing binary fail-closed key | days |
| dedupeio/dedupe | 4,512 | MIT | 2025-07-29 (stale ~13mo) | Active-learning dedup; `canonical.py` collapses multi-spelling duplicates into one crosswalk record | borrow-idea | Replace flat `TEAM_CODE_ALIASES` with a `TEAM_CROSSWALK` (one row/franchise, one column/source) | days |
| J535D165/recordlinkage | 1,062 | BSD-3-Clause | 2023-07-20 (stale) | `SortedNeighbourhood`/`Block` indexers (candidate-pair generation before comparison); `Date` comparator gives partial credit for day/month-swap-style near-misses | borrow-idea | Blocking ahead of any Polymarket-tape↔game join (currently a raw per-row join); graded date comparison for the ET-boundary near-miss in `eventKey()` | hours (blocking) / days (date grading) |
| scikit-learn-contrib/MAPIE | 1,589 | BSD-3-Clause | 2026-09-08 (active) | Full CQR pipeline (`pinball_weighted_mean` fold aggregation), EnbPI/block-bootstrap for time series, real coverage/width scoring | call | Independent Python cross-check for whatever hand-rolled JS conformal code ships against `nfl-ensemble.js`'s ad hoc residual-inflation | hours (isolated `research/.venv`) |
| henrikbostrom/crepes | 582 | BSD-3-Clause | 2026-07-08 (active) | `ConformalRegressor`: sort abs calibration residuals, `alpha_index` formula, Mondrian per-bin variant — ~30-40 lines total | port | `nfl-ensemble.js:207-251` — replaces the ad hoc `disagreement/30` inflation hack with a real split-conformal interval, Mondrian-binned by spread bucket | hours |
| yromano/cqr | 315 | MIT | 2026-02-02 | Official CQR reference: `err=max(y_lo-y, y-y_hi)`, `apply_inverse()` order-statistic — ~15 lines | port | Score formula on top of LightGBM q10/q90 fits in `research/tree_lab.py` | hours |
| aangelopoulos/conformal-time-series | 144 | MIT | 2023-11-30 (unmaintained, canonical) | ACI (`aci_clipped`): online stochastic-gradient correction of the effective miscoverage target — ~20-line update rule | port | Weekly-refit calibration layer once a base conformal interval exists | hours |
| aangelopoulos/conformal-prediction | 1,085 | MIT | 2025-11-14 | ~6-20 line reference snippets: split conformal, CQR, Mondrian/group-balanced, drift-aware | borrow-idea | Cleanest algorithm reference for hand-translating to JS | — |
| marcopeix/conformal-ts | 3 | BSD-3 | 2026-05-17 (active) | Small, unit-tested (`test_nexcp.py` etc.) package implementing split/CQR/ACI/AgACI/NexCP/SPCI behind one interface; exact weight formula `(1-α)(W+1)/W` matches the paper | borrow-idea | Correctness cross-check for a hand-written NexCP JS port | — |
| astrogilda/tsbootstrap | 95 | MIT | 2026-09-07 (active) | EnbPI ensembles + ACI/NexCP as one typed `bootstrap()` entry point | reference-only | Architecturally interesting for the drive-sim Monte Carlo once its physics are fixed — not tonight | — |
| hamrel-cxu/EnbPI | 134 | MIT | 2023-11-25 (rough research code) | Bootstrap-ensemble LOO residuals + sliding-window quantile | avoid (subsumed) | — | — |
| quantskills/skill-backtest-overfit | 34 | GPL-3.0 | 2026-07-16 | Claude-Skill scripts (not a library): `deflated_sharpe.py`, `pbo_cscv.py` (self-tested against known-answer PBO≈0.5-on-noise), `haircut.py` (Bonferroni/Holm/BHY, `norm.sf` underflow-safe) | reference-only (reimplement, GPL) | Formulas feed `research_trial_corrections` (see GF10 schema) | days |
| eslazarev/purged-cross-validation (purgedcv) | 33 | MIT | 2026-09-04 (most active) | `_pbo.py` builds PBO on top of purge/embargo-respecting `CombinatorialPurgedCV`; `_metrics.py`'s `effective_n_trials()` (Geyer 1992 autocorrelation-time correction) — the single most load-bearing function in this survey for an iterative, non-independent 21-model search | port | `research_trial_corrections.effective_n_trials` column | hours–days |
| Aliipou/backtest-audit | 7 | none declared | 2026-05-17 | `overall_risk_score()`: maps PASS/WARN/FAIL to a continuous risk score for `position_size = base*(1-risk)`; flat-file `(test,metric,value,verdict)` audit rows | reference-only (no license) / borrow-idea | Staking-guardrail risk-score convenience column; audit-row shape | — |
| mnemox-ai/deflated-sharpe | 7 | Apache-2.0 | 2026-03-21 | Pure-Python DSR via a **different** (Gumbel closed-form) `E[max SR]` approximation than purgedcv/quantskills — a real, literature-level instance of the "5 disagreeing implementations" failure pattern, one repo over | avoid (this formula) / reference-only (BH-FDR fn) | Confirms which DSR formula NOT to standardize on; pins `dsr_method` as an explicit enum | — |
| nishs9/nfl-simulation-engine-lite, GallagherAiden/footballSimulationEngine, dlm1223/nfl-simulation, RobbyGillespie/Optimal-NFL-Play-Simulator, nflverse/nflseedR | — | — | — | Checked and rejected: soccer-physics engine, garbage-time-excluding sample, no clock/kneel/OT logic, season-only (not drive-level) simulator | avoid | — | — |

## Table 2 — NEW-capability bucket (repos for capabilities Gridiron has none of today)

| Repo | ★ | License | Last commit | What it actually does (verified in code) | Adopt | Exact Gridiron attachment | Effort |
|---|---|---|---|---|---|---|---|
| amazon-science/chronos-forecasting (Chronos-2) | 5,847 | Apache-2.0 (code+weights) | 2026-09-08 (active) | `Chronos2Pipeline.predict(cross_learning=True)`: group-attention in-context learning across a batch of short, related series; native covariate + multivariate + first-class DataFrame API | call | Weekly batch job over all 32 teams' scoring-differential panels or player-usage panels — best-fit foundation model for Gridiron's short (~18-pt), wide (32-team) panels | days (pilot) |
| google-research/timesfm (2.5 / 3.0) | 32,305 | Apache-2.0 (code); weights Apache-2.0 through v2.5, **non-commercial** for v3.0 | 2026-09-09 (active) | `xreg_lib.py`: in-context regression blending a foundation forecast with named covariates (`"timesfm+xreg"`/`"xreg+timesfm"`); 3.0 adds native multivariate-with-covariates | call (2.5) / borrow-idea (3.0 arch) | Alternative XReg-blend for `nfl-team-strength.js`; native-multivariate pilot for same-game leg correlation | days |
| SalesforceAIResearch/uni2ts (Moirai) | 1,590 | Apache-2.0 | 2026-06-02 | Any-variate attention (arbitrary covariate count), 4-component mixture output (Student-t/NB/log-normal/normal) — natively probabilistic, not point | call | Second TSFM candidate; mixture output is directly reusable as a calibrated-uncertainty check | days |
| time-series-foundation-models/lag-llama | 1,602 | Apache-2.0 | 2025-06-06 (15mo stale) | Decoder-only, lag-indexed tokenization requiring an L-sized (up to 52-week) context window by construction — cannot even accept a single team-season | avoid | — | — |
| joewilaj/nbaGNNs | 10 | MIT | 2021-07-04 (stale) | 62-node (32 teams×2) Offense/Defense graph + separate Vegas-spread graph, node2vec embeddings, 4 GNN layer choices (spektral); a second discriminator GIN model learns "trust the model vs. the market" from the first model's own historical error pattern | borrow-idea | 64-node weekly offense/defense graph from `player_week_usage`+`nfl_snaps`; the discriminator idea is a template for a learned governance gate | weeks |
| stevenbliu/Project-NBA-Rankings-Prediction | 4 | NOASSERTION | 2025-12-09 | Vendors real GraphSAGE (Hamilton et al. 2017); team-vs-schedule graph, node classification on final rank; **also contains a leaky from-scratch GCN side-path (no train/test split) whose "~88% accuracy" must not be cited** | call (GraphSAGE) / avoid (the leaky GCN claim) | Team-week node-classification framing for `nfl-team-strength.js` | weeks |
| sanjeevnara7/FootballPassPrediction | 41 | MIT | 2024-04-30 (active) | Per-frame spatial graph, GATv2/GAT/GCN/GCN2 with a distance-decayed edge feature (`exp(-(d/25)²)`) — needs x/y tracking Gridiron doesn't have | reference-only | Forward-looking template if/when Next Gen Stats tracking is ever ingested | — |
| juancamilocampos/nfl-big-data-bowl-2020 | 12 | none declared | 2022-09-13/2023-03-25 | Interaction-Network (EdgeBlock→NodeBlock) rusher-vs-defenders graph; CRPS-scored, reached top-3% of the 2020 Kaggle leaderboard using only the rusher-vs-defenders subgraph | reference-only | Same forward-looking status — needs tracking data | — |
| UnravelSports/unravelsports | 247 | MPL-2.0 | 2026-01-16 (active) | Kloppy-format multi-provider tracking ingestion, incl. NFL Big Data Bowl | avoid | Needs tracking data Gridiron doesn't have | — |
| SumerSports/SportsTrackingTransformer | 49 | none declared | 2025-11-06 | Self-attention over an **unordered set** of 22 tracking-frame players, no positional encoding (permutation-equivariant by design); beats a Zoo-CNN baseline 20.2%/75.9% ADE on their own held-out set | borrow-idea (technique, not the model — no tracking data) | The unordered-set-attention idea for a per-play formation/personnel flag-set token (nested inside a drive transformer) | — |
| ebrown-32/Deep-Learning-NFL-QB-Stat-Predictor | 0 | none declared | 2025-01-17 | Genuine temporal transformer over a **play sequence**: linear embed → `TransformerEncoder` → learned positional + attention-pooling → identity embeddings concatenated post-pool → multi-task heads; 18 input features near-1:1 with Gridiron's own PBP+formations columns; **zero disclosed evaluation numbers anywhere** | borrow-idea (architecture only) | Direct template for the Drive-Outcome Transformer (see N03) | weeks |
| mpchang/uncovering-missed-tackle-opportunities | 14 | none declared | 2024-03-03 | Despite the "Sequence" class name, the actual trained model is `XGBClassifier`, not a neural sequence model; real SHAP-based interpretability harness | avoid (transformer claim) / borrow-idea (SHAP harness) | XGBoost-surrogate + SHAP post-hoc audit pattern for any larger neural drive model | — |
| aburstyn9068/NFL_Play_Prediction | 8 | none declared | 2023-05-21 | 113-line RandomForestClassifier + Streamlit, single-play-row-in/row-out, no sequence structure | avoid | Confirms no mature open-source "sequence model on NFL PBP" exists — genuine build-from-scratch territory | — |
| DimaKudosh/pydfs-lineup-optimizer | 447 | MIT | last real commit 2021-09-27 (`pushed_at` metadata is misleading) | `stacks.py`: `TeamStack`/`GameStack`/`PositionsStack` as MILP group constraints (PuLP/CBC); `exposure_strategy.py` caps per-player lineup exposure; no correlation matrix, no ownership model | borrow-idea | Constraint vocabulary for a new `dfs-lineup-optimizer.js` | days |
| sansbacon/pangadfs | 7 | MIT | 2026-08-12 (active) | Genetic-algorithm lineup-**portfolio** search jointly optimizing score + pairwise-Jaccard diversity + ownership (`contrarian`/`leverage`/`balanced`) across N lineups at once — the missing multi-objective layer pydfs lacks | borrow-idea (fitness formulation) | Reimplement the ~150-line fitness function natively in JS on top of Gridiron's own `correlation.js`/`correlatedSampler()` | days |
| sansbacon/pangadfs-showdown | 0 | MIT | 2021-01-19 (stale) | DK-Showdown captain-multiplier rules only, no correlation logic | reference-only | — | — |
| sansbacon/pangadfs-simslate | 0 | Apache-2.0 | 2021-01-12 (1 commit) | Empty skeleton — README promises a field-simulation plugin that was never built | avoid | Negative evidence: "simulate the field of correlated opponents" is a known-desired, never-shipped OSS feature — a real gap Gridiron could fill | — |
| JWally/jsLPSolver | 463 | Unlicense | 2026-07-10 (active) | Pure-JS, zero-dependency MIP/binary solver via branch-and-cut | call | Real IP solver for a new `dfs-lineup-optimizer.js` (budget+position+team+stacking+overlap constraints) — no fork needed | days |
| Polymarket/py-clob-client | 1,233 | MIT | 2026-05-25 | `calculate_market_price()` walks the **full** bid/ask ladder to a target dollar size (size-aware fill price, not top-of-book); confirms `neg_risk`/`tick_size` are structural per-market facts | borrow-idea (depth-walk math) / avoid (trading/auth surface) | Depth-aware executable price using bid_size/ask_size already captured and discarded by `captureOrderBooks()` | days |
| Polymarket/clob-client (TS) | 514 | MIT | 2026-05-25 | Confirms neg-risk contract addresses; per-market `getNegRisk()` caching | reference-only | Contract-address confirmation only | — |
| Kalshi/kalshi-starter-code-python | 99 | none declared | 2025-03-07 | RSA-PSS-signed **authenticated trading** client + websocket ticker | avoid | Needs a funded account/key Gridiron doesn't have; public elections-API feed already covered | — |
| stanfordmlgroup/ngboost | 1,888 | Apache-2.0 | 2026-09-01 (active) | Natural-gradient boosted trees fitting one tree **per distribution parameter**; `NormalCRPScore` (proper scoring rule) alongside MLE; `.pred_dist(X)` returns a real closed-form `scipy.stats.norm(loc,scale)` per row | port (offline batch job) | Replace `nfl-ensemble.js:207-252`'s resampled-residual "distribution" with a per-game `(loc,scale)` NGBoost fit — closed-form quantiles/CDF instead of counting resampled points | days |
| tonyduan/mixture-density-network | 154 | MIT | 2023-05-17 (stable reference) | ~130-line PyTorch Gaussian-Mixture-Network: two small MLPs (`log_pi`, `mu`/`sigma`), exact NLL via `logsumexp`, exact ancestral sampling — the textbook Bishop-1994 MDN in modern code | port | Second, multimodal-capable margin-distribution head for `nfl-ensemble.js` (captures blowout-vs-close-game bimodality a single Normal can't) | days |
| probabilists/zuko | 466 | MIT | 2026-03-10 (active) | `LazyDistribution.forward(c) -> Distribution`: context-in, full arbitrarily-shaped conditional density out (Neural Spline Flow, monotonic rational-quadratic splines, exact invertible + exact log-det-Jacobian) | call (local Python sidecar) | Highest-capacity, highest-overfitting-risk margin head — gate behind held-out log-likelihood beating both NGBoost and the MDN first | days–weeks |
| bayesiains/nflows | 1,019 | MIT | 2024-12-27 (superseded by zuko) | `MADEMoG`: conditional Mixture-of-Gaussians via MADE — same math as tonyduan's repo, more scaffolding | reference-only | Confirms the MoG pattern is convergently well-established | — |
| awslabs/gluonts | 5,233 | Apache-2.0 | 2026-07-31 (active) | Production DeepAR (`torch/model/deepar`) + flow-based distribution heads | reference-only | Correctness oracle when unit-testing a ported JS NLL/loss against GluonTS's Python NLL | — |
| zhykoties/TimeSeries | 397 | Apache-2.0 | 2020-04-03 (stale) | PyTorch DeepAR reimplementation on `electricity` | avoid | Superseded by gluonts | — |
| AndrewRook/NFLWin | 24 | MIT | 2019-10-20/2023-07-06 (dormant, complete) | sklearn Pipeline (Elapsed-time → one-hot down → `CalibratedClassifierCV`); real, working, from-scratch KDE reliability-diagram calibration auditor (`max_deviation`, `residual_area` via Simpson's rule) — zero external service dependency | port | (a) Pipeline blueprint for a JS live-WP model; (b) the KDE calibration auditor itself, ~30 lines, ports cleanly to JS with no scikit-learn | days |
| topfunky/r-nfl-win-probability | 5 | none declared | 2021-01-18 | Single plain `glm()` logistic WP model on 9 features, visually tracks nflfastR's own curve; a 3-line dplyr reliability plot | reference-only | Cheapest possible fallback design if the xgboost path is too slow to stand up this week | — |
| nflverse/nflverse-pbp | 346 | CC-BY-4.0 | 2026-09-11 (built fresh weekly) | Published `play_by_play_<year>` files already carrying nflfastR's own `wp`/`vegas_wp`/`spread_line` plus every raw feature back to 1999 | call | Extra training rows beyond Gridiron's own 251,591; independent ingestion-accuracy benchmark | hours |
| nflverse/fastrmodels | 8 | MIT | 2026-02 (active) | Ships the actual trained xgboost WP model artifacts (`.rda`) nflfastR loads | reference-only | Confirms the Baldwin numbers came from a real, still-maintained artifact | — |
| trevorstephens/gplearn | 1,885 | BSD-3-Clause | 2026-08-14 (active) | Real tree-GP engine, sklearn-style API; `parsimony_coefficient` (real Occam's-razor penalty) and `max_samples`/`oob_fitness_` (genuine out-of-bag generalization tracking) are both verified, tunable, non-cosmetic | call | Feature-discovery front-end for `nfl-props-player-features.js`, `research/tree_lab.py` game-level features, and fantasy weekly features — gated by an external nested walk-forward wrapper (GP itself has no train/test split for model *selection*) | days |
| MilesCranmer/PySR (astroautomata/PySR) | 3,756 | Apache-2.0 | 2026-09-11 (active, wraps Julia) | Multi-population evolutionary search, Pareto frontier of (complexity, loss); **no built-in train/validation split for model selection at all** (grep-confirmed) — `model_selection="best"` is a training-loss-only criterion with a complexity tax | call (with mandatory external nested-CV wrapper) | Offline/monthly deep-audit tool, not wired into the weekly research-lab run given the Julia install footprint | days |
| cavalab/srbench | 319 | GPL-3.0 | 2026-08-13 (active) | The academic 25-method, 30-runs-per-dataset benchmark harness (not a library) — GP-based methods (Operon) dominate real-world black-box R² at 1-3 orders of magnitude smaller model size than gradient boosting | borrow-idea (protocol) | Design a private "gridiron-sr-bench" — fixed splits, N reruns, bootstrap-CI test R²/Brier — before trusting any GP output | — |
| cavalab/feat | 38 | GPL-3.0 | 2025-03-07 (stale ~18mo) | ICLR-2019 evolved-tree feature transformer, statistically tied with XGBoost on 100 PMLB sets at 2-4 orders of magnitude smaller models | reference-only | Read the paper's method; gplearn covers the same ground with 50x the maintenance signal | — |
| EpistasisLab/tpot2 | 250 | LGPL-3.0 | deprecated (merged into mainline TPOT) | Superseded — Gridiron already runs the merged `TPOT-1.1.0` in `research/tree_lab.py` | avoid | Nothing to do — already past this fork | — |
| lzumeta/injurytools (R) | 7 | MIT | 2026-01-30 (active) | Injury epidemiology (incidence/prevalence/burden, survival curves, risk-matrix chart); zero network/graph/depth-chart concept anywhere | borrow-idea (chart type only) | A position-group injury-exposure risk-matrix diagnostic — not a propagation model | — |
| ryurko/nflWAR | 38 | none declared | 2018-09-18 (stale) | Roster-based, empirically-derived replacement-level definition (not a hand-tuned constant); multilevel EPA/WPA credit split | borrow-idea | Replace `nfl-player-value.js`'s hand-tuned `POSITION_VALUE` table (author's own comment: "a monotone prior, not production coefficients") with an empirical replacement baseline from Gridiron's own backup-player data | hours |
| joewlos/fantasy_football_monte_carlo_draft_simulator | 11 | MIT | 2024-09-06 | Randomly zeroes a player's future value on an injury draw — no depth-chart lookup, no redistribution | avoid | Confirms "naive injury handling" is the OSS-ecosystem default | — |
| chanzer0/NFL-DFS-Tools | 49 | none declared | 2025-09-04 | Grep-confirmed **zero** injury/depth-chart awareness anywhere in the code | avoid | — | — |
| cbratkovics/fantasy-football-ai | 15 | MIT | 2026-09-11 (active) | Weekly point-prediction pipeline w/ a temporally-validated RF vs. causal baseline; no propagation logic | reference-only | Rolling-origin backtest harness pattern, if ever needed | — |
| jjti/ff | 78 | none declared | 2026-09-11 | Draft assistant, VORP = projection minus (n+1)th-ranked player — simplest possible replacement-level definition | reference-only | Simpler than what Gridiron already has; nothing to port | — |
| kellytodhunter/KBO-Player-Analysis | 1 | none declared | 2026-07-22 | Full Marcel-style pipeline: fitted (not literature-guessed) shrinkage-to-mean; **delta-method aging curve with a real per-age-bin standard error**, harmonic-mean playing-time weighting, `min_n=5` floor (NaN, not a fabricated number, below it); genuinely backtested 2021-2024 vs. two naive baselines | borrow-idea (design, not code — no license) | Replaces `AGE_CURVE_ANCHORS`' hand-typed literature table with a real fitted curve+SE from Gridiron's own season-pair data | weeks (needs the historical import first) |
| kennethho193/nfl-aging-curve | 0 | none declared | 2026-03-20 | `mixedlm("rushing_yards ~ age_c + age_c2", groups=player_id)` — random-intercept quadratic; correct delta-method 95% CI on the fitted *population* curve via `cov_params()` propagation (addresses survivorship at the population level, not per-player) | borrow-idea | Second, methodologically-distinct cross-check on the delta-method curve | days |
| sashaostr/sklearn-lifelines | 29 | none declared | 2019-01-27 (stale, don't run) | Thin sklearn wrapper around `lifelines.CoxPHFitter`/`AalenAdditiveFitter`; doesn't itself expose CIs, but the underlying `lifelines` library does (`predict_survival_function`, `.confidence_interval_`) | reference-only (API shape) / call (`lifelines` proper) | A genuine survival framing of dynasty decline (time-to-collapse-below-threshold, Cox with draft-capital/usage covariates) — the only one of the three GN10 repos whose method natively gives a **player-specific** band | weeks |
| Metaculus/forecasting-tools | 78 | MIT | 2026-09-09 (active) | `CalibrationAdjuster` ABC with 4 concrete implementations (constant-shift, logistic, decision-tree, k-means); `NumericDistribution`/`Percentile` schema elicits a full CDF, not a point; `Benchmarker` docstring has a built-in sample-size honesty check ("~30% of the worse bot wins at n=100") | port (schema/interface) / reference-only (full bot scaffolding) | Small, self-contained calibration-adjuster interface and percentile-CDF schema — not the Metaculus-API-specific bot framework | days |
| Metaculus/metac-bot-template | 64 | license unconfirmed | 2026-08-27 (active) | Minimal "wire an LLM to one forecasting question" example | reference-only | Read before building any LLM-forecaster pilot; don't lift code given license ambiguity | — |
| johnrandazzo/surv_nflrb | 7 | none declared | 2018-10-14 (stale) | Scraped PFR data; real KM survival curve + Cox PH (significant covariates: BMI, YPC, draft age) on 1,014 retired RBs; generalized-gamma fit to the aggregate survival function | borrow-idea (framing/covariate list, not code) | Re-derive the KM/Cox approach against Gridiron's own `player_accolades`(draft capital)+`player_week_usage`(real usage share) — better covariates than this repo's scraped BMI | weeks |
| sdfordham/pysyncon | 84 | MIT | 2026-09-12 (today) | Synthetic-control estimator + diagnostics — the standard N=1-treated-unit tool | reference-only (reimplement the small QP in JS) | Denver-altitude effect via synthetic control (Denver's team-FE and altitude "treatment" are perfectly collinear — flat regression can't identify it) | days |
| py-why/EconML (Microsoft) | 4,785 | "Other" (MSR-derived; check terms before commercial redistribution) | 2026-09-07 (active) | Doubly-robust causal forests for CATE estimation | reference-only / borrow-idea | Full per-team wind-sensitivity causal-forest upgrade, once the cheap empirical-Bayes-shrunk version (already-computed `wind_epa_delta`) shows signal | weeks |
| OscarEngelbrektson/SyntheticControlMethods | 195 | Apache-2.0 | 2026-07-11 | Alternative synthetic-control implementation | reference-only | Same role as pysyncon, less actively maintained — pysyncon preferred | — |

---

## Build from this now — 22 repos worth porting or calling tonight/this week

Ordered fantasy-first, then simulation, then betting-model, then audit-method, per Nick's
standing priority. Each line is the concrete first move, not the whole roadmap.

1. **ryurko/nflWAR** (borrow-idea) — replace `nfl-player-value.js`'s hand-typed
   `POSITION_VALUE` constants with an empirical replacement-level baseline computed from
   Gridiron's own `player_week_usage`/`nfl_snaps`/`nfl_depth` backup-player history.
   *Hours. Fantasy.*
2. **kellytodhunter/KBO-Player-Analysis** design (borrow-idea) — port the delta-method
   aging-curve-with-SE pattern once the nflverse historical player-season import (candidate
   N16-5) lands, replacing `AGE_CURVE_ANCHORS`. *Weeks, gated on the import. Fantasy.*
3. **sashaostr/sklearn-lifelines → `lifelines` proper** (call) — Cox PH survival model of
   dynasty career length on `player_accolades`(draft capital) + usage share, giving the first
   player-specific uncertainty band on any Gridiron valuation surface. *Weeks. Fantasy.*
4. **stanfordmlgroup/ngboost** (port, offline) — swap `nfl-ensemble.js`'s resampled-residual
   "distribution" for a per-game NGBoost `(loc, scale)` Normal fit with `CRPScore` — closed-form
   quantiles instead of counting points. *Days. Simulation/betting-model.*
5. **tonyduan/mixture-density-network** (port, ~40-line JS forward pass) — second,
   multimodal-capable margin head layered next to NGBoost. *Days. Simulation/betting-model.*
6. **nflverse/nflfastR formulas** (borrow-idea, reimplement — no redistribution license) —
   the exact `posteam_spread = home ? spread : -spread` one-line fix for the away-team-uses-
   home-spread bug, the hard kneel-probability override, and the two-regime OT branch.
   *Hours–days. Simulation.*
7. **greerreNFL/nfelohfa** design (borrow-idea) — replace `homeFieldPoints=1.6` hard-coded
   three times in `nfl-drive-sim.js` with a neutral-site-gated, per-game value. *Hours. Simulation.*
8. **fivethirtyeight/nfl-elo-game** (port, MIT) — stand up `nfl-baseline-elo.js` as an
   independent decades-validated sanity check on `nfl-ensemble.js`/`nfl-team-strength.js`.
   *Hours. Betting-model.*
9. **neeljshah/shin-devig** (port) — add `powerDevig()` to `nfl-devig.js`, the second devig
   method Gridiron currently lacks. *Hours. Betting-model.*
10. **johntwk/Diebold-Mariano-Test** (port, ~40 lines) — replace the ad hoc paired-t at
    `nfl-ensemble.js:1125-1129` with a real DM statistic + small-sample correction. *Hours.
    Betting-model.*
11. **henrikbostrom/crepes** (port, ~30-40 lines) — real split-conformal interval, Mondrian-
    binned by spread bucket, replacing the `disagreement/30` inflation hack. *Hours. Betting-model.*
12. **greerreNFL/nfelosrs** `BayesianRankings.py` (borrow-idea) — recursive per-team, per-week
    Gaussian-conjugate update for `nfl-team-strength.js`, closing the "no state-space update"
    finding directly. *Days. Betting-model.*
13. **georgedouzas/sports-betting** odds grammar (port) — `{provider}__{market}__{status}__
    {time}` long-table design that makes CLV = "closing row minus opening row for the same
    (game, market)" instead of five disagreeing implementations. *Days. Audit-method.*
14. **splink** (borrow-idea) — hand-tuned (non-EM) Fellegi-Sunter confidence score layered on
    `eventKey()`/`contractKey()`, turning silent `unresolved_team` failures into scored matches.
    *Days. Audit-method.*
15. **J535D165/recordlinkage** blocking pattern (borrow-idea) — sorted-neighborhood/date-window
    blocking ahead of any Polymarket-tape↔game join; hard prerequisite before the 12.4M-row
    tape can be used at scale at all. *Hours. Audit-method.*
16. **eslazarev/purged-cross-validation** `effective_n_trials()` (port) — the autocorrelation-
    corrected trial count for the 21-model historical search (raw `21` would be dishonest either
    direction for an iterative search). *Hours–days. Audit-method.*
17. **quantskills/skill-backtest-overfit** formulas (reference-only, reimplement — GPL) —
    DSR + PBO/CSCV + Holm/BHY math feeding the new `research_trial_corrections` table.
    *Days. Audit-method.*
18. **martineastwood/penaltyblog** `implied.py` (port) — 7-method devig dispatcher; run
    Gridiron's own historical closing lines through all 7 to pick one with evidence instead
    of by literature authority alone. *Days. Betting-model.*
19. **AndrewRook/NFLWin** KDE calibration auditor (port, ~30 lines) — the first real
    reliability-diagram/calibration check anywhere in the pipeline, ported without needing
    scikit-learn. *Days. Audit-method.*
20. **JWally/jsLPSolver** (call, npm) — real MIP solver as the backbone of a new
    `dfs-lineup-optimizer.js`, no fork needed. *Days. New capability (fantasy-adjacent).*
21. **trevorstephens/gplearn** (call, pip) — feature-discovery front end for
    `nfl-props-player-features.js`, wrapped in an external nested walk-forward split (its own
    OOB fitness is the built-in overfitting alarm to watch). *Days. New capability (props).*
22. **amazon-science/chronos-forecasting (Chronos-2)** (call, pip) — one weekly Python batch
    job cross-learning over all 32 teams' short scoring-differential panels as a zero-shot
    challenger/diagnostic against the hand-tuned team-strength blend. *Days. New capability.*

## Avoid — checked and rejected, with the specific reason

- **time-series-foundation-models/lag-llama** — lag-indexed tokenization structurally requires
  up to a 52-week context window; cannot accept a single NFL team-season at all. Dominated on
  every axis by Chronos-2 for this use case.
- **hamrel-cxu/EnbPI** — sound idea, subsumed by `aangelopoulos/conformal-time-series`'s
  cleaner, purpose-built ACI code; the repo itself is rough research-script code (hardcoded
  Keras callbacks, `__pycache__` committed historically).
- **EpistasisLab/tpot2** — deprecated/merged; Gridiron already runs the merged mainline TPOT.
- **UnravelSports/unravelsports, sanjeevnara7/FootballPassPrediction,
  juancamilocampos/nfl-big-data-bowl-2020 (GNN half)** — all require player x/y tracking data
  (Next Gen Stats-grade) that Gridiron does not ingest; genuinely forward-looking only.
- **stevenbliu/Project-NBA-Rankings-Prediction's from-scratch GCN side-path** — trains and
  evaluates on the *identical* tensors with zero train/test split; its "~88% accuracy" is a
  leakage artifact, not evidence the graph approach works. (The vendored GraphSAGE half of the
  same repo is fine.)
- **mpchang/uncovering-missed-tackle-opportunities** — despite a class named `TackleSequence`,
  the trained model is XGBoost, not a sequence model; do not cite it for the transformer angle.
- **aburstyn9068/NFL_Play_Prediction** — a 113-line RandomForest/Streamlit toy with no sequence
  structure; deleted after inspection.
- **sansbacon/pangadfs-simslate** — an empty one-commit skeleton; the promised feature (field
  simulation) was never built anywhere in this ecosystem.
- **Kalshi/kalshi-starter-code-python, Polymarket/py-clob-client & clob-client (trading half)**
  — all require authenticated, funded accounts; Gridiron places no bets on these venues and
  building order-signing infrastructure is explicitly out of scope.
- **mementum/backtrader** — GPL-3.0 and 14+ months dormant; design-only reference, never a
  runtime dependency.
- **mnemox-ai/deflated-sharpe's own DSR formula** — a different (Gumbel closed-form) `E[max SR]`
  approximation than purgedcv/quantskills use, and less correct when trial Sharpes are not
  homoskedastic (Gridiron's aren't). Use purgedcv's variance-based formula instead; keep this
  repo only for its clean BH-FDR reference function.
- **joewlos/fantasy_football_monte_carlo_draft_simulator, chanzer0/NFL-DFS-Tools,
  lzumeta/injurytools (as a propagation model)** — none contain any injury→teammate
  redistribution logic; confirms this is genuinely open research territory, not a port
  opportunity.
- **johnrandazzo/surv_nflrb, kellytodhunter/KBO-Player-Analysis, kennethho193/nfl-aging-curve**
  (as literal code, not method) — none carry a license permitting redistribution; reimplement
  the documented method against Gridiron's own, better covariates instead of importing code.
- **GitHub "polymarket/kalshi arbitrage bot" search results generally** — the overwhelming
  majority are keyword-stuffed, unlicensed, days-old forks matching the well-documented
  crypto-trading-bot malware/wallet-drainer spam pattern. None cloned, none evaluated further.
- **nflverse/nflseedR, RobbyGillespie/Optimal-NFL-Play-Simulator, dlm1223/nfl-simulation,
  GallagherAiden/footballSimulationEngine, nishs9/nfl-simulation-engine-lite** — season-level
  (not drive-level) simulator, no clock/kneel/OT logic at all, garbage-time plays explicitly
  excluded from the training sample, or a soccer-physics engine misfiled under "football
  simulation." None usable as a drive-mechanics reference.
