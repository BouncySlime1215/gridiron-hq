# GN08 — Genetic Programming / Symbolic Regression for Gridiron

Bucket: new. Task: clone and read real GP/SR repos, verify what the code does (not the
README), and specify a bounded, guarded pilot appropriate to Gridiron's actual sample sizes.

## Repos cloned and read

All cloned depth-1 (`--filter=blob:none`) into
`/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/research2/github/`.
No node_modules/venv present in any of the three (checked with `find -iname node_modules -o -iname venv -o -iname .venv`, empty).

### 1. trevorstephens/gplearn
- License: BSD-3-Clause. Stars: 1,885. Last commit (pushed_at): 2026-08-14.
- What it is, verified by reading `gplearn/genetic.py`, `gplearn/_program.py`, `gplearn/fitness.py`:
  a real tree-based genetic-programming engine with a scikit-learn-style `SymbolicRegressor` /
  `SymbolicClassifier` / `SymbolicTransformer` API. `_parallel_evolve` (genetic.py:38-151) runs
  tournament selection (`_tournament`, genetic.py:59-66), builds each generation by crossover /
  subtree mutation / hoist mutation / point mutation / reproduction according to `method_probs`,
  and computes `raw_fitness_` per program (genetic.py:148).
- **Overfitting controls already built in, verified in code, not docs**:
  - `parsimony_coefficient` (genetic.py:182, 209, default 0.001; `'auto'` mode computes it each
    generation from `cov(length, fitness)/var(length)`, genetic.py:507-509) penalizes tree size —
    a real, tunable Occam's-razor term, not cosmetic.
  - `max_samples` (genetic.py:57, 139-151): when < 1.0, each program is fit on a *bootstrap
    subsample* of the training rows and its `oob_fitness_` is computed on the complement
    (`oob_sample_weight[indices] = 0`, genetic.py:146) — a genuine out-of-bag generalization
    estimate, tracked per-generation in `run_details_['best_oob_fitness']` (genetic.py:449-546).
    This is exactly the diagnostic you need to detect a GP run overfitting a small table: watch
    `best_fitness` vs `best_oob_fitness` diverge across generations.
  - `stopping_criteria` lets you halt on a fitness target rather than running to convergence on
    training loss, which caps how hard the search grinds against one sample.
- **What it does NOT do**: no internal train/test split for model *selection*, no significance
  test on the final champion, no correction for the fact that a single run evaluates
  `population_size * generations` programs (default 1000 x 20 = 20,000) against one fitness
  function — every one of those is an implicit statistical test.
- Adopt: **call** — install as a pip dependency in the Python research lab, do not fork/vendor.
  Its OOB machinery is the right guardrail to require in the harness (below), not something to
  reimplement.

### 2. MilesCranmer/PySR (search API still returns the old `astroautomata/PySR` alias — same
   repo history, canonical org is now MilesCranmer)
- License: Apache-2.0. Stars: 3,756. Last commit: 2026-09-11 (actively maintained; wraps a Julia
  backend, `SymbolicRegression.jl`, 804 stars, also actively maintained).
- What it is, verified in `pysr/sr.py`: a much higher-throughput evolutionary search (multiple
  populations migrating candidate expressions, `populations=31` default, `sr.py:517-518`) that
  explores a Pareto frontier of (complexity, loss) rather than one champion. Model selection is
  done post-hoc by `idx_model_selection` (sr.py:3405-3421):
  - `"accuracy"` = pure `loss.idxmin()` (best training loss, complexity ignored — a pure
    overfitting knob if used carelessly).
  - `"best"` (the default) = among equations within `1.5x` of the minimum loss, pick the one
    with the highest `score`, where `score` is "the negated derivative of log-loss with respect
    to complexity" (sr.py:3426-3454) — i.e. an AIC-style marginal-improvement-per-extra-node
    criterion computed **entirely from training loss**.
  - `"score"` = pure score-max, same caveat.
- **Verified absence**: grepped `pysr/*.py` for `cross_val|train_test_split|holdout|validation` —
  every hit is sklearn input-validation boilerplate, none is a held-out generalization check.
  PySR has **no built-in train/validation split or cross-validation for model selection at all**.
  Every published "PySR generalizes well" claim you've seen assumes the *user* supplied a
  held-out test set externally (which is exactly what SRBench does, see below).
- Adopt: **call**, with the mandatory external nested-CV wrapper below. Do not trust
  `model_selection="best"` on Gridiron-sized tables without wrapping it — it is a training-loss
  criterion with a complexity tax, not a generalization estimate.

### 3. cavalab/srbench
- License: GPL-3.0. Stars: 319. Last commit: 2026-08-13.
- What it is, verified via `README.md` and `algorithms/` (34 method subfolders incl. `pysr/`,
  `gplearn/`, `feat/`, `operon/`): the standard academic benchmark harness for SR, used by the SR
  research community as ground truth for what "real" out-of-sample performance looks like. Per
  the current README: 25 methods, hyperparameter-tuned, **30 independent runs per dataset**, on
  24 PMLB black-box datasets plus a first-principles (Feynman-equation) set, scored on **held-out
  test R2** and, for the first-principles set, exact symbolic ground-truth recovery under noise.
  This is the harness design to imitate, not code to import — it is a benchmark suite, not a
  library Gridiron would call at runtime.
- Documented finding (original SRBench, La Cava et al., NeurIPS 2021 Datasets & Benchmarks,
  cited from the repo's own materials, not re-derived here): GP-based SR methods can match
  black-box ML on test R2 with far smaller models on many PMLB datasets, but ground-truth
  equation recovery on the first-principles set degrades sharply as noise increases and dataset
  size shrinks — exactly the two conditions Gridiron's tables have (small n, real-world noise,
  no known ground-truth equation to recover).
- Adopt: **borrow-idea** for a private "gridiron-sr-bench" protocol: fixed train/val/test splits
  per feature table, N independent GP/SR reruns per candidate target, report test R2 (or test
  Brier for props) with a bootstrap CI, not a single run's number.

## Gridiron's actual sample sizes (why the guardrail matters more than the algorithm)

From the standing findings and read-only inspection of `fantasy-football-dashboard` (grep only,
no DB queries — the live server capturing Week 1 2026 games was not touched):
- Team-week rows: ~32 teams x 17-18 weeks = ~544-576 rows/season. Even 5 seasons of history is
  ~2,700-2,900 rows, and adjacent weeks within a team are autocorrelated, not i.i.d. — the
  effective sample size for a GP search over team-strength features
  (`server/services/nfl-team-strength.js`) is in the hundreds, not thousands.
- Play-by-play: 251,591 rows total (per tonight's findings) — large in row count but each row is
  not an independent observation of the quantity you'd want SR to model (game-level or
  drive-level outcomes); collapsing to game/drive level shrinks this by 2-3 orders of magnitude.
- Player-week prop features: `server/services/nfl-props-player-features.js` builds a
  `Map<gsis_id, features>` per season from `nfl_player_week_features`, restricted to skill
  positions with three-engine context — a few thousand rows across seasons at most, and far
  fewer for any single stat line (e.g. "RB1 with 15+ carries").
- A default gplearn run already evaluates ~20,000 candidate programs; a default PySR run with 31
  populations over 100 iterations evaluates far more. Searching that many candidate expressions
  against a table of a few hundred to a few thousand rows, then picking the single best training
  loss, is a massive implicit multiple-comparisons problem — structurally the same failure mode
  as tonight's finding that "no trial registry exists ... for the 21-model historical search that
  has already been run." GP/SR without an external holdout is that failure mode automated and
  run 20,000 times per fit.

## Bottom line

Genetic programming / symbolic regression is legitimate, well-built, actively maintained tech
(gplearn and PySR both read as correct, non-toy implementations). The risk is not the algorithm —
it is running either tool the way their own APIs make "easiest" (fit on all your rows, take the
top of the Pareto front) on tables sized in the hundreds to low-thousands of independent rows.
The pilot below is scoped to use gplearn's built-in OOB fitness as a first-pass overfitting
alarm, wrap both tools in an external nested walk-forward split modeled on SRBench's protocol,
and gate promotion on the honest test-set number, not the training-loss "score" either library
reports natively.
