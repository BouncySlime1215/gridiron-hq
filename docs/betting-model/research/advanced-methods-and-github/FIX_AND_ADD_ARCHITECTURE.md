# Fix & Add Architecture — Informing Document for Tonight's Build Plan

Synthesized from 18 F-notes, 10 GF-notes, 18 N-notes, 10 GN-notes (56 research files,
~10,500 lines) plus the cross-chunk scoring pass. Companion file: `GITHUB_BUILD_CATALOG.md`
(every repo, split fix/new, with a "build from this now" shortlist and an avoid list).

---

## (a) Plain words, to Nick

**What's genuinely worth fixing.** Six things are load-bearing and cheap: (1) the drive
simulator's away-team win-probability uses the home team's spread — a one-line sign flip;
(2) its home-field advantage is a coin-flip +7, which manufactures a fake spike exactly at
the key number bettors care about most; (3) its kneel/timeout machinery has a real
timeout-never-decrements bug (the "inverted kneel rule" half is less clear-cut on inspection
— verify before touching it); (4) five different files each compute "closing line value"
with different math, different sign conventions, and different tables — nobody today can
answer "what was our edge" with one number; (5) the -2.28 CLV ensemble blend is 20 models
that are really ~3 independent signals shrunk 63% toward the market, not a real combination;
(6) the fantasy weekly-learning loop has captured zero forward snapshots, ever, because two
separate null-guards silently skip Week 1 instead of falling back to the structural
projection the same codebase already knows how to compute. All six are real, all six are
grep-verified against the live file and line number, and all six are hours-to-days, not
weeks. Do these first regardless of anything else in this document.

Two more are worth fixing but need more care: the team-strength blend is provably
opponent-blind (two teams with the same raw average margin against different schedules get
identical ratings) — a closed-form ridge fix (hours) beats a full state-space rewrite
(weeks) on the literature's own evidence, so do the cheap one first. And the props module —
Gridiron's one area of real measured skill — is running fixed method-of-moments dispersion
constants where a real hierarchical model would let uncertainty widen honestly for
low-sample players; this is worth building, but it needs a Python/pymc toolchain Gridiron
doesn't have yet, so it's a "start this week, ship next" item, not a tonight item.

**What's genuinely worth adding, and why.** Three additions pay for themselves without
touching anything fragile: a real trial registry with append-only preregistration and
Holm/PBO/deflated-Sharpe correction (the 21-model historical search has never had one — this
is table stakes for trusting any of the other numbers in this document); split-conformal
prediction intervals (crepes-style, ~30 lines of JS) replacing the ad hoc "resample residuals
and inflate by disagreement/30" hack that self-labels `production_eligible: false`; and a
real empirical replacement-level for handcuff/backup valuation (nflWAR's roster-based
method) replacing a hand-typed constant table that its own author's comment calls "a
monotone prior, not production coefficients." Two more are worth a bounded pilot, not a
rewrite: a depth-chart usage-propagation graph (nothing today redistributes a departing
player's targets/carries to specific teammates — that's a real, fantasy-first gap the
literature confirms nobody has built either, in-house or open-source) and a Cox
proportional-hazards survival model for dynasty aging (replacing a hand-typed literature
table with an actual fitted curve-with-uncertainty on Gridiron's own data, once a one-time
historical-player-season import lands).

**What's honestly not worth doing tonight.** Genetic-programming/symbolic-regression feature
discovery, mixture-of-experts learned gating, deep generative play-sequence models, and
reinforcement-learning play-calling are all real, well-built, actively-maintained
technologies — and every one of them needs 10-100x more independent observations than
Gridiron's few-hundred-games-per-season tables carry to avoid learning noise instead of
football. The honest verdict across five separate researchers who each independently
checked this against the actual literature's own sample sizes is the same: build the
guardrail (a nested walk-forward harness, an out-of-bag overfitting alarm, a governed
paired-comparison test) before the model, not after, and expect a modest win at best. Two
whole research areas — live NFL Twitter/Reddit sentiment and cross-venue Kalshi/Polymarket
arbitrage — turned up thin-to-negative evidence even in their own best case (Polymarket NBA
arbitrage nets $210-560 total across an entire league-month; the one real sentiment effect
that replicates is a bookmaker popularity bias that's already correctly priced, not a
standalone edge). Don't build execution infrastructure for either.

---

## (b) Reading list — every source read in full, grouped by theme, with counts

Counts below are conservative: a source only counts as "read in full" where the researcher's
own note says so; abstract-only, paywalled, or "cited via a secondary summary" sources are
called out separately and excluded from the headline count, exactly as the researchers
themselves flagged them.

### FIX-bucket reading (18 F-notes + 10 GF-notes)

| Theme | Notes files | Primary sources read in full | Repos cloned/inspected |
|---|---|---|---|
| Drive-sim mechanics (turnover flip, clock units, kneel/timeout, HFA, OT) | F01, GF01, GF02, GF09 | 3 academic papers (Williams/Palmquist/Elmore; Pelechrinis; Yurko/Ventura/Horowitz) + nflverse's own model-training source | 18 repos (incl. 5 explicitly rejected: soccer-physics engine, garbage-time-excluded sample, no-OT engines) |
| Forecast combination (nfl-ensemble.js's 0.68+0.632·market shrinkage) | F02 | 4 (Yao/Vehtari/Simpson/Gelman stacking; Claeskens et al. combination puzzle; Giacomini-White; Diebold-Mariano) | 2 (johntwk/Diebold-Mariano-Test, ceweiss/ForecastComb) |
| Devig methods (Shin vs. power vs. additive vs. multiplicative) | F03, GF03 | 2 fully + 1 corroborated-only (Clarke et al., paywalled 403 across 4 hosts) | 8 cloned + 4 mentioned-not-cloned |
| CLV unification & audit architecture (5 disagreeing implementations, 37 duplicate hashers) | F04, F18, GF05 | 8 (Hubáček-Šír; Bailey/López de Prado PBO+DSR; Buchdahl; Outlier.bet; Sculley et al. Hidden Tech Debt; Breck et al. ML Test Score; Chen et al. MLflow; Uber Michelangelo) | 5 |
| Bitemporal / point-in-time data (receipt-clock bug) | F05 | 4 (Akidau Dataflow Model; Kulkarni-Michels SQL:2011; Snodgrass textbook; Databricks PIT docs) | 3 (arkhipov/temporal_tables, scalegenius/pg_bitemporal, xtdb/xtdb) |
| Trial registry / multiplicity correction | F06, GF10 | 4 (Bailey-López de Prado DSR; Bailey et al. PBO; Holm 1979; Harvey-Liu Backtesting) | 4 (quantskills, purgedcv, Aliipou, mnemox-ai) |
| Sequential inference / always-valid p-values | F07 | 4 (Howard/Ramdas/McAuliffe/Sekhon confidence sequences; Waudby-Smith-Ramdas betting; SAFFRON; Johari/Pekelis/Walsh) | 1 (gostevehoward/confseq, reference) |
| Team-strength state-space / shrinkage | F08, F15, GF04 | 8 (Glickman-Stern 1998 + 2016 chapter; Koopman-Lit; Ley et al.; Efron 2010; Brown 2008; Ragain/Peysakhovich/Ugander) | 9 (incl. LeoEgidi/footBayes, martineastwood/penaltyblog, greerreNFL/nfelosrs) |
| Hierarchical Bayesian prop distributions | F09 | 4 (Baio-Blangiardo; Whitaker et al.; Jensen/McShane/Wyner; PyMC Efron-Morris) | 0 (Python-toolchain gap, no repo needed beyond PyMC docs) |
| Copula / dependence modeling | F10, GF06 | 4 (Haugh copula notes; Aas/Czado/Frigessi/Bakken pair-copula; van der Wurp et al. GJRM; Wizard of Odds) | 4 |
| Conformal calibration | F11, GF08 | 3 (Angelopoulos-Bates; Romano/Patterson/Candès CQR; Barber/Candès/Ramdas/Tibshirani NexCP) | 8 (MAPIE, crepes, cqr, conformal-time-series, EnbPI, +3 reference) |
| Cold-start / transfer learning (fantasy weekly-learning loop) | F12 | 4 (Brown 2008; Oreshkin meta-learning; Rome fantasy-football blog; FiveThirtyEight/Reef Data Lab Elo) | 0 |
| Causal news-to-decision impact | F13 | 4 (Chernozhukov et al. DML; Lopez-Bliss bye advantage; Angelini-De Angelis prediction markets; MacKinlay via Ødegaard notes) | 0 |
| Entity resolution (game/team/player keys) | F14, GF07 | 2 (Fellegi-Sunter via Splink docs; Dasylva et al.) | 5-6 (splink, dedupe, recordlinkage, read by two independent agents) |
| Favorite-longshot bias vs. devig | F16 | 4 (Snowberg-Wolfers; Ottaviani-Sørensen ×2; Hegarty-Whelan) | 0 |
| Margin-distribution literature | F17 | 3 fully + 1 corroborated-only (Stern 1991, paywalled) | 0 (uses Gridiron's own margin-distribution.js as ground truth) |

**Fix-bucket total: ≈65 primary sources read in full, ≈65 repos cloned or inspected.**

### NEW-capability reading (18 N-notes + 10 GN-notes)

| Theme | Notes files | Primary sources read in full | Repos cloned/inspected |
|---|---|---|---|
| Time-series foundation models | N01, GN01 | 4 (Chronos; TimesFM; Moirai; Lag-Llama) | 4 (metadata-verified, deliberately not cloned — inference-only pip installs) |
| Graph neural networks (roster/matchup) | N02, GN02 | 4 (Luo-Krishnamurthy GATv2-TCN; HIGFormer; basketball GCN+RF; Xenopoulos-Silva) | 6 |
| Transformers on play-by-play | N03, GN03 | 4 fully + 2 abstract-only (EventGPT, axial-transformer) | 7 (incl. 1 cloned-then-deleted per instructions) |
| LLMs as direct numerical forecasters | N04 | 4 (Halawi et al.; Schoenegger et al.; Paleka et al.; Hsieh et al. RTF) + 1 unverified vendor blog (flagged, not counted) | 2 |
| Prediction-market mining | N05, GN05 | 4 (Dubach microstructure; Cheng/Yang/Zou arbitrage; Nechepurenko; Wolfers-Zitzewitz) | 3 |
| RL for drive-sim & staking | N06 | 4 (Biro-Walker MDP; risk-preference inverse-optimization; Beggy et al. Kelly; Zhang/Zohren/Roberts trading-RL) | 1 |
| Live in-game win probability | N07, GN07 | 4 (Lock-Nettleton; Baldwin/nflfastR; Yurko-Ventura-Horowitz; Burke AFA) | 6 |
| DFS lineup optimization | N08, GN04 | 2 fully + 1 metadata-only + 1 cited-not-fetched | 5 |
| Generative augmentation for small-n | N09 | 4 (Zhan et al.; SportsNGEN; CVRNN-football; small-tabular-augmentation eval) + 1 abstract-only | 0 |
| Mixture density / normalizing flows | N10, GN06 | 4 (Bishop MDN 1994; DeepAR; conditioned normalizing flows; LSTM-MDN VaR) | 4 |
| AutoML / genetic programming | N11, GN08 | 4 fully + 3 secondary/abstract-only | 8 |
| Mixture-of-experts / learned gating | N12 | 5 (Shazeer MoE; Switch Transformers; Soft MoE; Jordan-Jacobs HME; Qian et al. combination puzzle) | 0 |
| Injury-network propagation | N13, GN09 | 4 (nflWAR; Ibrahim O-line spatial framework; Xenopoulos-Silva; Gregory-Smith wages) | 6 |
| Alternative-market arbitrage (Kalshi/Polymarket) | N14 | 4 fully + 3 abstract/secondary | 0 (deliberately: GitHub search returned malware-pattern spam) |
| Route/coverage proxies from public PBP | N15 | 2 data dictionaries + 1 substack analysis + 1 arXiv paper, all read in full | 0 |
| Dynasty aging curves (modern) | N16, GN10 | 4 (Baseball Prospectus delta-method-revisited; Schuckers/Lopez/Macdonald; Yu-Hu load-management paradox; Harstad mortality tables) | 4 |
| Weather / venue causal effects | N17 | 2 fully + 2 abstract/paywalled | 3 (metadata-only, Python/Node mismatch) |
| Social & market sentiment | N18 | 2 fully (Sinha et al.; Lachanski-Pav replication) + 1 abstract-level + secondary literature-search pass | 0 |

**New-capability total: ≈57 primary sources read in full, ≈46 repos cloned or inspected.**

Grand total across both buckets: **≈122 primary sources read in full, ≈111 repos** —
consistent with the ~90-repo target the task named plus the paper-only researchers' own
supplementary repo checks.

---

## (c) THE FIX LIST — ranked, tied to tonight's exact findings

Ordered fantasy-first, then simulation (drive-sim bugs), then betting-model, then
audit-method, per Nick's own priority. Score and vote count are carried over from the
cross-chunk scoring pass; "builds X/Y" means X of Y independent scoring passes said
build-or-test-first (not reject/later). Every item below is grep-verified in the actual
live file, not assumed from a docstring.

### Fantasy

1. **Cross-season transfer for the ensemble heads** *(score 14.5, 2/2)* — `priorScores()`
   in `player-week-engine.js:123-126` queries only `season=? AND week<?`, never crossing a
   season boundary, so `weeklyEnsembleContext()` always sees `priorWeeks=[]` at Week 1.
   Mechanism: fall back to the same player's prior-season weeks with the season-decay weight
   Gridiron's own `projections.js` already ships (`SEASON_WEIGHT={0:1,1:0.55,2:0.28,else:0.12}`).
   Cost: hours. Exit test: Week-1 `heads` is non-null for any player with prior-season history.
2. **Structural fallback + always-capture snapshots** *(score 14.5, 2/2)* — companion fix.
   `weekly-learning.js:69` does `if (!engine?.heads) continue`, silently discarding every
   Week-1 player from `weekly_prediction_snapshots` forever. Mechanism: mirror the identical
   fallback pattern already shipped in `player-head-registry.js:55` (degrade to structural,
   never null) and capture a `mode='cold_start_structural_only'` row instead of skipping.
   Cost: hours. Exit test: Week 1 produces >0 forward snapshots for the first time ever.
3. **Zero-shot TSFM forecast as the cold-start strategy** *(score 13.0, 1/1)* — same defect
   as #1/#2, alternate mechanism: a Chronos-2/TimesFM cross-learning batch job over the
   pooled 32-team panel gives a genuinely out-of-sample Week-1 forecast instead of a silent
   no-op. Cost: hours (cheapest candidate in the whole N01 chunk). Exit test: does the
   zero-shot forecast beat "return nothing" on Week-1 games specifically, walk-forward.
4. **Truncated-imputation/IPW correction wherever a refit age curve or hazard model uses
   "still-active players' usage trend" as a feature** *(score 13.0, 3/3)* — two independent
   sources (Annals of Operations Research; a 2026 arXiv paper) show this selection bias can
   *reverse the sign* of the true relationship. Mechanism: bake Schuckers/Lopez/Macdonald's
   truncated-imputation (or the heavier IPW/MSM correction) into any N16-1/2/3 fitting script
   as a precondition, not an optional extra. Cost: days. Exit test: does the corrected curve
   differ in sign or magnitude from the naive fit on a held-out retired-player cohort.
5. **TSFM predictive quantiles as an honest uncertainty check on prop point estimates**
   *(score 11.0, 2/2)* — `TEAM_PASS_ATTEMPT_DISPERSION=47` and similar hand-fit constants in
   `player-week-engine.js` carry no measured uncertainty; a diagnostic-only TSFM quantile
   check probes the gap without touching production. Cost: cheap. Exit test: does the
   TSFM interval's coverage disagree materially from the fixed-dispersion NB's implied one.
6. **Hierarchical NB dispersion for team-level pass-attempt/carry counts** *(score 12.0,
   3/3)* — `TEAM_PASS_ATTEMPT_DISPERSION=47`/`TEAM_RUSH_CARRY_DISPERSION=31` in
   `player-week-engine.js:50-51` and the method-of-moments dispersion formula in
   `projections.js:478-480` are fixed point constants with zero propagated uncertainty.
   Mechanism: Whitaker et al.'s player-level hierarchical Poisson/NB structure, fit offline
   in a new `pymc`/`numpyro` research environment (currently absent — `research/.venv` has
   scipy/sklearn only). Cost: needs a new toolchain first (see Add list); the fit itself is
   days once the toolchain exists. Exit test: run the walk-forward suite first — check
   whether today's fixed-dispersion model already handles the low-history split fine before
   committing to the new dependency.
7. **Hierarchical prior on the shrinkage constant `k`** *(score 10.7, 2/3)* — `shrinkage-fit.js`'s
   `k*=σ²within/σ²between` is a method-of-moments point estimate with a special-cased
   `k=Infinity` fallback (line 88) for exactly the low-sample case it should instead put a
   prior on. Cost: days, reuses the module's existing walk-forward suite. Exit test: must
   clear that suite without regressing Brier/RMSE before replacing the point estimate.
8. **Genuine hierarchical NB/Poisson count model for touchdowns** *(score 9.7, 2/3)* — targets
   the codebase's one area of *proven* skill (2+ TD Brier +27%), replacing `td-regression.js`'s
   mislabeled "Poisson standard error" (`se=sqrt(expected)`, a Wald-normal heuristic) and the
   scalar ridge-logistic TD-probability heads. Caution: two prior TD-model challengers already
   failed this exact promotion gate (0/3, 0/3) for a diagnosed *grain* problem, not a
   distribution-shape problem — try the cheaper fixes above first. Cost: weeks. Exit test:
   must clear `walkForwardChallengerTd` before touching `calibrateAnytimeTd`.

### Simulation (drive-sim / live win-probability)

9. **Fix the away-team win-probability sign bug** *(score 15.0, 3/3 across three
   independent verifications)* — `nfl-sim-policy.js` computes `lead` per-possession
   (home/away flipped for the offense) but passes the same un-flipped `spread` into
   `liveWinProbability()`, whose own docstring requires both in the home-team frame. Every
   away-possession policy call (kneel, onside, 4th-down-by-WP, variance profile) is silently
   mispriced. Mechanism: port nflfastR's one-line `posteam_spread = home ? spread : -spread`
   transform. Cost: hours. Exit test: `home_wp + away_wp == 1` for every possession state.
10. **Remove the flat 7-point post-OT HFA lump** *(score 14.3, 3/3)* — `nfl-drive-sim.js`:
    `if (homeFieldPoints>0 && random()<homeFieldPoints/7) home+=7` — a single Bernoulli draw
    of exactly +7 applied after both halves and OT are already final. No real nflverse WP
    model adds HFA as a post-hoc additive constant; it corrupts the score distribution
    exactly at the key number (7) the whole betting-model stack cares about. Mechanism: fold
    HFA into a per-drive/per-play feature (or at minimum a pregame probability shift, per
    fivethirtyeight/nfl-elo-game's architecture) instead of a coin flip on the final score.
    Cost: hours (relocate) to days (thread into per-play rates properly). Exit test: no
    anomalous spike in `[6.5, 7.5]` relative to neighboring 1-point bins.
11. **Wire the already-computed timeout spend/hold decision to actually decrement
    timeouts; verify the kneel-rule claim before "fixing" it** *(score 12.7, split)* —
    confirmed real: `timeoutPolicy()`'s decision at `nfl-drive-sim.js:475` is computed but
    never written back to `timeouts[possession]` — a leading team is never actually
    threatened by the defense's remaining timeouts. **Caution**: one independent
    verification pass read `kneelDecision()` (`nfl-sim-policy.js:290-302`) directly and found
    it logically correct (kneel only when leading and remaining time is less than the
    opponent's timeouts could buy back) — the "inverted" half of this defect needs a concrete
    game-state trace to confirm before touching it, separately from the timeout-decrement
    half, which is unambiguous. Cost: hours for the decrement wiring. Exit test: force
    `timeoutPolicy` to return "spend" 3 times in a half; the 4th attempt must no-op.
12. **Two-regime overtime, correctly scoped** *(score 11.3, split)* — the season-remainder
    simulator (`simulateRemainder()`, line 773+) genuinely has no halftime or OT branch at
    all — a `while(clock>0)` loop that just ends, possibly tied, with no resolution.
    **Caution**: `simulateGame()`'s own OT block (lines ~540-558) already exists with a
    both-teams-possession rule before sudden death — the honest gap is narrower than "no OT
    anywhere," and a fix should share `simulateGame()`'s existing logic rather than a
    from-scratch port of nflfastR's full two-regime (pre/post-2012) branch. Cost: days once
    correctly scoped. Exit test: chi-square goodness-of-fit against Moyer et al.'s empirical
    2015-2023 OT score-pair table (3-0: 74, 6-0: 49, 6-3: 13, 0-0: 7, 3-3: 2, n=145).
13. **Down/distance/possession/timeout-aware live WP model** *(score 9.7, 2/3)* — `nfl-live.js`'s
    own docstring admits zero state-awareness by design. Bigger lift than #9-#12: this is a
    genuinely new model to train (logistic → xgboost), not a bug fix, and the payoff is
    concentrated in the final-two-minutes window the current model already flags as its known
    weak spot. Cost: days-to-weeks. Exit test: Brier/calibration backtest vs. nflverse's own
    `wpa` column before it replaces the current normal-CDF estimator.

### Betting-model (team-strength, ensemble, devig, copula, conformal, weather)

14. **Closed-form ridge fix for team-strength opponent-blindness** *(score 13.3, 3/3)* —
    `blendedTeamRating`'s in-season mean is a team's raw average margin, provably blind to
    opponent strength (two teams with identical raw average margin against different
    schedules get identical ratings today — this is checkable by construction, not a claim).
    Mechanism: Glickman & Stern's own closed-form paired-comparison ridge estimator,
    `θ̂=(X'X+λI)⁻¹(X'y+λγ)`, refit weekly with `γ` = the existing prior-season blend. Cost:
    hours — a single matrix solve, no MCMC, no Kalman recursion, no new dependency. Exit
    test: run through the existing `teamStrengthWalkForward` promotion gate (needs ≥2 of 3
    seasons significant) before touching production. **This is the single cheapest,
    highest-confidence item in the entire betting-model bucket.**
15. **Split-conformal quantile replacing the Gaussian win-probability read** *(score 14.0,
    2/2)* — `nfl-market.js:435`: `normalCdf(predMargin/marginStd)` off one pooled global SD
    for every game. Mechanism: replace with a split-conformal quantile of the same residuals
    the file already computes (`marginResiduals`/`totalResiduals`, lines 174-181). Cost:
    hours (~15 lines). Exit test: finite-sample coverage check on held-out games.
16. **NexCP-weight `bootstrapProb()`'s existing residual resampler** *(score 13.5, 2/2)* —
    `nfl-market.js:199-220` already resamples real historical residuals (a good instinct) but
    draws *uniformly* from 1999-2024 pooled residuals with no recency weighting, contradicting
    the same file's own fitted season-carryover decay parameter. Mechanism: exponential-decay
    weighted quantile (Barber/Candès/Ramdas/Tibshirani's NexCP). Cost: hours — surgical fix
    to code that already has the right shape. Exit test: does weighted coverage beat
    unweighted at matched sample sizes on a held-out season.
17. **DML-adjusted causal estimate for verified injury designations → closing spread**
    *(score 13.0, 1/1)* — feeds `nfl-ensemble.js`'s existing `candidate_shrink_only` diagnostic
    mode (line 1311) to test whether the ensemble's news features are redundant with what the
    market has already priced. Cost: days (cross-fitting, needs 100+ examples per position
    tier). Exit test: does the sign/magnitude replicate on an independent slice (first vs.
    second half of the season) before it's trusted for anything.
18. **Split-conformal replacement for `predictiveDistribution()`'s residual-inflation hack**
    *(score 12.7, 3/3)* — `nfl-ensemble.js:207-251` self-labels `production_eligible: false`
    and `calibration_state: 'research_distribution_only'`; the mechanism is an all-history
    residual pool plus an ad hoc `disagreement/30` inflation multiplier. Mechanism: crepes-
    style split-conformal, Mondrian-binned by spread bucket. Cost: hours-to-days. Exit test:
    real backtested coverage number before flipping `production_eligible`.
19. **Real devig method replacing the assumed-normal spread-to-probability proxy** *(score
    11.7, 3/3)* — `prediction-markets.js`'s `exchangeVsBook()` uses `normCdf(-spread/14.16)`
    and its own docstring admits this is an approximation, not a quoted no-vig price.
    Mechanism: Shin/power/multiplicative devig, already implemented for two-outcome markets
    elsewhere in Gridiron (`nfl-devig.js`) — extend, don't reinvent. Cost: hours. Exit test:
    Brier improvement on real historical Kalshi/book pairs before any cross-venue signal
    built on top of it is trusted.
20. **Copula extension to team-leg×player-prop pairs** *(score 11.7, 3/3)* — the one place
    "legs sharing a game, assumed independent" is literally true today: a spread/total leg
    combined with a player prop in the same game has zero dependence model (teaser legs, by
    contrast, structurally never share a game — `same_game_pairs: 0`, confirmed). Mechanism:
    extend `nfl-prop-correlation.js`'s existing Gaussian-copula machinery to cover this pair
    type. Cost: days, no schema change. Exit test: gate on the same `sgpQuoteEvidence`
    forward-CLV bar (≥50 paired quotes, positive mean CLV) the existing SGP pricing already
    clears.
21. **Fix the provably-wrong independence assumption for nested same-game legs** *(score
    11.0, 3/3)* — spread-cover is a strict mathematical subset of moneyline-win, so pricing
    them as independent is provably wrong, not just imprecise. Mechanism: reuse the existing
    correct empirical-PMF machinery (`signedMarginDistribution()`), not new copula code. Cost:
    days. Exit test: only matters if the combinatorial (moneyline+spread) detector this feeds
    is actually greenlit — the notes rate that detector reject-leaning for NFL specifically.
22. **CQR for covariate-adaptive margin/total interval width** *(score 11.0, 2/2)* — the
    single global `marginStd`/`totalStd` gives a 3-point pick'em and a 17-point blowout the
    identical interval width today. Mechanism: conditional-quantile conformal (Romano et al.,
    NeurIPS), a linear pinball-loss fit, not a heavy quantile-regression stack. Cost: days.
    Exit test: build only if #15's flat-width split-conformal interval is shown materially
    miscalibrated across lopsided vs. close games — cheaper baseline first.
23. **CQR via LightGBM quantile regressors already available in `research/tree_lab.py`**
    *(score 11.0, 2/3)* — natural extension of #22 once a base method exists; `tree_lab.py`
    already has LightGBM + a `QUANTILES=[0.1,0.25,0.5,0.75,0.9]` scaffold. Cost: days. Exit
    test: must beat #22's width at matched coverage before replacing it — sequence after,
    don't parallel-build.
24. **Non-Gaussian pairwise copula option (Student-t/Clayton), gated on a goodness-of-fit
    test** *(score 10.7, 3/3)* — the Gaussian copula in `stats-util.js`/`nfl-prop-correlation.js`
    has zero tail dependence by construction; a real (financial-data) result shows a single
    Gaussian assumption can understate tail-dependence 29x. Mechanism: per-archetype K(z)
    goodness-of-fit test decides Gaussian-vs-t-vs-Clayton, not a blanket switch. Cost:
    days. Exit test: run the K(z) fit on Gridiron's own archetypes first — no NFL-specific
    evidence yet that prop pairs show enough tail asymmetry to matter.
25. **Wire the already-computed per-team `wind_epa_delta` into `weather_total`** *(score
    11.3, 3/3)* — `nfl-features.js` already computes real per-team dome/wind EPA deltas at
    lines 209-211/386-388; `nfl-ensemble.js`'s `weather_total` throws them away in favor of
    one flat `-2.4` applied identically to every team. Cost: hours — cheapest, best-evidenced
    fix in the weather bucket. Exit test: split high-pass-rate vs. high-rush-rate teams,
    where the flat constant should be most wrong.
26. **Stand up MAPIE as an independent Python cross-check** *(score 12.0, 3/3)* — insurance
    against a repeat of the drive-sim's own six previously-found hand-rolled numeric bugs;
    isolated to `research/.venv`, no runtime dependency. Cost: hours. Exit test: does MAPIE's
    coverage/width agree with whatever hand-rolled JS conformal code ships.
27. **ACI online correction layer on top of #15/#18, only if realized coverage drifts**
    *(score 9.3, 0/3 — sequence-after, not now)* — legitimate published fix for
    non-exchangeability, but has nothing to correct until a base conformal interval exists
    and is actually being tracked. Do not build in parallel with #15/#18.

### Audit-method (CLV, trial registry, entity resolution, leakage, identity)

28. **Delete the four independent CLV calculators; one shared module, one table** *(score
    15.0, 2/2, independently re-proposed by a second research chunk at score 12.7)* — three
    genuinely different CLV conventions confirmed by direct code read: `nfl-clv.js` inverts
    sign for totals-Under, `nfl-execution-clv.js` assumes pre-inverted lines and does *not*
    invert, `nfl-prop-clv.js` stores a probability-delta instead of points. Mechanism: one
    module exporting one signed-points function + one fair-probability function, used by all
    four call sites, writing to one `clv_grades` table (market column distinguishes
    spread/total/moneyline/prop). Cost: days. Exit test: the flagship -2.28 CLV number becomes
    reproducible from one function call — this is the precondition for trusting any other CLV
    number in this document. **Single highest-confidence, highest-leverage item on the whole
    fix list.**
29. **Replace the raw-threshold "reacted" boolean with a market-model abnormal move**
    *(score 15.0, 1/1)* — `nfl-news-market-latency.js:49`: `reacted = |line_move|>=0.5 or
    |price_move|>=5`, no market-wide baseline subtracted, so a leaguewide vig shift on an
    unrelated Sunday registers identically to a genuine reaction. Mechanism: MacKinlay's
    two-window event-study design (estimation window + market-model baseline from the
    *other* games in the same capture window), replacing the boolean with a signed,
    sized abnormal-move estimate. Cost: days (the query surface already exists). Exit test:
    on a held-out slate with no verified event, the false-positive "reacted" rate should be
    statistically indistinguishable from the placebo rate — build alongside item #35.
30. **Append-only, content-addressed trial registry with a DB-enforced `scored_at >=
    declared_at` check** *(score 15.0, 1/1)* — closes the "re-run a correction until
    favorable, keep only the last one" loophole with a BEFORE UPDATE/DELETE trigger, mirroring
    the existing `027_decision_tape.js` pattern. Cost: hours once the base tables (#31) exist.
    Exit test: a corrected-result row can never overwrite an unfavorable prior one; the
    history of corrections is itself an audit trail.
31. **`research_studies`/`research_trials`/`research_trial_corrections` DDL** *(score 14.0,
    1/1)* — promotes the existing per-lab `preregistered.json`/`report.json` convention
    (5 ad hoc labs: book-lag, expert-selector, market, role-scenario, tree) into one queryable,
    cross-lab table, with `dsr_method`/`multiplicity_method` as explicit enum columns so two
    disagreeing formulas can never silently coexist (a real, literature-level failure mode
    this survey found in the DSR formula itself, one repo over). Cost: days. Exit test:
    the 21-model historical search gets a real, honest `effective_n_trials` denominator for
    the first time.
32. **Consolidate the 37-file content-addressing duplication into one identity module**
    *(score 13.5, 2/2)* — grep-confirmed 37 separate files reinvent "what code+data produced
    this number" (three of them — `nfl-engine-registry.js`'s `digest()`, `contracts.js`'s
    `stableJson`/`configurationHash`, and `audit-registry.js`'s own `codeHash`/`dataSignature`
    — are candidate consolidation targets that already exist verbatim). Cost: days, mechanical
    and low-risk. Exit test: unblocks item #34 (registry wiring).
33. **Route the second unaudited game-key join through the existing tested resolver**
    *(score 13.3, 3/3)* — `polymarket-lines.js:251-252` builds its own raw
    `${away}@${home}` string key straight from `espn_line_moves` rows, bypassing
    `eventKey()`/`canonicalTeamCode()` entirely — a second, real, unaudited matching site
    beyond `team-codes.js` itself. Cost: hours, low-risk refactor onto an already-tested
    function. Exit test: clean regression diff against the old ad hoc key.
34. **CLV convention reconciliation spec + fixture test** *(score 13.0, 1/1)* — not a mass
    refactor tonight; define one canonical formula (the causal abnormal-move definition from
    #29, once it exists) and add one integration test asserting each of the five existing
    implementations, converted to the same convention on a shared fixture, lands within a
    documented tolerance. Cost: hours for the spec+skeleton. Exit test: count how many of the
    five pass today (expected: most fail — the point is to make the disagreement countable).
35. **Sorted-neighborhood/date-window blocking ahead of any Polymarket-tape↔game join**
    *(score 13.0, 3/3)* — confirmed real per-row cross-join with no date blocking; hard
    computational prerequisite before the 12.4M-row tape can be joined against every game at
    all. Cost: hours. Exit test: O(12.4M×n_games) becomes O(12.4M) with no recall loss.
36. **Wire `nfl-blind-audit.js`/`audit-registry.js` onto the existing, tested `ModelRegistry`**
    *(score 12.0, 2/2)* — the `model_dataset_versions`/`model_backtests`/`model_metrics`
    schema (migration 005) is real, tested, and used only by `server/modeling/*` — never by
    the audit/CLV layer, which independently reinvents a worse copy. Cost: weeks (touches the
    blind audit's leakage guarantees — spike first). Exit test: one canonical pipeline, not a
    sixth competing one.
37. **Extend `assertTimestampedObservation()`'s point-in-time leakage guard past the fantasy
    pipeline** *(score 11.5, 2/2)* — currently scoped only to `PIPELINE_VERSION=
    'gridiron-fantasy-walk-forward@1.0.0'`; never touches `nfl_team_week_features`,
    `nfl_play_by_play`, or anything `nfl-blind-audit.js` freezes weekly. Cost: days, reuses an
    already-tested function. Exit test: run the proposed backdated-row test before making it
    a blocking gate — the betting-table leakage risk is plausible, not yet confirmed.
38. **Fellegi-Sunter-style `match_confidence` score on `eventKey()`/`contractKey()`** *(score
    11.0, 3/3)* — replaces the current binary `ok:true`/`ok:false` with a scored,
    hand-tuned (non-EM, no labeled training pairs exist tonight) log2(m/u) Bayes-factor
    weight per field, turning silent `unresolved_team` failures into scored near-matches.
    Cost: moderate JS effort. Exit test: unblocks Polymarket-tape matching beyond the current
    all-or-nothing.
39. **Purged, autocorrelation-corrected `effective_n_trials`** *(score 10.0, 1/1)* — the
    21-model search was iterative, not independent draws; feeding raw `21` into DSR/Holm is
    dishonest in whichever direction the correlation actually runs. Cost: hours-to-days
    (port `purgedcv`'s `effective_n_trials()`). Exit test: is the correction material on
    Gridiron's own trial-order Sharpe series before it drives any DSR number.
40. **Split the collapsed `always_valid_p` field into two never-conflated columns** *(read
    directly in F07-sequential-inference-fix, not independently cross-scored in the sample
    provided — flagged as a fix, not an add)* — `audit-registry.js:219` collapses
    `p_always_valid ?? p_fixed_sample_only` into one field named as if it were always the
    anytime-valid quantity, and no production caller has ever declared a sigma in advance, so
    "always-valid" is presently a misnomer for every real audit in the system. Cost: hours
    (add `always_valid_p_anytime`/`always_valid_p_fixed_sample`/`always_valid_variance_source`
    columns). Exit test: preregister two audits, run them out of registration order, assert
    the always-valid field type is never null-coalesced across regimes.
41. **Index the Šidák multiplicity correction by preregistration order, not execution
    order** *(same source as #40, not independently cross-scored)* — `priorTests` currently
    counts by *execution* order, so which of several already-preregistered audits a
    researcher happens to run first decides who gets the lenient bar. Cost: hours. Exit test:
    same as #40.
42. **Fix the always-broken receipt clock on the live free-book-feeds path** *(read directly
    in F05-bitemporal-pit, not independently cross-scored — flagged because it is actively
    live right now)* — `book-feeds.js:390-419` computes a genuine post-response timestamp
    but passes it in as `requestedAt`, never supplying `receivedAt`, so **every batch this
    feed has ever written, including this weekend's live Week 1 captures, is permanently
    labeled `legacy_request_time_only`** and discarded by the T-60 packet's `realClock`
    filter. Cost: one-line-shaped (capture `requestedAt` before the `Promise.all`, pass the
    post-await timestamp as `receivedAt` with `receiptClockSource:'response_completion'`).
    Exit test: the next live batch this feed writes carries `response_completion`, not the
    legacy label — check before Sunday's games settle, not after.

---

## (d) THE ADD LIST — ranked, additive-only

Per Nick's own sequencing: build only after the fix list lands. Same ordering discipline
(fantasy → simulation → betting-model → audit-method / new-capability-infra).

### Fantasy / props

1. **One-time nflverse historical player-season fantasy-points/usage import** *(score 14.3,
   3/3)* — explicit prerequisite every other fantasy-modeling candidate below depends on;
   `player_season_stats` is confirmed scoped to internal rostered players only, no
   full-population multi-decade table exists. Cost: days. Exit test: joinable to
   `player_accolades`'s existing `draft_round`/`draft_pick`/`draft_year`.
2. **Report curve source, sample size, and cross-method disagreement in every
   `dynastyAgeAdjustment()` response** *(score 15.0, 1/1)* — `dynastyAgeAdjustment()` already
   returns `{raw_value, age, age_source, multiplier, adjusted_value, curve}`; the file's own
   header comment already states this transparency philosophy. Cost: hours — purely additive
   field extension, fully consistent with existing shipped code. **Single best
   value-per-cost item in the entire batch.**
3. **Empirical, position-group-specific replacement-level baseline** *(score 14.0, 1/1)* —
   replaces `nfl-player-value.js`'s hand-tuned `POSITION_VALUE` table (the file's own comment:
   "a monotone prior, not production coefficients") with nflWAR's roster-based method, fit on
   Gridiron's own backup-player production. Cost: hours (data already exists —
   `player_week_usage`/`nfl_snaps`/`nfl_depth`).
4. **Empirical delta-method aging curve, computed from Gridiron's own data** *(score 14.0,
   1/1)* — replaces the hand-typed `AGE_CURVE_ANCHORS` literature table (QB gets a flat 1.0
   "for lack of a published curve" — not a fit, an absence). Needs #1 (the historical import)
   first. Cost: weeks including the import.
5. **Harstad-style cliff/hazard probability field alongside the smooth multiplier** *(score
   11.3, 3/3)* — the flat-then-cliff empirical pattern (survivors are nearly flat; the real
   risk is a single-season collapse, not a gradual fade) directly falsifies the current
   smooth-decline shape. Cost: days, gated on #1/#4 landing and graded against a base-rate
   Brier score before it reaches trade-value UI.
6. **Depth-chart usage-propagation graph (2-hop, scheme-weighted)** *(score 12.0, 1/1)* —
   every input table already exists (`nfl_depth`, `nfl_snaps`, `player_week_usage`); the
   literature search found *no* credible open-source injury-propagation network model to
   port from — this is genuinely open territory, not a gap in an existing feature.
   `who-plays.js` stops at `expected_snaps_lost` per player without redistributing it to
   teammates; this candidate finishes that job. Cost: days-to-weeks. Exit test: on holdout
   weeks with a documented new starter, does the graph's predicted teammate opportunity delta
   beat a "no change" null and beat the current one-hop, position-siloed `cascades()`.
7. **Refit the age-curve anchors via GAM+truncated-imputation** *(score 11.0, 1/1)* — the
   more rigorous version of #4, once the naive fit has been backtested against it.
8. **Mixed-effects (random player intercept) quadratic curve with a covariance-propagated
   95% CI, as a cross-check on #4** *(score 11.0, 3/3)* — needs `statsmodels` (currently
   absent from `research/.venv`).
9. **Stand up a real probabilistic-programming toolchain** *(score 12.0, 2/2)* — `pymc` or
   `numpyro`, currently entirely absent; the prerequisite every hierarchical-Bayes props
   candidate on the fix list needs to exist at all. Cost: days for a minimal prototype; pays
   off only if the hierarchical fixes above are actually pursued.
10. **gplearn SymbolicTransformer as a feature-discovery front-end for prop calibration
    heads** *(score 11.0, 0/1 — later)* — attachment point verified, but gated behind a
    private nested-CV harness (#13 below) that hasn't run yet; do not start standalone.

### Simulation-adjacent

11. **Held-out log-loss/Brier calibration harness for the drive simulator's *full* margin
    distribution shape** *(score 13.0, 2/2)* — closes the exact gap that let the flat-7 HFA
    lump and missing-OT bugs slip past `calibrationReport()`'s 3-moment check (mean total,
    mean margin, margin SD only — no shape/key-number check at all). Cost: days, reuses
    `margin-distribution.js`'s already-tested walk-forward scoring pattern.
12. **Dirichlet/categorical overtime-outcome model, calibrated to the empirical 2015-2023
    OT score-pair table** *(score 10.0, 2/2)* — replaces ad hoc OT resimulation with a real
    categorical model calibrated to Moyer et al.'s Table 2. Prototype-and-chi-square-check
    before wiring into `simulateGame`.
13. **Independent compound-Poisson total-points engine as an ensemble member / fast sanity
    check** *(score 10.0, 2/2)* — a structurally independent model targeting the ensemble's
    documented ~3-independent-signal collapse. Weeks of cost; walk-forward Brier/log-loss vs.
    naive Poisson is the bar before it touches the live ensemble.
14. **Add `posteam_timeouts_remaining`/`defteam_timeouts_remaining` to `nfl_play_by_play`
    ingestion** *(score 12.0, 0/1)* — confirmed real schema gap (grep for "timeout" returns
    nothing); days of ingestion work in service of the live-WP/betting stack specifically,
    which is secondary to fantasy — sequence accordingly, not tonight.

### Betting-model-adjacent / new capability

15. **Score-driven (GAS) dynamic bivariate Poisson/Skellam joint scoring model** *(score
    11.3, 3/3)* — Koopman & Lit's own head-to-head result (dynamic score-driven beats static,
    beats a full parameter-driven state-space model, at 1/360th the compute) is the strongest
    single number in this whole research batch. Doubles as the natural foundation for a real
    teaser-leg/SGP correlation mechanism. Needs the walk-forward/CRPS gate against the champion
    GBM before shipping — this is soccer-goal Poisson ported to NFL scoring dynamics.
16. **Depth/fill-aware execution simulator** *(score 12.0, 3/3)* — `captureOrderBooks()`
    already stores `bid_size`/`ask_size` and nothing downstream reads them; 76.9% of real
    combinatorial Polymarket arbitrage episodes are capped at ~15 shares of executable size
    per the UCLA NBA study — this candidate converts every other cross-venue candidate's
    dollar figures from aspirational to real. Cost: days, pure function.
17. **Kalshi maker/taker adverse-selection haircut curve** *(score 11.3, 3/3)* — informed by
    a real academic finding (sub-10¢ Kalshi contracts lose >60% of stake on average); haircuts
    any Kalshi leg before it's treated as a clean tradeable price. Cost: hours.
18. **Governed paired-comparison evaluation harness** *(score 12.0, 2/2)* — `ModelRegistry.compare()`
    is a bare map+filter with zero statistics attached; both required primitives
    (`pairedBootstrapDiff`, `alwaysValidPValue`) already exist and are tested elsewhere.
    Composing them into one governed comparison would have caught the ensemble's fake
    diversity and the -2.28 CLV drift. Sequence after the CLV/registry fixes land — depends
    on `model_metrics` actually being populated.
19. **Mandatory canary/shadow-serve window before promotion** *(score 10.5, 2/2)* —
    `registry.js`'s `REQUIRED_GATES` has exactly 5 static gates and no forward-held-out-data
    requirement at all. Pilot on one fantasy model first (cheapest given the fantasy-first
    priority) before making it a mandatory registry gate.
20. **Point-in-time feature store for the two most-neglected tables** *(score 9.5, 1/2)* —
    the 12.4M-row Polymarket tape and the 251,591-row PBP table, both genuinely idle beyond
    their current single use, unified under one time-travel-correct query interface. Weeks of
    speculative infrastructure for consumers that don't fully exist yet — build the consumers
    (candidates #6, #15-17) first and let this emerge from real need, not in parallel.
21. **Posterior-predictive model-checking as a standing diagnostic on the deployed champion
    GBM** *(score 10.0, 3/3)* — Glickman & Stern's own method (simulate replicates, compare a
    discrepancy statistic), structurally distinct from the bootstrap significance testing
    Gridiron already has, cheap and needs no new Python dependency. Worth running regardless
    of whether any new rating model ever ships.
22. **Two-way fixed-effects panel model replacing `weather_total`'s three flat constants**
    *(score 9.3, 3/3)* — standard fix for the roster-selection confound both an academic
    source and a practitioner piece name explicitly; plain OLS with dummies, no new
    dependency. Needs the stated out-of-sample RMSE/coverage bar cleared before it replaces
    the current constants; betting-secondary, so no rush.

---

## (e) Rejected candidates — grouped by theme, one line each

**Copula/dependence machinery (GF06 — the bottom of the batch):** reimplementing
`empirical_joint`/`uniform_scores` as dependency-free JS, porting `bvn_upper` quadrature, an
Archimedean (Clayton/Gumbel) fitting escalation path, and tracking `pyvinecopulib` as a
"reference for later" all scored zero — every one of them is infrastructure for a signal
(cross-game/same-week teaser correlation) the codebase's own bootstrap already measured as
statistically indistinguishable from zero, and none has a live consumer yet.

**A model-free stacking guard for teaser-leg pricing (GF05-6):** adopting the
complementary-events constraint from `georgedouzas/sports-betting` as a standalone guard
scored zero on its own — it's a real, cheap idea, but it belongs bundled into whichever
teaser/copula fix actually ships, not as its own line item.

**Time-series-foundation-model pilots, named too specifically (Time-series foundation model
code chunk):** a Chronos-2 cross-learning team-strength pilot, a Chronos-2 covariate-prop
quantile pilot, a TimesFM-2.5 XReg blend, and a TimesFM-3.0 native-multivariate
same-game-correlation pilot all scored zero as *separately pitched* line items — the
underlying capability (N01/GN01, scores 9.5-13.0) is real and above the cut; these four are
the same idea sliced four ways for four different consumers before any single pilot has
even run once.

**Graph neural networks, oversold to specific consumers (GN02):** a 64-node offense/defense
graph replacing `nfl-team-strength.js` wholesale, a learned trust-the-model-vs.-market
discriminator, a heterogeneous roster graph for role-change prediction, and a Next-Gen-Stats
prerequisite flag all scored zero as individually-pitched deliverables — the *idea* (N02,
score sits below the fix/add cutoff shown but the underlying literature is real and
summarized above) needs one small pilot proving the graph beats a vector baseline on
Gridiron's own tables before four separate consumer-specific builds are justified.

**A transformer directly on play-by-play, oversold as five separate components (GN03):**
the full Drive-Outcome Transformer spec, its nested set-attention formation/personnel
sub-module, an auxiliary play-calling-tendency feature export, an XGBoost+SHAP surrogate
audit trail, and a split-conformal calibration wrapper around its output all scored zero as
individually-pitched line items — build the one small transformer (see N03 in the ADD
narrative above; not independently re-scored) and let calibration/audit needs emerge from
it, not five parallel specs before the first one trains.

**DFS-specific build-outs, ahead of a proven correlation-aware base (GN04):** a
correlation-aware lineup builder, a salary-cap MILP/greedy-ILP selector, and a multi-lineup
GPP portfolio builder each scored zero as standalone deliverables — Gridiron's
`correlation.js`/`correlatedSampler()` genuinely has the hard statistical work already done
and production-wired; what's missing is the lineup-selection layer itself, which these three
line items describe as three separate builds rather than one coherent optimizer.

**Prediction-market microstructure builds, ahead of any consumer (GN05):** a neg-risk
complementary-set consistency scanner, a depth-aware executable-price calculator, and a
tick-size-aware ladder-crossing fix each scored zero individually — real, cheap ideas
(reused above in the ADD list's #16-17 framing), but pitched as three separate PRs against a
tape that has exactly zero current consumers beyond spread-ladder construction; bundle them
into whichever cross-venue candidate actually ships first.

**Neural probabilistic margin heads, five deep instead of one shallow (GN06):** an NGBoost
Normal head, a PyTorch MDN head, a Neural-Spline-Flow local sidecar, and a PIT-calibration
audit built on top of whichever head ships all scored zero as individually-pitched
deliverables — the underlying literature (N10, real and above the cut) explicitly says
"start with the cheapest, most robust head; only add the next-more-complex one if a held-out
log-likelihood comparison shows it winning" — pitching all four as parallel line items
inverts that explicit sequencing.

**A from-scratch live-WP model and its own calibration harness, split into two separate
asks (GN07):** shipping a real logistic-then-GBM live in-game WP model and separately
porting NFLWin's KDE reliability-diagram harness both scored zero as standalone line items —
real and useful (folded into the simulation-bucket narrative above), but the model and its
calibration check are one deliverable, not two competing PRs.

---

## (f) Recommended combined architecture

The instinct every researcher converged on independently — across CLV, audit registries,
copula code, and identity resolution alike — is the same one: **Gridiron's problem tonight
is not a shortage of statistical machinery, it's 5-37 duplicate copies of machinery that
already exists once, correctly, somewhere in the repo.** The fixed core below is explicitly
a *subtraction* exercise (delete four CLV files into one; delete three content-addressing
schemes into one; wire two orphaned audit systems onto the one registry that already passes
a real test suite), not new invention. The additive layer on top is explicitly gated to land
only after that core stops disagreeing with itself.

```
                    ┌─────────────────────────────────────────────────┐
                    │  ONE TRIAL REGISTRY (research_studies /          │
                    │  research_trials / research_trial_corrections)   │
                    │  — every model, every backtest, every copula     │
                    │  fit, every GP/AutoML run declares itself here    │
                    │  BEFORE scoring. DSR/PBO/Holm computed off        │
                    │  effective_n_trials, not raw counts.              │
                    └───────────────────┬───────────────────────────────┘
                                         │  gates promotion for everything below
                    ┌────────────────────┴────────────────────┐
                    │        ONE IDENTITY / CLV CORE            │
                    │  • one content-addressing module (kills   │
                    │    37 duplicate hashers)                   │
                    │  • one computeClv() — signed points +      │
                    │    fair probability, one clv_grades table,  │
                    │    market column distinguishes spread/     │
                    │    total/ML/prop                             │
                    │  • one scored eventKey()/contractKey()      │
                    │    (Fellegi-Sunter confidence, not binary)  │
                    │  • one receipt clock (event time vs.        │
                    │    processing time, never conflated)         │
                    └───────┬───────────────────────┬─────────────┘
                            │                        │
              ┌─────────────┴──────────┐   ┌─────────┴────────────┐
              │   FIXED FORECASTING     │   │   CALIBRATED         │
              │   CORE                  │   │   UNCERTAINTY LAYER   │
              │  • one team-strength    │   │  • split-conformal    │
              │    model: ridge paired- │   │    quantile (crepes-  │
              │    comparison estimator │   │    style, one shared  │
              │    (hours), later a     │   │    conformal-         │
              │    recursive Bayesian   │   │    calibration.js)     │
              │    update (weeks)       │   │  • Mondrian-binned by │
              │  • one forecast-        │   │    spread bucket, by  │
              │    combination method:  │   │    position/prop-type │
              │    DM-test-gated,       │   │  • NexCP-weighted for │
              │    equal-weight/inverse-│   │    non-stationarity    │
              │    MSE benchmarked      │   │  • MAPIE cross-check   │
              │    against the current  │   │    (isolated Python,   │
              │    market-residual      │   │    no runtime dep)     │
              │    shrinkage — not more │   └───────────────────────┘
              │    components, a        │
              │    correlation/PCA      │
              │    REDUCTION step first │
              │  • drive-sim mechanics  │
              │    fixed (away-spread   │
              │    sign, HFA-as-feature,│
              │    timeout decrement,   │
              │    OT scoped correctly) │
              └────────────┬────────────┘
                            │  feeds, does not compete with
              ┌─────────────┴──────────────────────────────┐
              │      FANTASY-FIRST ADDITIVE LAYER            │
              │  (ships only after the core above lands)     │
              │  1. Cold-start fix: structural-projection      │
              │     fallback + cross-season transfer for       │
              │     weekly-learning heads (hours; already the  │
              │     project's own shipped pattern, elsewhere)  │
              │  2. Hierarchical NB/Poisson props (needs a      │
              │     pymc/numpyro toolchain — the one genuinely  │
              │     new piece of infrastructure this whole plan │
              │     requires), gated behind the walk-forward     │
              │     suite the props module already has          │
              │  3. Empirical replacement-level (nflWAR-style)   │
              │     for handcuff valuation — hours, data already │
              │     exists                                        │
              │  4. Depth-chart usage-propagation graph (2-hop,  │
              │     scheme-weighted) — the one genuinely open     │
              │     research gap the literature search confirmed  │
              │     nobody has built, in-house or open-source      │
              │  5. Empirical dynasty aging curve + Harstad-style │
              │     cliff/hazard field, once the one-time nflverse │
              │     historical import lands                       │
              └────────────────────────────────────────────────┘
                            │
              ┌─────────────┴──────────────────────────────┐
              │   BETTING-MODEL ADDITIVE LAYER (secondary,   │
              │   governance-gated, sequenced last)          │
              │  • score-driven bivariate-Poisson joint       │
              │    scoring model (feeds real teaser/SGP        │
              │    dependence pricing instead of independence) │
              │  • depth/fill-aware execution simulator +       │
              │    Kalshi adverse-selection haircut (measurement, │
              │    not a revenue plan — the best real-world      │
              │    number for this mechanism is $210-560 total    │
              │    across an entire NBA month)                    │
              │  • per-team wind_epa_delta wired into weather_total│
              │  • governed paired-comparison harness + canary/   │
              │    shadow-serve promotion window                 │
              └────────────────────────────────────────────────┘
```

**Why this shape, not more parallel machinery.** Every "new" candidate that scored well
either (a) plugs directly into a core component that no longer disagrees with itself (the
copula extension, the CQR width, the props conformal wrapper all *need* one canonical CLV
and one canonical team-strength model to be gated against — building them against five
disagreeing CLV numbers just produces a sixth), or (b) is genuinely orthogonal new capability
(the injury-propagation graph, the dynasty survival curve, the DFS optimizer) that reads from
tables Gridiron already populates and writes to a new, clearly-labeled surface without
touching anything load-bearing. Nothing in the additive layer is allowed to become a second,
competing implementation of something the fixed core already does once — that specific
failure mode (37 hashers, 5 CLV tables, 3 audit-freeze schemes) is the disease this entire
research session diagnosed, and the fastest way to reproduce it tonight would be building any
of the "new" capabilities before the "fix" ones land underneath them.
