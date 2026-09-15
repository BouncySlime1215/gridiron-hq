# JS vs Python implementation for GBM and regularized models in Gridiron HQ

## The brief's environment facts are incomplete. Verified locally, read-only:
- System `python3` is Homebrew 3.14.3 with numpy only. It is PEP 668 "externally managed" (the `EXTERNALLY-MANAGED` marker is present), so any install there needs a venv.
- **A trained-model toolchain already exists** at `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/research/.venv`. It runs Python 3.12.4 (python.org framework build) and has lightgbm 4.7.0, xgboost 3.4.1, catboost 1.2.10, scikit-learn 1.7.2, scipy 1.18.1, pandas 3.0.5, numpy 2.5.3, optuna 5.0.0 and TPOT 1.1.0.
  - Its `requirements.txt` says: "Isolated research environment ... No app-runtime dependency."
  - `research/tree_lab.py` already imports sklearn and LightGBM.
  - All of these import correctly.
- `lib_lightgbm.dylib` links `@rpath/libomp.dylib`, with rpath `/opt/homebrew/opt/libomp/lib`. Homebrew libomp 23.1.0 is installed. **So this venv depends on a Homebrew package that lives outside the venv.**
- The app's `package.json` runtime dependencies are only `express` and `@anthropic-ai/sdk`. There are no ML packages in node_modules.

Prior research I'm building on: GN07 (`research2/GN07-live-win-probability-code.md`) already said to train xgboost offline, export the trees to JSON and walk them in a ~40-line JS evaluator, and not to run a native xgboost binary in Node. FIX_AND_ADD #23 refers to the LightGBM quantile scaffold in `tree_lab.py`. Below I test that approach and widen it.

## Experiments I ran (scratchpad only, repo untouched)
Directory: `/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/jsgbm/`

1. **Training determinism** (`train.py`, research venv). The same data and parameters were fitted twice:
   - LightGBM with `deterministic=True, force_row_wise=True, n_jobs=1`: the `dump_model()` JSON was byte-identical across runs.
   - XGBoost `hist` with `n_jobs=1`: the `save_model` JSON was byte-identical.
   - Both runs used subsampling with a fixed seed and 5% NaNs.
2. **Pure-JS scoring of exported trees** (`score.mjs`, Node 25.9, 500 test rows with NaNs):
   - LightGBM `dump_model` JSON walked in JS: max absolute difference vs `booster.predict` was **0** (exact).
   - XGBoost `save_model` JSON walked in JS: max absolute difference was **3.8e-6**. XGBoost compares thresholds and sums leaves in float32, so matching needs `Math.fround`.
   - Each walker is about 15 lines. My LightGBM walker handles numeric splits only: `<=` threshold, `missing_type` NaN/None/Zero, `default_left`. It throws on categorical splits.
3. **Hand-rolled JS histogram GBM** (`gbm.mjs`, about 50 lines, not yet a library):
   - Squared error, XGBoost-style λ and γ, learned NaN direction, seeded row and column subsampling (mulberry32).
   - Synthetic data: 5,400 training rows × 40 features, noise sd 13.5, 300 rounds, depth 3.
   - **Test RMSE 13.5602 vs LightGBM 13.5612** with the same hyperparameters. Predicting the mean gives 13.82.
   - Training took **1.85 s** unoptimized, and a rerun produced a bit-identical model.
   - This is one synthetic dataset, not a general equivalence proof. It does show that at Gridiron's sample size, compute and accuracy do not force the use of a C++ library.

## Option-by-option evaluation

| Option | Maintenance (verified) | Correctness / determinism | Verdict |
|---|---|---|---|
| **ml-random-forest / ml-cart** (mljs, MIT) | Last publish Jan 2022; about 10k downloads a week; 63 stars, 7 open issues | Random forest and CART only; **no gradient boosting**; missing-value handling not documented | Not a GBM; stale |
| **ml-xgboost** (mljs, Emscripten WASM) | Last npm publish 2018-02-19; built with emsdk 1.37.22 on an old xgboost commit; requires manual `booster.free()` | Old engine, memory-leak footgun | Avoid |
| **`lightgbm` npm** (gitlab rotem-bar) | 1.0.27 from 2023-11; **94 downloads a week**; compiles with cmake-js at install | Native compile on Node 25 not verified; tiny user base | Avoid |
| XGBoost Node binding | `xgboost-node` does not exist on npm; no maintained one found (matches GN07) | — | None exists |
| **onnxruntime-node** (Microsoft, MIT) | 1.29.0 published 2026-08-24; about 3.4M downloads a week; prebuilt for macOS arm64 | 296 MB unpacked; has an install script (skippable). ONNX tree operators store thresholds and leaves as float32, and sklearn-onnx documents discrepancies against double-precision LightGBM that grow with tree count. The conversion chain (onnxmltools, skl2onnx) adds 3 more Python packages. | Workable but heavy, with a documented precision gap and a large dependency for scoring about 300 small trees |
| **tfjs-node** | 4.22.0, Oct 2024 | Not a tree library | No |
| **Python sidecar with 3.14 wheels** | PyPI now has macOS arm64 wheels that work on 3.14: lightgbm 4.7.0, xgboost 3.4.1, scikit-learn 1.9.1, scipy 1.18.1, catboost 1.2.10, onnxruntime 1.30.0, treelite 4.7.2 | LightGBM's pip README says macOS users need `brew install libomp` (already present). Needs a new venv. | Viable; the existing 3.12 research venv is the same without new installs |
| **treelite 4.7.2** / **m2cgen 0.10.0** | treelite is active (2026-09-02) but compiles to C, not JS. m2cgen last release 2022-04-26. | — | Not needed; the JSON walker is simpler |
| **Export trees to JSON and score in pure JS** | LightGBM `dump_model` and XGBoost `save_model` are first-party formats. XGBoost docs say saved models "use a stable representation" readable by later versions, and `dump_model` is "not supposed to be loaded back." The JSON schema file was removed in 3.2. | Tested exact (LightGBM) or within float32 (XGBoost) | **Best serving path** |
| **Hand-rolled JS GBM plus ridge/GLM** | Zero dependencies, fully owned | Tested deterministic, accuracy on par in one test; only `+ * /` on doubles | **Best end-to-end path, if it is property-tested against LightGBM** |
| numpy-only Python GBM | Possible | Nothing gained over JS, plus a process boundary | No |

## (A) KEY FINDINGS
1. **No maintained pure-JS gradient-boosting library exists.** mljs covers RF/CART only (last publish 2022). ml-xgboost is a 2018 WASM build; the Node LightGBM binding gets 94 downloads a week. Sources: npm registry metadata I queried, https://github.com/mljs/random-forest, https://github.com/mljs/xgboost. GitHub topic searches found none either.
2. **Exporting and walking trees in JS is exact for LightGBM** and within float32 rounding (3.8e-6) for XGBoost. This is my own test above. Format references: https://xgboost.readthedocs.io/en/stable/tutorials/saving_model.html
3. **LightGBM reproducibility is conditional.** Docs: `deterministic=true` "should ensure the stable results when using the same data and the same parameters," but results may still differ across seeds, LightGBM versions, compilers or systems. They recommend `force_row_wise` or `force_col_wise`. https://lightgbm.readthedocs.io/en/latest/Parameters.html. **So artifacts must be pinned to a version, not just a seed.**
4. **The ONNX route loses precision.** TreeEnsemble thresholds and leaves are float32, and sklearn-onnx shows LightGBM float/double discrepancies that grow with the number of trees (max about 1.24e-6 at 1,000 trees without splitting). https://onnx.ai/sklearn-onnx/auto_tutorial/plot_gexternal_lightgbm_reg.html, https://onnx.ai/onnx/operators/onnx_aionnxml_TreeEnsemble.html
5. **Python 3.14 is no longer a wheel blocker.** lightgbm, xgboost, scikit-learn and scipy all publish macOS arm64 wheels that install on 3.14 (PyPI JSON API, Sept 2026). The LightGBM pip wheel still needs Homebrew libomp on macOS: https://github.com/lightgbm-org/LightGBM/tree/master/python-package
6. **The GBM math to hand-roll is small and documented.** From Chen & Guestrin 2016 (https://arxiv.org/abs/1603.02754) and https://xgboost.readthedocs.io/en/stable/tutorials/model.html:
   - Leaf weight: w* = −G/(H+λ)
   - Split gain: ½[G_L²/(H_L+λ) + G_R²/(H_R+λ) − (G_L+G_R)²/(H_L+H_R+λ)] − γ
7. **At about 5,000 rows**, a naive JS histogram GBM trained 300 depth-3 trees in 1.85 s, bit-reproducible, matching LightGBM's test RMSE on one synthetic problem (my test). A weekly walk-forward over about 20 seasons × 18 weeks is roughly 360 fits, about 11 minutes naive, and easy to speed up with typed arrays and precomputed bins.

## (B) CONCRETE RECOMMENDATIONS
1. **The production path is pure Node with zero new runtime dependencies.** Put these in a `lib/learn/` module:
   - (a) Ridge/elastic-net and GLMs, including a Gaussian or Student-t margin head, fitted in closed form or by coordinate descent on Float64Array.
   - (b) A small histogram GBM (squared-error and quantile/pinball losses; λ, γ, min_child, depth, shrinkage; learned NaN direction; seeded PRNG; early stopping on a walk-forward fold, never a random split).
   - (c) A tree walker that reads its own JSON format and also LightGBM `dump_model` JSON.
   - Serving, retraining, the decision tape and the audit then all run in the same process with the same SQLite reads, so point-in-time correctness is enforced in a single code path.
2. **Use the existing `research/.venv` as the reference oracle, not a runtime dependency.** Using what is already installed needs no approval (confirm the owner is fine with it). Add a CI-style parity test:
   - Same features, same hyperparameters, LightGBM with `deterministic=True, force_row_wise=True, n_jobs=1`.
   - Assert that JS-GBM out-of-sample RMSE and log-score fall within a set tolerance of LightGBM on real Gridiron walk-forward folds.
   - Assert that LightGBM's exported JSON scores exactly in the JS walker.
   - This catches bugs in the hand-rolled learner. Use fast-check (already a devDependency) for property tests: monotone invariance, NaN routing, bit-identical reruns.
3. **Fallback if the JS GBM underperforms the oracle:** train LightGBM offline in the venv and export `dump_model` JSON. Store it with a SHA-256, the lightgbm version, parameters and the training cutoff timestamp. Score in the JS walker.
4. **Do not adopt:** onnxruntime-node (296 MB, float32 gap, 3 extra Python converters), any npm LightGBM/XGBoost binding, ml-xgboost, or m2cgen.
5. **Determinism rules:**
   - Seeded PRNG only; never `Math.random`.
   - Stable sorts (ES2019 guarantees this).
   - Only `+ − × ÷` and `sqrt` in the learner. Avoid `Math.exp`/`Math.log` in split search, since those are not guaranteed identical across V8 versions; that is my own caution, not a verified defect.
   - Record `process.version` and a model hash with every artifact.

**Packages that would need owner approval:**
- **Recommended path (JS learner plus the existing venv as oracle):** none.
- **Optional:** `ml-matrix` (MIT, active, 2026-08-05) if the owner prefers not to hand-roll Cholesky or SVD for ridge.
- **Python 3.14 sidecar instead of the 3.12 venv:** a new venv with `lightgbm==4.7.0` and `numpy` (plus `scikit-learn==1.9.1` and `scipy==1.18.1` if wanted), with Homebrew `libomp` kept installed.
- **Rejected ONNX route:** `onnxruntime-node`, `onnxmltools`, `skl2onnx`, `onnx`.

## (C) ADOPTABLE CODE/REPOS
- **LightGBM** (MIT), https://github.com/lightgbm-org/LightGBM: borrow the `dump_model` JSON node semantics (`decision_type`, `missing_type`, `default_left`) for the walker, and its parameter names so the parity tests map one-to-one. Use as the offline oracle only.
- **XGBoost** (Apache-2.0), https://github.com/dmlc/xgboost, with Chen & Guestrin 2016: borrow the regularized gain and leaf formulas and the sparsity-aware default direction. Also the `save_model` JSON arrays (`left_children`, `split_conditions`, `default_left`) if XGBoost artifacts are ever used; compare in float32.
- **mljs/ml-matrix** (MIT): an optional linear-algebra helper for ridge.
- **Prototypes** (mine, for spec reference only): `.../scratchpad/jsgbm/gbm.mjs`, `score.mjs`, `train.py`.
- **Do not copy** mljs random-forest or the ml-xgboost code (not boosting, or stale).

## (D) OPEN QUESTIONS/RISKS
1. **Maintenance burden.** The hand-rolled GBM is owned code, so a bug there is Gridiron's to find. The parity harness against LightGBM is mandatory, not optional.
2. **One synthetic test proves little.** The JS GBM matching LightGBM was shown on one synthetic dataset; real parity on Gridiron folds is untested.
3. **The research venv is fragile.** It depends on Homebrew libomp and a 2024 python.org Python 3.12 install. A `brew upgrade` or removal could break the oracle; pin and record versions.
4. **LightGBM determinism is only guaranteed within a version and system.** Upgrading lightgbm invalidates bit-level reproducibility of stored artifacts; keep version-tagged artifacts.
5. **Model complexity may not pay.** With about 270 games per season, a GBM may not beat a well-shrunk ridge or GLM on the market residual. The implementation choice should not presume trees win; build ridge first, and let the GBM earn weight through the continuous out-of-sample gate.
6. **Categorical features** (team, coach) are not handled by my walker. Encode them numerically or add set-membership splits deliberately.
7. **Oracle permission.** Using the existing venv inside an app workflow (even as a test oracle) is a scope change from "no app-runtime dependency." The owner should confirm.