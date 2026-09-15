# N08 — DFS-style Lineup Optimization as a New Gridiron Fantasy Surface

Bucket: **new** (per assignment). All candidates below are new-capability; none map to a
tonight's-FOUND defect, so `fixes_finding` = "none — new capability" throughout.

## What Gridiron has today (verified by grep, 2026-09-12)

- `server/services/trade-engine.js:323 bestLineup(players, slots, key)` — a **greedy, single-lineup**
  optimizer: sort by `adj_ppg`, fill required slots then flex slots by descending value. No salary
  cap (there is no DFS salary concept anywhere — "salary" hits in the repo are all NFL *contract* cap
  data from OverTheCap, `server/routes/nfldata.js:173`, `server/services/source-registry.js:157`,
  `server/routes/dev.js:92`, unrelated to DFS). No multi-lineup portfolio, no ownership, no field
  simulation.
- `server/services/ceiling-lineup.js` — a real, working *composition search* that already uses
  `correlatedSampler()` from `server/services/correlation.js` to pick which bench players to swap in
  when the objective is P(score ≥ target) instead of E[score]. This is the one place in the codebase
  that already reasons about winning-probability-under-correlation rather than plain expectation.
- `server/services/correlation.js` — `fitCorrelations()`, `correlationTable()`, `correlationMatrix()`,
  `correlatedSampler()`: **real, fitted archetype correlations from the user's own boxscore history**
  (QB-WR same team r=0.176, RB-RB same team r≈-0.05, WR-WR same team r≈0.011 — per the doc comment at
  `lineup-brain.js:361-382`, tested against league id 7, "My 2026 League"). This is exactly the kind
  of correlation structure the Hunter/Vielma/Zaman and Haugh/Singal papers below build stacking and
  field-simulation on — Gridiron already has the covariance estimation half of the problem; it has
  never been pointed at a multi-lineup construction or a simulated-field win-probability objective.
- `server/services/season-sim.js` — a working Monte Carlo season simulator that already draws
  correlated outcomes via the same `correlatedSampler()` (line 228). Confirms the codebase already
  has Monte Carlo infrastructure that a GPP-field simulator (candidate 4 below) can reuse rather than
  build from scratch.
- Confirmed **absent**: any salary-cap constraint, any ownership projection or ownership data import,
  any multi-entry/portfolio construction, any ILP/MIP solver dependency (`grep -n "lp-solver\|glpk\|
  highs\|javascript-lp" package.json` → no hits), any notion of a DFS contest/field of opponents.
  `bestLineup()` is provably not an integer program — it is O(slots × players) greedy sort-and-fill,
  which is optimal only when slot values are independent, exactly the case the papers below show is
  false once salary caps or multi-entry diversification enter the picture.

This confirms the task's framing: Gridiron has draft/trade/start-sit, and even a season-long
correlation-aware ceiling search, but nothing resembling DFS-style constrained, multi-lineup,
ownership/field-aware construction.

---

## Sources read in full

### 1. Hunter, Vielma & Zaman (2016/2019), "Picking Winners in Daily Fantasy Sports Using Integer Programming"
arXiv:1604.01455 (v3, Jan 23 2019), submitted to INFORMS Journal on Optimization.
https://arxiv.org/abs/1604.01455 — **read in full** (18 of ~24 pages fetched directly, incl. full
formulation, all six sections, tables, and result figures).

- **Model**: the "picking winners" problem — choose k of m possible entries to maximize
  P(at least one wins), proven NP-hard in general (Hunter & Zaman 2017) but the objective U(S) is
  non-negative, non-decreasing, submodular, so a **greedy sequential construction has the classic
  (1 − 1/e) Nemhauser et al. (1978) guarantee**. Because U(S) has no closed form under dependence,
  they derive a tractable surrogate U₂(S) using only pairwise intersection probabilities
  (inclusion-exclusion truncated at 2nd order), then a Gaussian closed-form lower bound U₂ˡ(S) used
  to extract three actionable heuristics: entries should have **high mean, high variance, and low
  pairwise correlation with each other**. This turns into a sequential IP: for lineup i, maximize
  expected score subject to (a) standard DFS feasibility constraints — budget Σcⱼxᵢⱼ ≤ B, exact
  roster size, per-position bounds, min-3-teams-represented — and (b) a variance/correlation proxy
  implemented as **structural stacking constraints** (goalie-stacking: forbid a lineup's skaters from
  opposing its own goalie; line-stacking: force ≥1 complete 3-player forward line + ≥1 partial line;
  defenseman-stacking: restrict to top-power-play defensemen) plus an **overlap constraint**
  Σxₗⱼ*xᵢⱼ ≤ γ bounding how many players lineup i shares with each of the i−1 lineups already built —
  this overlap cap is literally how they encode "low correlation across your own portfolio," and it's
  the mechanism that operationalizes "diversify your entries" as a hard IP constraint rather than a
  vibe.
- **Data / validation**: real DraftKings play, not backtest fiction. 38 real top-heavy NHL contests,
  Oct 21–Dec 31 2015, "several thousand entrants" each; player predictions blended from Rotogrinders +
  DailyFantasyNerd (linear regression per Table 2, R²≈0.24 for skaters). They **actually entered these
  contests with real money** and donated ~$15,000 in winnings to the Greater Boston Food Bank (Fig. 1
  shows real DraftKings screenshots ranking top-10 of thousands of entries on 4 separate nights).
- **Key quantitative result**: stacking matters more than the prediction model. "No stacking" is the
  worst performer at every lineup count (Fig. 4). Their richest stacking type (Type 4: goalie-stack +
  line-stack + defenseman-stack + ≥3 teams) gives the highest mean profit margin at 100 and 200
  simultaneous lineups (~100-120% mean profit margin vs single-digit-to-negative for no-stacking).
  Median profit margin for **one** lineup in a top-heavy contest is **-100%** (you lose your entry fee
  more often than not) but shifts positive and gets a fatter right tail as lineup count rises to 100
  and 200 (Fig. 5 boxplot) — i.e. the "picking winners" framing (enter many correlated-but-diversified
  entries) is a fundamentally different strategy than "build the one best lineup," which is all
  Gridiron's `bestLineup()` does today.
- **Limitation stated by the authors**: they assume all players have equal variance and that
  covariance magnitude is small relative to variance so the true variance/covariance structure can be
  approximated by simple stacking-type indicator constraints rather than a fitted covariance matrix —
  a real simplification. They also note their approach targets *winner-takes-all*-shaped objectives as
  a proxy for the *top-heavy* payoff DFS actually pays, which Haugh & Singal (below) directly critique
  and improve on.

### 2. Haugh & Singal (2021), "How to Play Fantasy Sports Strategically (and Win)"
Management Science 67(1):72-92 (2019 working paper PDF, self-hosted, read in full: all 34 pages
fetched, including full abstract, intro, both key numeric sections, and conclusion).
https://www.columbia.edu/~mh2078/DFS_Revision_1_May2019.pdf ; published version
https://pubsonline.informs.org/doi/10.1287/mnsc.2019.3528

- **Model**: builds directly on Hunter/Vielma/Zaman and fixes its two biggest gaps: (1) it explicitly
  models **opponents' unknown lineups** rather than optimizing a proxy objective that ignores them,
  and (2) it correctly handles **both double-up (beat the median) and true top-heavy payoff curves**,
  not just a winner-take-all proxy. Opponent behavior is modeled as a **Dirichlet-multinomial data
  generating process**: positional ownership shares (e.g. p_QB, the vector of ownership % across all
  rostered QBs) are drawn from a Dirichlet distribution whose concentration parameters α are estimated
  via **Dirichlet regression on real features** — salary, a third-party point projection (FantasyPros),
  recent performance. The DFS decision problem is then reduced, via a mean-variance/order-statistics
  argument, to a **series of binary quadratic programs**, with a submodular-maximization result
  (again invoking Nemhauser et al.) justifying a greedy multi-entry algorithm analogous to Hunter et
  al.'s but now correctly weighted by the *actual* stochastic payoff threshold instead of a fixed one.
- **Data / validation**: real NFL DFS play across the **entire 2017 NFL season, all 17 weeks**,
  double-up, quintuple-up, and top-heavy contest structures on real platforms; double-up fields were
  "around 30,000" opponents with a rank-of-interest around 13,000 (Fig. 8b caption) — genuinely
  large-field, not toy data.
- **Key quantitative results** (Section 6-7, read directly, numbers below are exact from the paper):
  - Their calibrated Dirichlet-regression ownership model's 95% prediction intervals contained
    "around 95%" of realized ownership outcomes at the QB position in a spot-check week (2 of 24 QBs
    fell outside in top-heavy, 1 of 24 in double-up) — the model is honestly calibrated, not just
    fit-looking.
  - The **strategic (opponent-aware) non-insider had roughly 5× the expected P&L of a non-strategic
    benchmark player in top-heavy contests** across the 2017 season (stated directly in Section 7.1).
  - Modeling opponents more precisely (full feature-rich Dirichlet regression vs. a naive deterministic
    ownership assumption) added an **additional ~10% expected P&L** on top of the ~5× strategic gain —
    diminishing but real marginal value from a better ownership model.
  - Insider information (knowing the true realized ownership in advance) was worth only **~20%,
    1%, and 2%** additional expected P&L in top-heavy, quintuple-up, and double-up contests
    respectively — modest next to the ~5× strategic-vs-naive gap, meaning *correctly modeling
    opponents from public features* captures most of the available edge; you don't need illicit
    information to win.
  - Collusion analysis (Table 2): 5 colluding sophisticated players sharing a combined portfolio
    increased expected P&L by 44%, average weekly Sortino ratio by 63%, and cut average weekly loss
    probability by 8 points, vs. those same 5 players each playing independently — a real, measured
    result on the value of coordinated multi-entry diversification, directly relevant to how Gridiron
    would size a multi-lineup exposure cap (candidate 3 below).
  - Concrete calibration misses they document honestly: in week 9 2017, Ezekiel Elliott was owned by
    ~80% of double-up opponents but their model's 95% interval said 0-10%, because the model omitted
    a "recent hot streak" (momentum) feature; in week 12, they overpredicted Tom Brady's ownership and
    underpredicted Russell Wilson's because their input feature (FantasyPros' point projection) didn't
    know Brady's team was playing in Miami, where he historically performed poorly. Both are exactly
    the class of miss a from-scratch Gridiron ownership model would need explicit guardrails against.
- **Stated limitations**: NFL's 17-game season is short for calibrating a per-week model; the paper
  explicitly recommends validating the same framework on higher-frequency sports (NHL/MLB, more games
  per season) as future work, and flags that richer opponent-copula structure (joint dependence across
  positions, not just marginal-per-position Dirichlet draws) is unsolved and may not be
  data-identifiable at all.

### 3. Grody, Bansal & Ashqar (2024), "Optimizing Daily Fantasy Baseball Lineups: A Linear Programming Approach for Enhanced Accuracy"
arXiv:2411.11012 (submitted Nov 17 2024). https://arxiv.org/abs/2411.11012 — **abstract/metadata only,
not read in full** (included for currency — shows the IP/LP approach is still the standard baseline
being published on in 2024, not a dead 2016-era technique); not counted toward the 4 full-read sources.

### 4. (Reference, not separately read in full) Newell & Easton (2017), cited inside source #1
Referenced and summarized inside Hunter et al. (source #1, Section 1.1): a stochastic integer program
that **assumed independent player outcomes** and, per Hunter et al.'s direct account, "did not find
success in real DraftKings contests" — a documented negative result on exactly the independence
assumption Gridiron's own `bestLineup()` and non-ceiling lineup tools make today. Not separately
fetched; cited via source #1's literature review, so not marked read_in_full.

---

## Repos

### DimaKudosh/pydfs-lineup-optimizer
https://github.com/DimaKudosh/pydfs-lineup-optimizer — cloned (708KB, `github/DimaKudosh__pydfs-lineup-optimizer`).
MIT license, 447 stars, 167 forks, last push 2024-03-01 (not archived, still getting releases).
Actually inspected (not just README): it's a Python MIP-based optimizer (`pydfs_lineup_optimizer/
solvers/pulp_solver.py`, `mip_solver.py` — wraps PuLP/CBC) with a real constraint architecture worth
copying the *design* of even though the codebase is Python and Gridiron is Node:
- `stacks.py`: `PlayersGroup` / team-stack rule objects with `min_from_group`/`max_from_group` —
  the OOP generalization of Hunter et al.'s line-stacking/goalie-stacking constraints.
- `exposure_strategy.py`: `TotalExposureStrategy` / `AfterEachExposureStrategy` — caps what fraction
  of N generated lineups a given player can appear in, the practical implementation of Hunter et al.'s
  overlap constraint γ generalized to a per-player exposure cap rather than a pairwise lineup-overlap
  cap.
- `rules.py: ProjectedOwnershipRule`, and `lineup_optimizer.py:251 set_projected_ownership()` — takes
  ownership as an **externally supplied input** (imported from a RotoGrinders-style CSV via
  `lineup_importer.py:37`), not projected by the library itself. Confirms: no OSS tool actually solves
  the ownership-*projection* half of the problem for free — that gap is real and is exactly why
  candidate 2 below (build our own ownership model from Gridiron's own free data) is the genuinely
  new, not-just-copied piece.
- Adoption verdict: **borrow-idea**, not port — the constraint/rule/exposure architecture is worth
  replicating in JS; the Python code itself doesn't attach to Gridiron's Node/Express/SQLite stack.

### JWally/jsLPSolver
https://github.com/JWally/jsLPSolver — not cloned (evaluated via `gh api` metadata only; small,
single-purpose library, no need to pull code to assess fit). Unlicense (public domain), 463 stars,
pushed 2026-07-10 (actively maintained today, not abandoned). Pure JS, zero dependencies, supports
mixed-integer/binary variables via branch-and-cut, runs in plain Node — this is the actual solver
Gridiron would add as a real dependency to replace `bestLineup()`'s greedy sort with a true IP solve
(budget + position + team + stacking + overlap constraints, exactly Hunter et al.'s formulation in
Eq. 4.9). Adoption verdict: **call** — add as an npm dependency and call it directly from a new
`server/services/dfs-lineup-optimizer.js`; no fork or port needed.

---

## Do not do

- Do not build automated real-money contest *entry submission* to DraftKings/FanDuel — that is a
  financial-transaction/ToS/credential problem outside this tool's remit (and outside the assistant's
  permitted actions); ship lineup construction + export (CSV in DK's own upload format), stop there.
- Do not scrape or reconstruct RotoGrinders'/paid ownership-projection products — build the ownership
  model from Gridiron's own already-owned free inputs (public DK/FD salary CSVs, the Vegas implied
  team totals already computed in `nfl-spread-context.js`, target/snap-share already computed in
  `weekly-trends.js`) per Haugh & Singal's feature list, not by paying for or copying a vendor's number.
- Do not assume independent player outcomes when constructing multi-lineup portfolios — this is the
  exact mistake Newell & Easton's real-world failure and tonight's ensemble/drive-sim findings both
  illustrate in different subsystems; Gridiron already has fitted correlations in `correlation.js`, so
  there's no excuse to re-introduce the independence assumption in a new optimizer.
  do point-maximization the way `bestLineup()` does; Hunter et al.'s own boxplot shows a single
  point-maximizing lineup has a **median -100% profit margin** in a top-heavy structure — the wrong
  objective produces a strategy that reliably loses.
- Do not silently port this into the season-long ESPN redraft start/sit surface
  (`lineup-brain.js`/`ceiling-lineup.js`) as if it's the same problem: DFS multi-entry/ownership
  reasoning is about *your portfolio vs. a field of thousands of other portfolios drawn from a
  population*; season-long start/sit is a single roster with no opponent portfolio pool at all. The
  existing doc comment in `lineup-brain.js` (lines 361-382) already found empirically that 7 of 10 real
  season-long optimal lineups contain zero same-team pairs — stacking logic that's correct for DFS is
  largely inapplicable there. Keep this a clearly separate surface/table, not a bolt-on to start/sit.
- Do not trust a from-scratch ownership model's point estimate uncalibrated — Haugh & Singal's own
  documented misses (Ezekiel Elliott week 9 2017, Tom Brady week 12 2017) show even a published,
  validated Dirichlet-regression model can be off by 70+ points of ownership share when a feature
  (momentum, situational context) is missing; ship prediction intervals, not just point ownership %,
  and flag low-confidence weeks rather than let the optimizer trust a bad ownership number silently.
