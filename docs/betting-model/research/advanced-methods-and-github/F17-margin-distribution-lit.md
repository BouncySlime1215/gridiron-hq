# F17 — Empirical NFL margin/total distribution literature, for calibrating the drive simulator

Researcher: F17-margin-distribution-lit (bucket: fix). Phase: ResearchFix.

## 0. What already exists in Gridiron that this topic must reckon with

Before citing outside literature: **Gridiron already has a fitted empirical margin distribution.**
`server/betting/nfl/strategy/margin-distribution.js` (1655 lines) fits P(margin | spread) as a
penalized conditional-logit / exponential-tilt model over `game_lines` (1999-2024, 6,991 games,
2025-2026 excluded for corrupted spread data — imported from `teaser-leg-rates.js`'s constants).
It already:
- treats margin as discrete integers with free "atom" parameters at every |margin| up to 42 (the
  key-number masses ARE the free parameters, not a derived consequence of a smooth shape);
- applies the spread as an Esscher/exponential tilt on a fixed pick'em-shape kappa (i.e., the mass
  at 3 sits at 3 regardless of the line — validated against the data: margin 3 is the modal outcome
  at every line-size bucket the book posts, including double-digit favorites);
- shares strength across lines via a penalized spline in |spread|, chosen by season-blocked 5-fold
  CV;
- down-weights old seasons with an exponential half-life (walk-forward-validated at 6 seasons);
- reports posterior uncertainty via a sandwich-covariance Laplace approximation with seeded
  parameter draws;
- is HONEST about its own limits: `MARGIN_MODEL_VERDICT` (referenced in the file, enforced in
  `test/margin-distribution.test.js`) states it is beaten out-of-sample by the plain empirical
  lookup on the eight cross-both teaser lines specifically, even though it wins everywhere else.

This is the module that should serve as the GROUND TRUTH the drive simulator's *simulated* margin
distribution gets checked against, once F01's 6 physics bugs are fixed — not a new empirical fit
built from scratch. The gap is entirely on the simulator side: `nfl-drive-sim.js`'s
`calibrationReport()` (line 903) checks only mean total, mean margin, and margin SD against actual
games (tolerances ±3, ±3, ±3.5) — it has **no check on the shape** of the simulated margin
distribution, so a key-number distortion (like the flat 7-point HFA lump, see below) can pass
calibration cleanly.

Grep evidence:
```
server/services/nfl-drive-sim.js:562:
  if (homeFieldPoints > 0 && random() < homeFieldPoints / 7) home += 7;
server/services/nfl-drive-sim.js:903-960:  calibrationReport() — 3 checks: mean total, mean
  margin, margin SD. No key-number / shape check.
server/services/nfl-drive-sim.js:773-869:  simulateRemainder() — single `while (clock > 0)`
  loop with no halftime reset and no overtime branch (contrast simulateGame's OT block at 540-558).
server/services/nfl-team-strength.js: hand-tuned preseason/in-season blend (per FOUND).
```

## 1. Primary sources

### 1.1 Stern, H. (1991). "On the Probability of Winning a Football Game." *The American
Statistician*, 45(3):179-183.
- **read_in_full: false** (paywalled JSTOR/Taylor&Francis; not fetchable through available tools).
  Documented here via three independent citing sources that quote it consistently, plus its
  citation and direct use inside Glickman & Stern (1998), which I did read in full (§1.3).
- **Sample**: 1981, 1983, 1984 NFL seasons.
- **Key result**: margin of victory minus the closing point spread is not significantly different
  from Normal(mean=0, SD=13.86). This became the standard closed-form approximation
  `P(favorite wins by ≥ k) = Φ((spread - k)/13.86)` used across the industry for two decades.
  A widely repeated "more recent" revision puts the SD nearer 13.5 (see Sides et al. 2022, §1.2,
  footnote).
- **Honest limitation** (stated by the paper itself, per every source that discusses it, and
  independently reaffirmed by Glickman & Stern 1998 p.26): the normal approximation is "not an
  unreasonable approximation... especially when one is not interested in computing probabilities
  for exact outcomes but rather for ranges of outcomes (e.g., whether the score difference is
  greater than 0)." It was never claimed to be good at exact-margin (key-number) probabilities —
  which is precisely the use the drive simulator's key-number mass matters for.

### 1.2 Sides, R., Harvill, J. L., & Sides, V. R. (2022). "Converting College Football Point Spread
Differentials to Probability." arXiv:2212.08116 [stat.AP].
- **read_in_full: true** (12 pages, fetched and read completely, including references).
- **Sample**: 2021 college football season (SP+ projections vs. betting lines, per-spread bins);
  historical point-differential table from Boyd (2015), college football, 1980-2014.
- **Method / key result**: explicitly critiques Stern (1991)'s normal-approximation flaw — "the
  assumption that a team favored by five will win by exactly five at the same rate that a team
  favored by seven wins by exactly seven... is a direct contradiction to reality." Their fix: take
  the normal CDF over half-point-wide intervals, then multiply each point-differential's probability
  by an empirically-derived **multiplier** (their Table 3: e.g., ×2.7 at differential 3, ×2.1 at 7,
  ×0.7 at 0) computed as (historical frequency) / (normal-model frequency), then renormalize each
  spread's column to sum to 1. This is structurally the same idea as Gridiron's own
  `margin-distribution.js` exponential tilt-times-atom decomposition (§0), independently arrived at.
  Result: on their worked example (Baylor -2.9 projected vs. -2.5 posted), the adjusted method
  finds a 53.2% cover probability and a 0.8% edge, versus 51.06% / no edge under the naive normal —
  and the paper reports the fitted conditional distributions' means stay within "one- or two-tenths
  of a point" of the naive-normal projection, i.e., the multiplier trick preserves the mean while
  fixing the shape.
- **Honest limitation** (their own §6 Discussion, verbatim substance): "further research is needed
  to understand how these probabilities perform with actual game data," and they flag their single
  test season (2021, college) as compromised by COVID-19 roster effects and sixth-year seniors —
  i.e., this is a methodologically clean idea with a genuinely weak/preliminary validation, exactly
  the honesty standard this brief asks for.

### 1.3 Glickman, M. E., & Stern, H. S. (1998). "A State-Space Model for National Football League
Scores." *Journal of the American Statistical Association*, 93(441):25-35.
- **read_in_full: true** (fetched full PDF from the author's site, glicko.net; read all 6 pages
  covering intro, model spec, MCMC fitting, posterior inference tables, and out-of-sample
  validation).
- **Sample**: NFL regular season 1988-1993 (p=28 teams; games through week 10 of 1993 for fitting,
  last 110 games of 1993 held out for validation).
- **Model**: score DIFFERENCE (not raw scores) is Normal, mean = team-strength difference + home-
  field-advantage parameter, precision φ. Team strengths follow a first-order autoregressive
  state-space process with SEPARATE between-week (σ_w) and between-season (σ_s) evolution
  variances, fit by Gibbs sampling/MCMC (7 parallel chains, 18,000 iterations, PSR-diagnosed
  convergence).
- **Key results** (numbers, not just claims):
  - Posterior mean residual SD of score differential given team strengths: **τ ≈ 12.78** (95%
    CI 12.23-13.35) — a touch lower than Stern (1991)'s simpler τ̂=13.86, attributed to the
    richer team-strength structure absorbing some of what Stern's cruder model left in the
    residual.
  - Home-field advantage: prior mean 3 points; posterior HFA means range from Dallas Cowboys 1.62
    to Houston Oilers 7.28 (posterior SD of the HFA distribution across teams, σ_h, centered near
    2.3) — **home-field advantage is NOT a single flat constant, let alone a discrete lump; it is a
    continuous, team-varying quantity with real spread.** This directly contradicts the structure
    of Gridiron's `homeFieldPoints/7` binary-jackpot mechanism (§0).
  - Out-of-sample validation against a REAL benchmark: on the held-out 110 games (last 8 weeks,
    1993), the model's MSE = 165.0 and MAE = 10.50, versus the Las Vegas closing line's MSE = 170.5
    and MAE = 10.84; correctly picked 64/110 winners (58.2%) vs. the line's 63/110. The paper is
    explicit that "for this small sample, the model fit outperforms the point spread, though the
    difference is not large enough to generalize" — an honestly stated, non-overstated result.
  - Model-checking note (p.26, directly relevant to key numbers): cites Rosner (1976) as having
    modeled game outcomes as an explicitly discrete distribution reflecting football's scoring
    rules, but states that prior work (Harville 1980; Sallas & Harville 1988; Stern 1991) "has shown
    that the normality assumption is not an unreasonable approximation, especially when one is not
    interested in computing probabilities for exact outcomes but rather for ranges of outcomes."

### 1.4 Moyer, L., Railey, J., Daw, A., & Gutekunst, S. C. (2024). "Scorigami: Simulating the
Distribution and Assessing the Rarity of National Football League Scores." *Proceedings of the
2024 Winter Simulation Conference*, pp. 702-713.
- **read_in_full: true** (fetched full PDF, all 12 pages including references and author bios).
- **Sample**: NFL play-by-play via `nfl_data_py` (49,664 plays, 285 games, just the 2023 season,
  extended with scoring-event summaries back to 1940 and OT-specific data 2015-2023); "current
  epoch" = 2015-2023 (post extra-point-distance rule change) used as the primary benchmark
  population, exactly the era Gridiron should be calibrating to.
- **Model 1 (baseline, rejected)**: each team's score = weighted sum of 5 independent Poisson
  processes (6/7/8-pt TD, FG, safety), calibrated on 2015-2023 rates (2.56 TD/team/game: 10.08%
  failed try, 85.46% successful 1-pt, 4.36% successful 2-pt, 0.095% defensive 2-pt; 1.61 FG/team/
  game; 0.028 safeties/team/game).
  - **This naive-Poisson baseline is the closest real-world analogue to what Gridiron's drive
    simulator MUST beat, and it fails at exactly the failure mode this topic cares about**: it
    predicts P(margin=3) = 7.67% vs. the true current-epoch rate of **14.7%**, and P(margin=7) =
    5.67% vs. true **8.89%** — it underpredicts key-number mass by roughly 2× at the two most
    important numbers. It also gets the overall spread wrong in the other direction: mean margin
    11.11 (actual, 2015-2023) vs. **13.32** under the naive-Poisson model — a ~20% inflation, i.e.
    the same qualitative failure as Gridiron's flat 7-point HFA lump (both add spurious variance
    around the true center).
- **Model 2 (their contribution)**: a non-stationary, state-dependent Poisson PROCESS — scoring
  intensities are piecewise-constant across 6 in-game time segments (start of Q1, Q2, two-minute
  warning, start of Q3, Q4, two-minute warning to end), reweighted continuously by (a) each team's
  ranked scoring/allowing ability and (b) an exponentially-decaying (rate γ=0.02) blend toward a
  score-differential-tilted weight (Δ=0.4) that captures garbage-time deceleration/acceleration and
  a documented empirical shift in 1-vs-2-point try attempt rate as score differential changes
  (their Figure 5b). Fit by matching mean winning/losing score (28.34/17.24) via L2 loss on 100,000
  simulated games.
- **Key out-of-sample-flavored result** (their own validation, a real quantitative comparison):
  RMSE of the fitted joint (winner-score, loser-score) PMF against the true 2015-2023 data: 0.00335
  for the naive independent-Poisson model vs. **0.00310** for their non-stationary process model —
  a **7.8% improvement**. Mean score differential from their model: **11.25**, essentially matching
  the true 11.11 (vs. naive-Poisson's 13.32). They explicitly flag that heterogeneity across teams
  is REQUIRED — an i.i.d.-teams Poisson model underestimates the true spread in team scoring rates
  (their Fig. 4a: real top/bottom-team scoring rates exceed what order statistics of 32 i.i.d.
  Poisson draws would predict for all but one season).
- **Overtime, directly reusable**: Table 2 gives the exact empirical OT score-pair frequency table
  for 2015-2023: **3-0: 74, 6-0: 49, 6-3: 13, 0-0: 7, 3-3: 2, 2-0: 0** (n=145 OT games). This is a
  ready-made categorical ground truth for grading (or replacing) Gridiron's ad hoc `had < 8`
  sudden-death resimulation loop.
- **Honest limitation** (their own §5 Conclusion): "the fit to data could be improved in future
  work"; they note their two models AGREE on the top-3 most likely future "Scorigamis" (36-23,
  32-26, 40-31) but diverge completely beyond that, and state plainly they "look forward to seeing
  how these predictions hold up over the coming seasons" — i.e., unvalidated forward performance,
  reported as such.

## 2. Secondary/practitioner sources used for corroboration (not counted toward the 4 primary
reads, cited for specific numbers that agree with or extend the primary sources above)

- **nfelo, "Margin Probabilities from NFL Spreads"** (nfeloapp.com) — confirms qualitatively that
  "NFL final margins follow a somewhat normal distribution around the spread" but that key numbers
  (3, 7, 10) occur "more frequently than predicted by a simple normal distribution," and that their
  own multi-distribution model "explains margins meaningfully better than a single normal
  distribution... [without] overfitting." No sample size/season range or hard error numbers given
  in the fetched content — treated as directional corroboration only.
- **Action Network, "NFL Key Betting Numbers: How Margins Changed with Longer Extra Point"** —
  2015-2019 (5-season) key-number frequencies: 3 → 14.43%, 7 → 9.89%, 6 → 7.25%, 14 → 5.74%,
  10 → 4.61%. Consistent (within noise) with Moyer et al.'s 2015-2023 figures (14.7%/8.89%).
- **ELDORADO, "A Complete History of NFL Margins of Victory"** — 1922-2015 history: the six key
  numbers {3,4,6,7,10,14} average 45.0% of games 1974-2014, spiking to 52.1% in 2015 alone; SD of
  that aggregate key-number share across 1974-2014 was 3.55 percentage points — i.e., the
  key-number SHARE itself is fairly stable decade to decade even as which numbers matter shifts.
- **Football Perspective, "What's the Correct Margin-of-Victory Cap for the NFL?"** — using SRS
  ratings for 2002-2013 (32-team era), reports SD of game-level prediction error (actual margin
  minus SRS-implied margin) = **12.1** — a fourth independent point estimate for the "true" margin
  SD, in a middle era between Glickman & Stern's 12.78 (1988-93) and Moyer et al.'s current-epoch
  figures, consistent with a slow downward drift as the modern era's HFA has shrunk.

## 3. What this means for the target numbers

Reading these together, the corrected drive-sim margin distribution should NOT converge to one
number-and-shape; the honest target is:

- **Center-of-distribution SD (post-2015 epoch)**: literature range is 12.1-13.86 depending on era
  and whether team strength is modeled explicitly (explicit team-strength models pull it down
  toward ~12-13; Stern's simple version sits at the top of the range). Gridiron already has its own
  better answer to this specific question sitting unused: `margin-distribution.js`'s
  `diagnostics.residual_sd_at_pickem` and `diagnostics.conditional_moments[].sd`, fitted on
  Gridiron's own 1999-2024 `game_lines` with the recency half-life this literature confirms is the
  right kind of adjustment to make (era drift is real but small — Glickman & Stern's between-season
  σ_s exists as a formal parameter for exactly this).
- **Key-number masses**: NOT derivable from any SD adjustment to a normal curve — every single
  source that tested it (Sides et al. 2022, Moyer et al. 2024, Gridiron's own margin-distribution.js
  spec search) found that a shifted/scaled continuous distribution cannot reproduce them; they must
  be free or multiplicatively-tilted mass points. Target values for 2015-2023 (Moyer et al.,
  cross-checked against Action Network): P(|margin|=3) ≈ 14.7%, P(|margin|=7) ≈ 8.9%, P(|margin|=6)
  ≈ 7.3%, P(|margin|=10) ≈ 4.6-5.6%, P(|margin|=14) ≈ 4.9-5.7%. Gridiron's own fitted
  `baseKeyMass`/`observed_marginal_key_number_mass` diagnostics in `margin-distribution.js` should
  be the actual numeric target used in code (it's fit on the right population, with recency
  weighting), with these literature figures serving only as an external sanity check.
- **Home-field advantage**: should be a small (~2-3 point mean, Glickman & Stern's team-level
  posterior SD ≈2.3) continuous effect spread across the whole game via scoring rates/EP, not the
  current `random() < homeFieldPoints/7 → +7` binary lump, which by construction manufactures extra
  mass at exactly margin=home_margin+7 and home_margin-7 that isn't in any of the empirical
  distributions above.
- **Overtime**: not a symmetric "each team gets a shot" abstraction — Moyer et al.'s Table 2 shows a
  heavily field-goal-skewed, non-uniform categorical outcome (3-0 and 6-0 alone are 85% of the
  n=145 sample) that is directly reusable as ground truth.

## 4. Candidates (see structured output for full fields — summarized here)

**Fix** (cite exact F01/other-finding defects):
1. Replace the flat 7-pt post-OT HFA lump (`nfl-drive-sim.js:562`) with a continuous per-drive HFA
   calibrated to Glickman & Stern's ~3pt mean / ~2.3pt team SD.
2. Add key-number mass checks to `calibrationReport()` (`nfl-drive-sim.js:903`) against
   `margin-distribution.js`'s already-fitted `marginPmf()`, since the existing 3 checks (mean
   total/margin/SD) cannot see a key-number distortion.
3. Give `simulateRemainder()` (`nfl-drive-sim.js:773`) a halftime break and real overtime handling.
4. Replace `nfl-team-strength.js`'s hand-tuned blend with a Glickman-Stern-style AR(1) state-space
   update with separate between-week/between-season variances.

**New** (capabilities Gridiron has none of today):
5. A held-out log-loss/Brier calibration harness for the drive simulator's FULL margin distribution
   (not just moments), reusing `margin-distribution.js`'s own walk-forward CV pattern.
6. A Dirichlet/categorical overtime-outcome model calibrated to Moyer et al.'s empirical 2015-2023
   OT score-pair table, replacing ad hoc OT resimulation with regulation-time drive policies.
7. A cheap closed-form margin CDF (Stern normal baseline × fitted key-number multipliers, à la
   Sides et al. 2022) as a near-zero-cost consistency check/screen wherever code pays for a full
   N-trial simulation just to get P(margin > x).
8. An independent, cheap compound-Poisson TOTAL-POINTS engine (Moyer et al.'s non-stationary
   state-dependent scoring-rate model) as an ensemble member / fast sanity check for totals,
   separate from the expensive full drive simulator.

## 5. Do not do

- Do not port Karlis & Ntzoufras (2003)-style bivariate Poisson goal models literally — they are
  built for soccer's raw goal counts (0-5 range, draws matter); NFL scores are compound sums of
  3/6/7/8-point events, and Moyer et al. (2024) show even a *properly separated* multi-event
  independent-Poisson NFL model still underpredicts key-number mass by ~2×. A soccer-style single-
  Poisson-per-team port would fail worse, not better. (Note: could not fetch the Karlis & Ntzoufras
  paper directly — the university host was unreachable both times — so this is based on two
  independent search summaries of its methodology, not a full read; treat the "diagonal inflation"
  idea as a reference pointer only, not a validated recipe.)
- Do not treat Stern (1991)'s N(spread, 13.86²) — or any single fixed-SD normal — as sufficient for
  anything beyond win/cover probability at a single point. It is provably wrong for key-number mass
  and for any teaser/alternate-line question, which is exactly why `margin-distribution.js` exists;
  don't rebuild what it already does correctly.
- Do not fold the HFA fix into `calibrationReport`'s existing ±3/±3.5-point tolerances without
  adding an explicit key-number check (candidate 2) — a mean/SD-only calibration can and did pass
  while this specific distortion shipped.
- Do not declare the overtime fix (candidate 3) complete once halftime/clock logic is mechanically
  correct — separately validate the simulated OT score-pair distribution against Moyer et al.'s
  Table 2 via a chi-square/multinomial test; a clock-correct OT loop can still have the wrong FG-
  vs-TD mix.
- Do not recalibrate margin SD using a single fixed constant from one era (pre-2015 Stern 13.86, or
  2002-2013 Football Perspective 12.1, or Glickman-Stern's 1988-93 12.78) — these visibly differ by
  era and by how much team strength is modeled explicitly. `margin-distribution.js` already has the
  right machinery for this (walk-forward-validated exponential half-life of 6 seasons); reuse it
  rather than picking one literature number and hard-coding it.
- Do not spend build budget on the new totals engine (candidate 8) or the fast closed-form CDF
  (candidate 7) before F01's 6 known physics bugs are actually fixed in the drive simulator —
  calibrating distribution shape on top of broken mechanics (wrong-team turnovers, inverted kneel
  rule, non-decrementing timeouts, home-spread used for away win probability) will just calibrate
  around the bugs and produce a confidently-wrong shape.
