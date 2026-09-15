# GN01 — Time-series foundation model code (Chronos / TimesFM / Lag-Llama)

Agent: GN01-timeseries-foundation-code, bucket=new, phase=GitHubNew
Repos cloned (shallow, `--filter=blob:none`) into
`/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/research2/github/`:
- `amazon-science__chronos-forecasting`
- `google-research__timesfm`
- `time-series-foundation-models__lag-llama`

Note: `git-lfs` is not installed in this environment, so LFS-tracked binary blobs (images,
sample notebooks with embedded output) failed to smudge on all three clones. All `.py` source
files checked out cleanly (verified with `find … -name "*.py"` and `git status` — only images
and non-code assets are missing), so the code-reading claims below are grounded in real source,
not READMEs.

## 1. amazon-science/chronos-forecasting (Chronos / Chronos-Bolt / Chronos-2)

- License: Apache-2.0 (code AND weights, up through Chronos-2). Confirmed in repo `LICENSE`
  and README badge.
- Stars: 5,847. Last commit: 2026-09-08 (4 days before this research), actively maintained —
  Chronos-2 shipped 2025-10-20 and got an AWS/SageMaker deployment guide 2026-09-05.
- What the code actually does (read, not README): `src/chronos/chronos2/pipeline.py` implements
  `Chronos2Pipeline` — a 120M-param (or 28M "small") transformer that does zero-shot
  **univariate, multivariate, and covariate-informed** forecasting. Key facts pulled directly
  from the source:
  - `predict()` (pipeline.py:468-560) accepts a list of dicts, each with `target`,
    `past_covariates`, and `future_covariates` — supports **mixed history lengths across items
    in the same batch** (left-padding handled internally) and **categorical covariates**
    (numpy string arrays), not just numeric.
  - `predict(..., cross_learning=True)` (pipeline.py docstring, same block): explicitly designed
    for "individual time series [with] limited historical context" — the model shares
    information across all series in the batch during inference. This is the load-bearing
    feature for Gridiron: NFL weekly team/player panels are short (≤17-18 rows/season/entity)
    but wide (32 teams, ~1,700 skill players), which is exactly the shape cross-learning targets.
  - `dataset.py` (Chronos2Dataset, lines ~203-236): context is `min(context_length,
    history_length)` — there is no hard minimum sequence length enforced in code; a 5-10 week
    context is accepted, though zero-shot pretraining was not specifically on data this short
    (see Limitations below).
  - `df_utils.py` / `preprocess.py`: has a first-class pandas DataFrame API
    (`predict_df`, `validate_and_normalize_df`) keyed by `item_id`/`timestamp` — this maps
    directly onto a long-format weekly team/player table without a custom adapter layer.
- Fine-tuning: `fit()` (pipeline.py, `fit()` method) supports full or LoRA fine-tuning with a
  validation set, `num_steps`, `min_past` — usable later, not needed for a v1 pilot.
- Limitation (from reading the code, not marketing): default pretraining context length is up to
  2048 timesteps; the benchmark numbers Amazon publishes (fev-bench, GIFT-Eval, Chronos
  Benchmark II — cited in README, not independently re-verified here) are dominated by series
  much longer than an NFL season. Zero-shot quality on <20-point context is *plausible*
  (cross-learning exists precisely for this) but not demonstrated in the repo's own benchmarks —
  this must be backtested on Gridiron's own data before being trusted, not assumed from the
  README's benchmark table.
- Adopt: **call** (pip install `chronos-forecasting`, Python 3.10+, works CPU or single GPU for
  a panel this small — no training required for the pilot).
- Concrete Gridiron attachment point: `server/services/nfl-team-strength.js` (blends stale
  preseason priors with in-season data via a hand-tuned formula) and the player-props module —
  run a weekly Python batch job that cross-learns over all 32 teams' weekly scoring-differential
  series (or all active RBs' weekly touches), emit quantile forecasts as JSON, and have the
  existing Node services read that JSON as one additional input feature/prior rather than a
  replacement — i.e., produce a genuinely out-of-sample distributional forecast to compare
  against or blend with the current hand-tuned blend.

## 2. google-research/timesfm (TimesFM 1.0 / 2.0 / 2.5 / 3.0)

- License: **code is Apache-2.0 throughout.** Weights: Apache-2.0 through v2.5. **TimesFM 3.0
  pretrained weights are under `timesfm-non-commercial-license-v1.0`** — non-commercial/
  non-production use only (confirmed verbatim in README's "License notice for pretrained
  weights" section). Gridiron is Nick's personal, non-commercial project, so this is fine today,
  but it is a real constraint if Gridiron is ever monetized — use the 2.5 weights (Apache-2.0)
  if commercial optionality matters, not 3.0.
- Stars: 32,305 (far larger community than Chronos or Lag-Llama). Last commit: 2026-09-09 (3
  days before this research) — actively developed, TimesFM 3.0 shipped August 2026.
- What the code actually does: `src/timesfm3/` is the current (3.0) codebase —
  `timesfm3_forecaster.py`, `model.py`, `transformer.py`, `cpm_revin_refine.py`. TimesFM 3.0 adds
  **native multivariate forecasting with covariate support** (both past-only and past+future
  dynamic covariates) without per-task tuning — this is architecturally different from 2.5,
  which bolted covariates on via a separate in-context-regression module.
  - `src/timesfm/utils/xreg_lib.py` (2.5-era, Apache-2.0 weights): implements **in-context
    regression (XReg)** — two explicit modes, `"timesfm + xreg"` and `"xreg + timesfm"`
    (`XRegMode` literal in the source). This fits a linear/ridge regression on named covariates
    and either (a) forecasts with TimesFM then residual-corrects with the regression, or (b)
    detrends with the regression then lets TimesFM forecast the residual. This is a genuine,
    already-implemented technique for blending a foundation-model forecast with known
    external regressors — not hand-wavy, it's ~150 lines of real numpy/jax code doing
    per-series normalization + closed-form regression.
  - `requirements.txt` / imports show TimesFM's XReg path depends on `jax`/`jaxlib` +
    `scikit-learn`, a heavier dependency stack than Chronos's pure-PyTorch path — real setup
    cost to weigh (see below).
- Limitation from reading code (not marketing): the fev-bench/GIFT-Eval "#1 rank" claims in the
  README are Google's own self-reported benchmark rankings — not independently reproduced here;
  treat as directional, not proof, exactly like Chronos's benchmark claims.
- Adopt: **call** for TimesFM 2.5 (Apache-2.0 weights, XReg covariate blending, lighter license
  risk); **borrow-idea** for TimesFM 3.0's native multivariate-with-covariates architecture
  (non-commercial weights are an acceptable trade for a personal project pilot, but shouldn't be
  the long-term production path if Gridiron ever needs unrestricted redistribution).
- Concrete Gridiron attachment point: (a) `xreg_lib.py`'s XReg blend as a drop-in alternative to
  the current hand-tuned preseason/in-season blend in `nfl-team-strength.js`; (b) TimesFM 3.0's
  native multivariate head as a pilot for **jointly** forecasting correlated same-game legs
  (e.g., QB pass yards + WR1 receiving yards + game total) that
  `server/betting/nfl/strategy/teaser-leg-rates.js` currently treats as independent — a genuine
  multivariate quantile forecast captures some of the correlation structure that an
  independence assumption throws away, without needing to hand-build a copula.

## 3. time-series-foundation-models/lag-llama

- License: Apache-2.0 (confirmed in repo `LICENSE`).
- Stars: 1,602. **Last commit: 2025-06-06 — over 15 months stale** as of 2026-09-12. No
  Chronos-2/TimesFM-3-style architectural evolution; last substantive fix was a June 2024
  kv-cache correctness bug (per README changelog), i.e., the project has been dormant well
  before that.
- What the code actually does: `run.py` is a GluonTS-based train/eval harness.
  Univariate only — no covariate or multivariate support anywhere in the code (confirmed by
  grepping the whole repo: no `covariate` references in `run.py`, `utils/utils.py`, or
  `data/*.py`). Critically, `run.py` line ~277: `history_length = estimator.context_length +
  max(estimator.lags_seq)` — the *actual* minimum history required is context_length **plus**
  the model's lag set (lags can run out to a full year of periodicity terms for
  higher-frequency data), which is materially more history than the `context_length=32`
  the README advertises as the practical minimum. For a single NFL team-season (17-18 rows) or
  a single player-season, this lag requirement is very likely to exceed what's available,
  independent of the "try context length starting from 32" advice in the README's own Best
  Practices section — that advice describes the *architectural* minimum, not the *lag-window*
  minimum actually enforced by the data pipeline.
- No first-class DataFrame API, no cross-series/cross-learning batching for short-history panels
  (unlike Chronos-2) — GluonTS `ListDataset` supports multiple series for *training*, but
  zero-shot inference is per-series, so it gets none of Chronos-2's short-panel-via-pooling
  advantage.
- Adopt: **avoid** for Gridiron. It is the *first* open time-series foundation model
  historically (2024), but for this specific use case (short, covariate-rich, cross-sectional
  NFL panels) it is strictly dominated by Chronos-2 on every axis that matters here: covariate
  support (none vs. yes), cross-learning for short series (none vs. yes), maintenance
  recency (15 months stale vs. days), and DataFrame ergonomics (none vs. first-class). Spending
  setup time on Lag-Llama for this task would be time not spent validating Chronos-2, which is
  strictly better-suited and cheaper to integrate.

## Honest small-panel feasibility verdict

Gridiron's weekly team/player series are short (≤18 points/season/entity) and cross-sectional
(32 teams; ~1,000+ active skill players). This shape rewards **cross-learning / in-context
pooling across related series** far more than raw autoregressive context length. Of the three
repos:
- **Chronos-2** is architecturally built for exactly this (group-attention ICL across a batch of
  related series, explicit `cross_learning=True` flag, native covariate + DataFrame support,
  Apache-2.0 all the way through). This is the best-fit, lowest-setup-cost option.
- **TimesFM 2.5/3.0** is a credible second choice, particularly for the in-context XReg blend
  (2.5, Apache-2.0 weights) or native multivariate correlation modeling (3.0, non-commercial
  weights) — heavier dependency stack (jax) for the XReg path.
- **Lag-Llama** should not be used for this task; it is stale, univariate-only, and its actual
  minimum-history requirement (context_length + max lag) works against short NFL-season panels
  even before considering the lack of cross-learning.

None of this replaces backtesting: every claim above about zero-shot quality on short panels is
architectural feasibility, not a measured result on Gridiron's own data. The exit test for any
candidate below is a real backtest against the existing blend / point-estimate baseline, not the
vendor's own benchmark tables.

## Sources (papers, abstracts only — not full-text read)

- Chronos-2 technical report (arXiv:2510.15821): abstract confirms group-attention ICL,
  zero-shot univariate/multivariate/covariate-informed forecasting, evaluated on fev-bench /
  GIFT-Eval / Chronos Benchmark II; abstract text does not itself carry numeric deltas vs.
  Chronos-Bolt (the numbers live in tables in the body, not fetched here) — treat "outperforms
  baselines by a wide margin" as a vendor claim pending our own backtest.
- Lag-Llama paper (arXiv:2310.08278): abstract confirms univariate-only design and "strong
  zero-shot generalization" claim vs. unspecified baselines; consistent with what the code
  shows (no covariate path).
