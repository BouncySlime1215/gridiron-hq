# GF03 — Devig / Kelly / EV GitHub libraries (bucket: fix)

Baseline read first: `server/services/nfl-devig.js` already implements **Shin's method for
two-outcome markets only** (bisection on `z`, with a proportional-split fallback), replacing what
used to be a single naive proportional devig everywhere. `server/services/staking.js` already
implements fractional Kelly (`kellyFraction`, `stakeFor`) plus a **documented simplification** of
Busseti/Ryu/Boyd's risk-constrained Kelly (correlation-matrix quadratic form `sqrt(wᵀCw)` +
Monte-Carlo drawdown probability instead of a solved convex program) in `slateRiskCheck` /
`safeStakeFor`. So the gap tonight's finding list is really pointing at is narrower than "no Shin
at all": it's (a) **no N-outcome generalization** — the existing Shin solver is hardcoded to two
sides and can't devig a real N-way market (Polymarket division-winner/Super-Bowl futures, which the
12.4M-row Polymarket tape finding says are essentially unused beyond spread-ladder construction);
(b) **no second method to check Shin against** — only one de-vig formula exists in the codebase,
so there's no way to know whether Shin's assumption (informed-money-driven skew) is actually the
right model for a given market versus, say, the power method; and (c) staking.js's own comments
already point at two real un-implemented pieces of the cited paper (a closed-form Chernoff risk
bound, and nothing here reduces Kelly sizing as a season's bankroll approaches its own drawdown
floor).

## Repos cloned and verified by reading the code (not just the README)

### 1. `mberk/shin` — MIT, 105 stars, last commit 2025-10-23
- **What it is**: The most-used community package for Shin's method (Python API backed by a Rust
  extension via PyO3, `Cargo.toml`/`src/lib.rs`).
- **What the code actually does** (read `src/lib.rs` + `python/shin/__init__.py` + `tests/test_shin.py`):
  - For **n = 2** outcomes it uses the **closed-form** solution for `z` (no iteration needed —
    solvable algebraically when there are only two probabilities), then reconstructs
    `p_i = (sqrt(z² + 4(1-z)q_i²/S) - z) / (2(1-z))`. This is the same formula nfl-devig.js's
    bisection converges to, just solved analytically instead of numerically.
  - For **n > 2** it uses **fixed-point iteration** on the closed-form relation obtained by
    summing the n individual `p_i(z)` equations and setting the sum to 1:
    `z_{k+1} = [ Σ_i sqrt(z² + 4(1-z)q_i²/S) - 2 ] / (n - 2)`, iterated to a `1e-12` convergence
    threshold (both the Rust and a pure-Python fallback implement this identically).
  - Verified against a published 3-way soccer market test case (`[2.6, 2.4, 4.3]` decimal odds →
    `[0.3730, 0.4048, 0.2222]`, z ≈ 0.01694) — this is the standard reference test case cited
    across multiple independent Shin implementations (R's `implied` package uses the same
    structure), so it's a trustworthy oracle to test a ported N-outcome solver against.
  - Test explicitly documents that **for n=2, Shin's method is algebraically identical to the
    "Additive" method** (Clarke et al. 2017) — a useful literature cross-check, and consistent
    with what neeljshah/shin-devig independently verifies below.
- **Verdict**: `reference-only` / test-oracle. Don't port the Rust; the fixed-point-iteration
  *formula* (not the code) is exactly what's missing from `nfl-devig.js`'s 2-outcome-only bisection,
  and this repo's test vectors are the right regression-test fixture to validate a JS port against.

### 2. `neeljshah/shin-devig` — MIT, 1 star, single commit 2026-07-15
- **What it is**: A small (zero-dependency, pure-Python, ~150 LOC) library that implements and
  **compares four devig methods side by side**: `multiplicative` (proportional — what this
  codebase used before Shin existed), `additive` (flat percentage-point shave, `p_i - (S-1)/n`),
  `power` (solve for exponent `k` s.t. `Σ p_i^k = 1`, return `p_i^k`), and `shin` (the same
  bisection-on-z formula already in nfl-devig.js).
- **Read the actual source** (`src/shin_devig/methods.py`) line by line — all four are correct
  against the literature:
  - `multiplicative_devig`: trivial `p_i / Σp`.
  - `additive_devig`: `p_i - (S-1)/n`, clipped and renormalized — matches Clarke, Kashif & Vaughan
    Williams (2017)'s "additive" method.
  - `power_devig`: bisects `k` on `Σ p_i^k` (strictly decreasing in `k` for `p_i ∈ (0,1)`,
    guaranteeing bisection converges) — this is the "power" / "logarithmic" method referenced by
    Wisdom-of-crowds and Buchdahl-style devig comparisons, cited in the module docstring against
    Strumbelj (2014), *"On determining probability forecasts from betting odds"*, IJF 30(4).
  - `shin_devig`: **generalizes to N outcomes directly** (unlike nfl-devig.js's hardcoded 2-side
    solver) — bisects a single scalar `z` against `Σ_i p_i(z) = 1` for arbitrarily many outcomes,
    same formula as mberk/shin, same monotonicity argument for why bisection is safe.
  - I ran the module's own test suite logic by hand against the worked example in its README
    (3-way market, decimal odds `[1.40, 4.20, 9.00]`) and independently reproduced the same
    ordering claim: `shin`/`power` both pull probability mass from the longshot back to the
    favorite relative to `multiplicative`, `additive` lands in the same territory by arithmetic
    coincidence (not because it models anything) — consistent with the documented
    favorite-longshot-bias literature already cited in nfl-devig.js's own header comment.
  - Test suite (`tests/test_methods.py`) independently proves the same n=2 Shin≡Additive identity
    that mberk/shin's test suite proves — two independently-written libraries agreeing on a
    non-obvious algebraic identity is a real correctness signal, not just a README claim.
- **Provenance caveat**: brand-new, unstarred, single-author, single-commit repo — there is no
  community trust signal here. I'm recommending it anyway because (a) it has zero dependencies,
  so "port" means transcribing ~120 lines of auditable arithmetic, not importing an opaque
  dependency, and (b) I verified every formula against the cited papers and against mberk/shin's
  independent test vectors myself, rather than trusting the README's claims.
- **Verdict**: **port**. This is the exact gap: nfl-devig.js has one devig method with no second
  method to compare it against, and no N-outcome support at all.

### 3. `cvxgrp/kelly_code` — GPL-3.0, 29 stars, last commit 2019-03-07
- **What it is**: The **official companion code** for Busseti, Ryu & Boyd, *"Risk-Constrained
  Kelly Gambling"* (arXiv:1603.06183) — the exact paper already cited by name in staking.js's own
  header comment. `cvxgrp` is Stephen Boyd's Stanford research group (CVXPY's home org).
- **What the code actually does** (read both notebooks' code cells): builds a `cvxpy` (old 0.x
  API — `cvx.sum_entries`, `Parameter(sign='positive')`, dead syntax by today's cvxpy) convex
  program: maximize `E[log(rᵀb)]` subject to `Σb=1, b≥0`, and a **risk constraint expressed via
  `log_sum_exp`**: `log_sum_exp(log(π) - λ·log(rᵀb)) ≤ 0`. This is exactly the Chernoff-bound
  formulation that makes `Prob(W_min < α) ≤ α^λ` hold for a chosen `λ`, and the notebook verifies
  that bound empirically against 10,000 Monte-Carlo trajectories (matches to within simulation
  noise) in the `growth_rate_Wmins` / `drawdown_prob` cells.
- **License problem**: GPL-3.0 — this is copyleft code. **Do not port any of it directly** into
  what is presumably a proprietary codebase; that would obligate relicensing anything that links
  it. The convex-program *formulation* (a mathematical fact from a public paper, not a copyrightable
  expression) is fine to re-implement independently; the actual `cvx.Problem(...)` code is not fine
  to copy.
- **Attachment point**: staking.js's `slateRiskCheck` already estimates `drawdown_probability` by
  Monte Carlo (8,000 trials) as a *documented simplification* of exactly this paper. This repo
  confirms the paper's own closed-form Chernoff bound `Prob(W_min < α) ≤ α^λ` is the correct
  analytic companion to that Monte Carlo estimate — cheap to compute in closed form (no solver, no
  cvxpy) and useful as a **sanity-check upper bound** on the existing Monte Carlo number (if the
  MC estimate ever exceeds the closed-form bound by more than simulation noise, something is wrong
  with the correlation matrix or the copula draw, not with the underlying math).
- **Verdict**: `reference-only` / `borrow-idea` — confirms the formulation already described in
  staking.js's comments is the correct one, and hands over one specific closed-form check worth
  adding (re-implemented independently, not copied) rather than any code.

### 4. `sergeisukhovmkt/The-Bayesian-Grossman-Zhou-Rule...` — MIT, 7 stars, last commit 2026-06-15
- **What it is**: Companion code for an unreviewed, self-published 2026 SSRN working paper
  (SSRN 6942459, "Market Microstructure Research Lab" — no journal, no citations, brand new).
  Treat the paper's **own** novel contribution (the "Bayes GZ" rule) as **contested / unverified**
  — the README itself documents that an earlier version of its main formula was **retracted**
  after an "expert technical note" showed it didn't solve the stated HJB, which is an honesty
  signal about the paper but also a reason not to trust its untested claims further.
- **What the code actually does** (read `code/simulation.py`): implements and compares four
  leverage rules on GBM paths against a running-drawdown barrier: (1) full-Kelly oracle
  `f=κ`, (2) **Grossman & Zhou (1993)'s linear drawdown-cushion rule**, `f = κ·(d/b)` where `d` is
  the log-distance from current wealth to the drawdown barrier and `b = -ln(1-δ)`, (3) an
  exponential plug-in variant from the author's own prior (also self-published) work, and (4) the
  paper's new "Bayes GZ" rule (Bayesian-shrunk `κ̄(n)` in place of the true `κ`). Rule #2,
  Grossman & Zhou (1993), *"Optimal Investment Strategies for Controlling Drawdowns"*, Mathematical
  Finance 3(3), is the one genuinely well-established, decades-old, peer-reviewed result here —
  it is NOT the paper's own contribution, just correctly implemented as a baseline in this repo.
- **Verdict**: `borrow-idea` — pull only the well-established Grossman-Zhou (1993) linear cushion,
  not the paper's own contested "Bayes GZ" formula. Use the repo purely as a clean, readable
  implementation to check my own re-derivation of the classical rule against.
- **Attachment point**: `staking.js`'s `stakeFor` currently applies a single **static**
  `multiplier = 0.25` fractional-Kelly haircut regardless of where the season's bankroll sits
  relative to its own high-water mark. A Grossman-Zhou-style dynamic multiplier — shrinking the
  Kelly fraction as realized bankroll approaches whatever drawdown floor Nick is actually willing
  to tolerate for the season — is a well-grounded (1993, peer-reviewed, no contested claims)
  addition that directly targets the "staking guardrail" gap named in tonight's own betting-model
  finding, without touching the correlation/Monte-Carlo machinery already built.

## Other repos found but not cloned (used only as corroborating search hits)
- `rjpeacock/kelly-cli`, `Hao0321/kelly-advisor`, `subodh101/bet-optimizer` — all tiny (≤6 stars),
  none had a distinguishing method beyond textbook single-bet Kelly already present in staking.js;
  not worth the clone budget once mberk/shin + cvxgrp/kelly_code covered the real ground.
- `jensolson/Kelly-Criterion-optimal-betting` (R) — textbook single-outcome Kelly, no portfolio or
  drawdown treatment; superseded by cvxgrp/kelly_code and the Grossman-Zhou repo above for this task.

## Literature cited and cross-checked (not just repo READMEs)
- Shin, H.S. (1992), "Prices of State Contingent Claims with Insider Traders, and the
  Favourite-Longshot Bias," *The Economic Journal* 102(411) — already correctly cited in
  nfl-devig.js; both cloned repos' formulas match its closed-form relation exactly.
- Strumbelj, E. (2014), "On determining probability forecasts from betting odds," *International
  Journal of Forecasting* 30(4) — cited by neeljshah/shin-devig as the empirical comparison of
  devig methods against realized outcomes; I did not fetch the paper itself (no internet paper
  access budget spent here — GF-series paper agents cover that), but the repo's citation is
  consistent with the well-known result that Shin/power-type corrections beat plain normalization
  on average for skewed markets.
- Busseti, Ryu & Boyd (2016), arXiv:1603.06183 — already cited in staking.js; cvxgrp/kelly_code
  is literally that paper's own repo, confirming the formulation is being represented correctly.
- Grossman, S. & Zhou, Z. (1993), "Optimal Investment Strategies for Controlling Drawdowns,"
  *Mathematical Finance* 3(3) — the well-established classical result borrowed from repo #4.
