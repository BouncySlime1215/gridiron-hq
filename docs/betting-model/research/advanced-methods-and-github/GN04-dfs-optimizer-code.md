# GN04 — DFS lineup-optimizer code survey (bucket: new)

Task: read pydfs-lineup-optimizer + 2-3 similar real lineup-optimization repos,
verify by reading code (not README), and specify the exact new fantasy surface
(correlation/ownership-aware lineup builder) Gridiron could add, tied to data
Gridiron already has.

## Repos cloned and read

Clone dir: `/private/tmp/claude-501/.../scratchpad/research2/github/`

### 1. DimaKudosh/pydfs-lineup-optimizer
- License: MIT (LICENSE file present, standard MIT text).
- Stars: 447. GitHub API `pushed_at` = 2024-03-01, but `git log` on both
  `master` (429db96) and `develop` (bce1d5b) tops out at **2021-09-27**
  ("Release version 3.6.1" / "Update build configs") — the repo has 30+
  version tags (up to at least 2.7.0 visible in `git ls-remote`, changelog
  references 3.6.1 as latest). Effectively unmaintained since 2021 despite
  447 stars and 159 open issues; the `pushed_at` discrepancy is a GitHub
  metadata artifact (repo settings/wiki edit), not new commits.
- What the code actually does (read `pydfs_lineup_optimizer/`):
  - `solvers/pulp_solver.py` + `solvers/mip_solver.py`: single-lineup
    **mixed-integer linear program** (salary cap, position slots, per-site
    roster rules via `sites/sites_registry.py` for DK/FD/Yahoo/etc.).
  - `stacks.py`: hard-constraint stacking primitives — `TeamStack` (N
    players from one team, with optional `spacing` by roster/batting order
    for MLB-style consecutive-order stacks), `PositionsStack` (e.g. force
    QB+2WR from same team), `GameStack` (N players split across both teams
    in one game — the classic NFL shootout stack). These are groups fed
    into the MILP as `min_from_group`/`max_from_group` constraints, **not**
    a correlation matrix — stacking is enforced structurally, there is no
    notion of *how much* two players' outcomes covary.
  - `exposure_strategy.py`: `TotalExposureStrategy` / `AfterEachExposureStrategy`
    cap how often a player/group appears across a multi-lineup export by
    excluding-and-re-solving (used_count / total_lineups ≤ max_exposure).
  - No ownership modeling, no Monte Carlo, no GPP payout simulation
    anywhere in the package — it optimizes point projections subject to
    salary/position/stack constraints and exposure caps, lineup by lineup.
- Adopt: **borrow-idea**. The `TeamStack`/`GameStack`/`PositionsStack`
  constraint vocabulary and the exposure-strategy pattern (min/max % of
  lineups a player can appear in) are worth copying conceptually; the code
  itself is stale, PuLP-dependent, and has no correlation or ownership
  model — not worth porting wholesale into a Node/JS codebase.
- Gridiron attachment point: N/A directly (Python); the *design* maps onto
  a lineup-selection layer described below.

### 2. sansbacon/pangadfs (+ sansbacon/pangadfs-showdown)
- License: MIT. Stars: 7 (pangadfs), 0 (pangadfs-showdown).
- Last commit: pangadfs 2026-08-12 (actively maintained, Python 3.10+,
  pandas/numpy/stevedore plugin architecture); pangadfs-showdown 2021-01-19
  (stale, DK-Showdown captain-multiplier rules only, no correlation logic —
  reference-only, not read further).
- What pangadfs actually does (read `pangadfs/*.py`):
  - Genetic algorithm (population of candidate lineups encoded as index
    arrays; `crossover.py`, `mutate.py`, `select.py`, `populate.py`) instead
    of MILP — trades optimality guarantee for speed and for the ability to
    optimize *non-linear, multi-objective* fitness functions that a MILP
    solver can't express directly.
  - `fitness_multioptimizer_field_ownership.py` +
    `optimize_multioptimizer_field_ownership.py`: this is the genuinely
    relevant piece. It jointly evolves a **portfolio of N lineups** (a
    "lineup set") scored on three weighted components computed on the whole
    set at once:
    1. score component — top-k lineups' summed points + total points,
    2. diversity component — mean pairwise Jaccard or Hamming overlap
       *across the portfolio* (so the 20 lineups you submit don't
       duplicate the same core),
    3. ownership component — `strategy` in {`contrarian`, `leverage`,
       `balanced`}; contrarian/leverage minimize summed ownership,
       balanced rewards variance in ownership across the set.
    All three are min-max normalized and blended by `(score_weight,
    diversity_weight, field_ownership_weight)`.
  - Caveat (verified by grep): no `stack`/`correlat` logic anywhere in
    `pangadfs/*.py` — the "field ownership" fitness is a **linear sum of
    per-player ownership**, not a joint/copula model, and there is no
    within-lineup correlation term at all (a QB+WR stack only helps if the
    underlying point projections already encode that upside; the GA does
    not know two players are correlated). Stacking must come from a
    separate plugin (pangadfs-showdown does captain rules only; no general
    stacking plugin was found in this org's public repos).
- Adopt: **borrow-idea** for the portfolio-fitness formulation (score +
  diversity + ownership jointly optimized across a lineup *set*, not one
  lineup at a time) — this is the right shape for a GPP builder and is
  missing from pydfs entirely. Not a **port** candidate as-is: it's Python/
  pandas/numpy against a Gridiron codebase that is Node/JS with its own
  correlated-sampler already built (see below) — reimplementing the
  fitness function in ~150 lines of JS is less work and less risk than
  bridging languages.

### 3. sansbacon/pangadfs-simslate
- License: Apache-2.0. Stars: 0. Last commit: 2021-01-12, **one commit**.
- Verified by reading the full repo (`.gitignore`, `LICENSE`, `README.md`
  only — no `.py` files exist at all). The README says "pangadfs plugin to
  simulate optimal lineups on slate" but the repository is an empty
  skeleton that was never built out.
- Adopt: **avoid**. Dead end — cite only as evidence that "simulate the
  slate against a field of correlated opponent lineups" is a known-desired
  feature in this ecosystem that nobody has actually shipped as open
  source, which is exactly the gap Gridiron's own correlation engine could
  fill.

## What Gridiron already has (verified by reading the actual files, read-only)

Grepped `fantasy-football-dashboard` for `draftkings|dfs|salary_cap|lineup.*optim|ownership`
and for the correlation/simulation call graph. Findings:

- **No DFS salary-cap lineup optimizer exists anywhere in the codebase.**
  No DK/FD/Yahoo salary ingestion, no MILP/ILP solver, no lineup-selection
  module of any kind for season-long or cash/GPP contests. This is a
  genuinely new surface, not a duplicate of existing work.
- **`server/services/correlation.js`** (204 lines) already does almost all
  the hard statistical work a correlation-aware builder needs:
  - `fitCorrelations()` fits **archetype** correlations (position A,
    position B, same-team|opponent) from `player_week_usage` history —
    QB-WR same team, RB-RB same-team committee (negative), shootout
    same-game lift, etc. — on residuals (player score minus own mean), so
    it isn't confounded by "good players outscore bad players."
  - `correlationMatrix(players)` builds an n×n matrix for an arbitrary set
    of players in one week from those fitted archetypes.
  - `correlatedSampler(players, sortedSamples)` is the reusable primitive:
    Cholesky-factorizes the correlation matrix once, then each call draws
    a **jointly correlated** outcome for every player via a Gaussian
    copula over each player's own empirical sample distribution (from the
    projection model) — cheap enough for a 10k-iteration simulation.
  - This exact function is **already wired into production paths**:
    `server/services/season-sim.js` (weekly/season Monte Carlo) and
    `server/services/draft-lookahead.js` (draft-time season simulation)
    both import and call it. `server/routes/model.js` exposes
    `fitCorrelations().length` as a diagnostic. `server/services/staking.js`
    reuses the same Cholesky/copula machinery for bet correlation.
  - `server/services/nfl-prop-correlation.js`'s own header explicitly notes
    "`correlation.js` already fits archetype correlations, but on FANTASY
    POINTS. **That is the right unit for a lineup simulation**" — i.e. a
    prior engineering pass on this codebase already identified fantasy
    lineup simulation as the natural next use of this exact module.
- **`server/services/projections.js`** (750 lines) is the source of each
  player's point projection / sample distribution that `correlatedSampler`
  consumes as `sortedSamples`.
- What's genuinely missing to ship a DFS optimizer: (a) DK/FD salary data
  — not currently ingested anywhere, but this is a free public CSV/JSON
  export from each site per slate, not a paid API; (b) a lineup-selection
  layer (MILP or GA) that respects salary cap + position slots; (c) an
  ownership/field model — Gridiron has no real ownership feed either (that
  is genuinely paid/scraped on most sites), so the honest v1 is a
  **self-generated field proxy** (chalk heuristic: projected ownership ∝
  value = projection/salary, rank-transformed) rather than claiming real
  ownership data, clearly labeled as a proxy until/unless a real feed is
  added.

## Bottom line

The correlation math for a correlation-aware DFS builder is not a gap —
Gridiron already has a fitted, production-wired, archetype-based Gaussian-
copula sampler for fantasy points (`correlation.js` + `correlatedSampler`)
that nothing in pydfs-lineup-optimizer or pangadfs comes close to (both
those repos treat correlation as either absent, as a hard stacking
constraint, or as a linear ownership sum). What's missing is the
lineup-selection + portfolio layer on top, for which pydfs's stack
vocabulary and pangadfs's multi-objective portfolio fitness are the two
concrete, verified design patterns worth borrowing (not porting).
