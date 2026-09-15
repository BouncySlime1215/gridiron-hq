# GF06 — Copula / dependence-modeling code for teaser-leg correlation

Target defect: `server/betting/nfl/strategy/teaser-leg-rates.js` (fantasy-football-dashboard,
read-only) — `ticketProbabilities()` assumes same-week/same-game teaser legs are
INDEPENDENT despite `familyPairCorrelation()` in the same file measuring a
same-week rho whose 95% CI `[-0.095, +0.008]` includes zero (so the file itself
declines to apply a correction, correctly, but has no mechanism to apply one if
a future measurement did clear the bar). No copula/dependence model exists
anywhere in Gridiron's betting code.

Four repos cloned to
`.../scratchpad/research2/github/{sdv-dev__Copulas, vinecopulib__pyvinecopulib,
DanielBok__copulae, mattymitch499-sketch__nfl-sgp-model}`. No node_modules/venv
found in any. All read directly (source files, not READMEs) before scoring.

---

## 1. mattymitch499-sketch/nfl-sgp-model — the only genuine sports/parlay example found

- **URL**: https://github.com/mattymitch499-sketch/nfl-sgp-model
- **Stars**: 0. **License**: none present (no LICENSE file → all rights reserved
  by default; treat as reference/borrow-idea only, not verbatim-port).
- **Last commit**: 2026-09-10 (yesterday relative to today 2026-09-12; actively
  worked).
- **What it is**: a personal Rust research repo, NOT a library — a pre-registered
  study of whether NFL same-game-parlay (SGP) prices under-charge for the true
  joint probability of two legs from the same game. It is the single closest
  analog to Gridiron's exact problem: "legs sharing a game, assumed
  independent."
- **What the code actually does** (verified by reading `crates/nfl-sgp/src/stats.rs`,
  17,892 total lines of Rust across the crate, 162 tests):
  - `loo_standardize` (stats.rs:504) — leave-one-out z-score per subject-season,
    so the market's marginal (the player's season-long level) is factored out
    and only within-game co-movement remains.
  - `uniform_scores` (stats.rs:562) — Rüschendorf's distributional transform:
    rank pooled residuals to `(rank-0.5)/n`, ties broken by a seeded xorshift64*
    jitter (not average-rank, which would misprice count stats like passing TDs
    that take only 5-6 distinct values per season — average ranks on ties would
    make the copula unidentified at that value). This is the exact function
    Gridiron needs for spread/total/player-prop legs that are discretized
    (final-margin buckets, TD counts).
  - `empirical_joint(u, v, a, b)` (stats.rs:650) — **the exact function to call**.
    Given two arrays of uniform scores and two `Marginal{p, direction}` (an
    Over/Under threshold expressed as a market-devigged probability, not a
    historical frequency), it counts the fraction of paired historical
    observations where both legs would have won. Zero correlation coefficient,
    zero elliptical assumption — it is the nonparametric empirical copula
    evaluated at tonight's market-implied corner. Returns `None` (not zero) on
    empty input, which is the right behavior teaser-leg-rates.js is currently
    missing (its independence assumption silently returns a number even in
    thin cells).
  - `gaussian_rho` / `gaussian_joint` / `bvn_upper` (stats.rs:679-830) — a
    from-scratch, dependency-free bivariate normal orthant-probability
    calculator (Genz/Drezner-Wesolowsky Gauss-Legendre quadrature, 6/12/20-node
    adaptive by `|rho|`, with the Genz near-unity asymptotic branch for
    `|rho|>0.925`). This is a serious, correct, ~140-line implementation with
    no external dependency — directly portable to JS as a single pure function
    since it needs nothing but `Math.exp/asin/sqrt` and a normal CDF/PPF
    (already present in stats.rs:61-305, also dependency-free, Acklam's PPF
    algorithm).
  - `cluster_bootstrap_joint_difference` (stats.rs:946) — the transport-
    validation machinery: fit the copula on seasons ≤2017, evaluate on ≥2018,
    bootstrap the *difference* between train and test joints (clustering by
    subject-season so bootstrap resamples don't pretend within-season games are
    independent), and refuse to score a family whose difference-CI excludes
    zero at >20% of a 36-point marginal grid. METHOD.md documents a real
    methodological correction here: an earlier (wrong) version of this test
    compared a trained point estimate against a test-only interval and false-
    positive-failed on discrepancies as small as 0.00006, because it ignored
    the training half's own sampling error.
  - Headline measured result (their own words, `tasks/todo.md`, not verified
    independently by me — reported as in-repo output, not an external
    benchmark): primary family `teamtotal_x_passtd` joint measured at 0.352
    against 0.250 under independence; `spread_x_total` control (expected near-
    zero) measured at 0.252 — i.e. their method recovers "no correlation" when
    there shouldn't be any, which is the right sanity check.
- **License risk**: no LICENSE file. Do not copy code verbatim into Gridiron.
  The *algorithms* (empirical copula via rank transform, bivariate-normal
  quadrature, difference-bootstrap transport test) are standard statistics with
  decades of prior art (Rüschendorf 1981, Genz 1992, Drezner-Wesolowsky 1990)
  and are not copyrightable — reimplement from the math, using this repo as a
  worked reference for the exact call shape and gotchas (especially the
  Over/Under sign convention in `Marginal::wins`, which is easy to get backwards
  and which their own doc comment flags as "deliberate and exact complements").
- **Adopt**: borrow-idea / reference-only (cannot "port" without a license, but
  every function above is short enough to hand-reimplement from the doc
  comments and public-domain math cited).

## 2. sdv-dev/Copulas

- **URL**: https://github.com/sdv-dev/Copulas
- **Stars**: 652. **License**: Business Source License 1.1 (DataCebo, Inc.) —
  free to use for anything except operating it as a "Synthetic Data Creation
  Service" for third parties; converts to MIT 4 years after each release. Not
  a blocker for Gridiron (internal use, not a resold SaaS), but it is NOT MIT
  and should be tracked in NOTICES if code is ever vendored.
- **Last commit**: pushed 2026-09-07 — actively maintained (part of the MIT/DAI
  Lab "SDV" synthetic-data ecosystem).
- **What it actually does** (read `copulas/multivariate/gaussian.py`,
  `copulas/bivariate/base.py`, `copulas/multivariate/vine.py`): a real,
  general-purpose Python copula library, not sports-specific — no sports/bet/
  parlay example anywhere in the repo (`find . -iname "*sport*" -o -iname
  "*bet*" -o -iname "*parlay*"` returns nothing).
  - `GaussianMultivariate` (multivariate/gaussian.py) — fits arbitrary marginal
    distributions per column, transforms to normal scores via each marginal's
    CDF + `norm.ppf`, and estimates a Pearson correlation matrix on the normal
    scores. `sample()` draws from the fitted multivariate normal and inverts
    back through each marginal. This is the standard Gaussian-copula
    Monte-Carlo machine.
  - `copulas/bivariate/{clayton,frank,gumbel,independence}.py` under a common
    `Bivariate` base (bivariate/base.py:16-107) — real Archimedean copula
    fitting via Kendall's tau → theta inversion (each family's own closed-form
    or root-find), with `CopulaTypes` enum dispatch (`Bivariate(copula_type=
    'clayton')`). Clayton and Gumbel carry *asymmetric tail dependence*
    (Clayton: lower-tail; Gumbel: upper-tail) — the one thing a plain Gaussian
    copula cannot represent, which matters if e.g. two same-game unders
    co-move more strongly in the "both blow out" tail than a Gaussian would
    predict.
  - `copulas/multivariate/vine.py` — a pure-Python C-vine/D-vine/regular-vine
    implementation (tree-by-tree factorization via `Tree`/`get_tree` in
    `multivariate/tree.py`), independent of pyvinecopulib's C++ engine. Usable
    for a 3+ leg parlay if Gridiron ever needs joint pricing beyond pairs,
    without leaving the Python ecosystem.
- **Gridiron attachment point**: none of Gridiron's runtime is Python — it's
  Node/JS (`server/betting/nfl/strategy/*.js`). Using this library means either
  (a) a one-off offline Python fitting script that dumps fitted theta/rho
  parameters to a JSON file `teaser-leg-rates` reads at startup (cheap, static,
  no runtime Python dependency), or (b) a small Python microservice called from
  Node (real integration cost). Recommend (a).
- **Adopt**: call (as an offline fitting tool, not a runtime dependency) for
  Archimedean tail-dependence fitting once/if a same-game correlation signal
  clears significance; the Gaussian path is simple enough to reimplement
  directly in JS per repo #4 below and skip the dependency entirely.

## 3. vinecopulib/pyvinecopulib

- **URL**: https://github.com/vinecopulib/pyvinecopulib
- **Stars**: 126. **License**: MIT (Thomas Nagler & Thibault Vatter).
- **Last commit**: pushed 2026-09-10 — very actively maintained (this is the
  reference vine-copula implementation in the academic copula literature;
  Nagler is a core author of the R `VineCopula`/`rvinecopulib` packages too).
- **What it actually does** (read `src/pyvinecopulib/core/bicop_base.py`,
  `vinecop_base.py`): Python bindings (pybind11) over the C++ `vinecopulib`
  library. `BicopBase` (bicop_base.py:1-90) is an array-API-agnostic (NumPy or
  PyTorch backend) base class — a pair-copula only needs to supply `pdf`,
  `hfunc1`, `hfunc2` and gets `fit`/`select`/`from_data` for free. Automatic
  family selection (`select`) fits every candidate bivariate family — Gaussian,
  Student-t, Clayton, Gumbel, Frank, Joe, and their rotations/BB1/BB2/BB6/BB7/
  BB8 two-parameter extensions — and picks by AIC/BIC per edge, then builds a
  full R-vine/D-vine/C-vine truncated at whatever tree depth the data supports.
  No sports/bet/parlay example in the repo (checked `examples/`: only generic
  bivariate-copula, vine-copula, discrete-variable, and PyTorch-backend
  notebooks — `01_bivariate_copulas.ipynb` through `10_extending_
  pyvinecopulib.ipynb`).
- **Gridiron attachment point**: this is the "correct, complete" tool if
  Gridiron ever needs a genuine multi-leg (3+) vine with automatically-selected
  asymmetric tail families — but it is a compiled C++ extension distributed as
  Python wheels; there is no JS binding and no vendored WASM build. Integrating
  it means the same offline-Python-fit-to-JSON pattern as repo #2, at higher
  setup cost (native build toolchain) for a capability (full vine, 3+ legs)
  Gridiron's teaser product (fixed two-leg 6-point teasers per
  `TEASER_POINTS` in teaser-leg-rates.js) does not currently need.
- **Adopt**: reference-only for now (accurate mental model of what "the real
  tool" looks like and what family menu it selects from); revisit as
  port/call only if Gridiron adds 3+-leg same-game parlays.

## 4. DanielBok/copulae

- **URL**: https://github.com/DanielBok/copulae
- **Stars**: 163. **License**: MIT (Daniel Bok, 2019).
- **Last commit**: 2025-02-07 — stale relative to tonight (~7 months, no
  activity in 2026), but a mature, feature-complete single-author library, not
  abandoned mid-build.
- **What it actually does** (read directory structure; `archimedean/`,
  `empirical/`, `gof/`): Archimedean copulas (Clayton, Gumbel, Frank, in
  `copulae/archimedean/`) parallel to sdv-dev's, plus two things sdv-dev/
  Copulas lacks: an `empirical/` module (`empirical/empirical.py`,
  `empirical/distribution.py`) implementing the empirical copula distribution
  directly (the same statistical object as `empirical_joint` in repo #1, but as
  a general-purpose fitted/queryable object rather than a one-off function),
  and a `gof/` goodness-of-fit module including `exchangeability.py` (tests
  whether `C(u,v) = C(v,u)` — i.e., whether the dependence is symmetric between
  the two legs, which a Gaussian or Clayton copula assumes but a general
  empirical one does not have to). No sports/parlay example anywhere in the
  repo.
- **Gridiron attachment point**: the `gof.exchangeability` test would be a
  cheap way to *check* whether teaser-leg-rates.js's implicit symmetric-
  treatment of leg order is even justified, before investing in any full
  copula fit. Otherwise redundant with sdv-dev/Copulas' bivariate module for
  Gridiron's purposes, and less actively maintained.
- **Adopt**: reference-only — the `exchangeability` goodness-of-fit idea is
  worth borrowing conceptually; the library itself isn't worth adding as a
  second Python dependency alongside sdv-dev/Copulas.

---

## Bottom line for teaser-leg-rates.js

The right near-term move is NOT to add a Python or C++ dependency to a Node
codebase for a signal that `familyPairCorrelation()` currently measures as
statistically indistinguishable from zero. It is to:

1. Reimplement (from public-domain math, referencing repo #1's exact function
   signatures) `uniform_scores`, `empirical_joint`, and the `bvn_upper` bivariate-
   normal quadrature as three small, dependency-free JS functions callable
   directly from `ticketProbabilities()`.
2. Gate their use behind a difference-bootstrap transport-validation check
   (repo #1's `cluster_bootstrap_joint_difference` pattern) so a correction is
   only ever applied when it has actually cleared a pre-registered bar —
   exactly the discipline `familyPairCorrelation()` already practices by
   reporting rho = -0.044 with a CI that includes zero and taking no action.
3. Treat sdv-dev/Copulas and pyvinecopulib as the escalation path (offline
   Python fit → JSON parameters read by Node) only if a future measurement on
   more same-game leg pairs (current family-pair rho CI is too wide to act on)
   clears significance and/or Gridiron adds 3+-leg parlays where a full vine
   is warranted.
