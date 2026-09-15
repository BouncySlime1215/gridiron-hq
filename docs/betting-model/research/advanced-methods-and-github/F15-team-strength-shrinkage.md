# F15 — Empirical Bayes / James-Stein shrinkage for team-strength (bucket: fix)

## 1. Code read (read-only, fantasy-football-dashboard)

Files read in full:
- `server/services/shrinkage-fit.js` (330 lines) — fits `k = sigma2_within/sigma2_between` per
  (metric, position) via one-way random-effects ANOVA, method of moments, unbalanced groups
  (Searle 1992 ch.3). Wired live: `projections.js:31,369` calls `activeKVector()`; three scripts
  (`fit-shrinkage.mjs`, `fit-shrinkage-weekly.mjs`, `fit-weekly-ensemble.mjs`, `fit-role-recency.mjs`)
  read/write it. This is the project's best shrinkage implementation and IS the correct
  empirical-Bayes normal-normal form (see §2) — k here plays exactly the role of `A`/`sigma0^2`
  ratio in Efron's writeup.
- `server/services/stats-util.js` (canonical `shrink`/`shrinkRate`, arcsine-stabilized for rates —
  this is literally Brown (2008)'s own recommended variance-stabilizing move, already present).
- `server/services/nfl-team-strength.js` (481 lines) — the file FOUND names. On inspection this
  file does NOT itself do a "hand-tuned blend of preseason + in-season" — it is a team-level
  AGGREGATOR of `offseason-model.js`/`preseason-model.js` outputs into GBM challenger features,
  gated `blocked` behind `model-governance.js`, explicitly excludes market-derived columns, and
  ships its own walk-forward + paired-bootstrap evaluation harness (`teamStrengthWalkForward`).
  It has never shown significant lift (see its own `recordTeamStrengthGate`).
- `server/services/nfl-roster-strength.js` (424 lines) — **this is where the actual hand-tuned
  blend described in FOUND lives.** `rankPlayer()` combines depth-chart prior, participation,
  performance score and PFF grade with FIXED weights `{0.5, 0.23, 0.17, 0.10}` (plus 0.28 for a
  rookie-prior slot), recency-decays snaps/features by `0.84^index`/`0.82^index`, blends a
  traded veteran's rating `0.88*rating + 0.12*60`, and rolls starters/depth into a roster score
  via a fixed `0.78/0.22` split — none of these eight constants are fit from data; all are
  comments-documented as chosen by feel, the exact anti-pattern `shrinkage-fit.js`'s own header
  calls out ("every strength constant... was chosen by feel, not measurement") for the fantasy
  side, but never extended to this file.
- `server/services/nfl-preseason-blend.js` (411 lines) — **the actual "team strength shrinkage"
  engine**, and it is unexpectedly good: `blendedTeamRating()` implements the textbook
  normal-normal conjugate posterior `weightOnPrior = sigma^2/(sigma^2 + n*tau^2)`, correctly
  derived (verified algebraically against Efron 2010's formula (2) below), with a documented,
  dated bug-fix history (a 2026-09-10 "Codex audit finding M01" that the formula was previously
  INVERTED, crushing the prior's true weight from ~81% to ~17% after one game) and leakage
  discipline (`asOfSeason` cutoff, prespecified fallback constants rather than a globally-fitted
  one). Its own walk-forward test (`WALK_FORWARD_VERDICT`) is an honestly-recorded null result:
  not significant vs. the champion GBM (pooled 2023-2025 challenger MAE 9.86 vs champion 9.84,
  90% CI [-0.017, 0.056]).
  - The gap: this shrinks each team ONLY toward its own PRIOR SEASON mean (a single-unit
    Kalman/time-series update). It never pools across the other 31 teams in the current season —
    which is precisely the mechanism that produces the James-Stein/Efron-Morris gain (see §2:
    Stein's theorem requires N>=4 units shrunk toward a JOINTLY estimated grand mean). So the
    file's docstring claim of doing "the same general thing" 538/DAVE/FPI do is accurate for
    the offseason-fade half of the problem, but it is not yet a full empirical-Bayes/James-Stein
    estimator in the classical multi-unit sense — it's missing the cross-sectional half.
- Grep for shrinkage proliferation: at least 6 independently hand-rolled shrink-toward-prior
  formulas with un-fitted, hardcoded `k`/blend constants exist OUTSIDE `shrinkage-fit.js`'s
  fitted-k infrastructure: `nfl-context-heads.js:39` (own `shrink(observed,prior,weight,k)`),
  `nfl-opponent.js:31` (same signature, separately defined), `nfl-expert-council.js:117`
  (`effectiveN/(effectiveN+30)`, k=30 hardcoded), `nfl-rookies.js:364` (`fit.samples/(fit.samples+80)`,
  k=80 hardcoded), `nfl-props-replay.js:127` (`n/(n+4)`, k=4 hardcoded), `draft-assist.js:995`
  (`min(1, n/30)`). None of these route through `stats-util.js`'s canonical `shrink`/`shrinkRate`
  or through a fitted k. This is the same *category* of defect FOUND already confirmed for CLV
  ("five independent, disagreeing CLV implementations... different math and sign conventions") —
  generalized to the shrinkage layer — though it is my own grep finding, not a verbatim FOUND
  bullet, and is reported as such below.

## 2. Primary sources (4 read in full)

1. **Efron, B. (2010). "The Future of Indirect Evidence." Statistical Science 25(2), 145-157.**
   (arXiv:1012.1161; read in full, 654-line extracted text.) Efron's own restatement of the
   Efron-Morris (1975, JASA) baseball result, with full derivation. Model: mu_i ~ N(M,A),
   x_i | mu_i ~ N(mu_i, sigma0^2), i=1..N=18 (Morris's 1970 batting-average data, 45 at-bats
   each). Bayes rule: mu_hat_i = M + B(x_i - M), B = A/(A+sigma0^2) — i.e. shrink toward the
   GRAND mean M by a factor set by the ratio of prior variance to total variance (identical
   algebra to Gridiron's `stats-util.js shrink()` and `nfl-preseason-blend.js`'s weight formula,
   confirmed by hand: sigma^2/(sigma^2+n*tau^2) is the same normal-normal posterior weight).
   James-Stein estimates M-hat, B-hat via unbiased plug-ins from the DATA ITSELF (no external
   prior needed) — Robbins called this "empirical Bayes." Result: James-Stein's total squared
   prediction error over the 1970 season was **less than one-third** of the naive (direct)
   estimate's error, for N=18 players. Stein's 1956 theorem requires **N>=4** independent units;
   below that the direct estimate cannot be beaten. Efron's own caveat, directly relevant to
   fantasy/player-level shrinkage: JS "conceals poor performance on genuinely unusual cases" —
   Clemente (an outlier great) was shrunk hard toward the mean and JS's point estimate for him
   (0.294) was WORSE than the naive one (0.400 vs truth 0.346) even though aggregate error fell;
   population-level shrinkage is a real cost for legitimately elite/anomalous units even when it
   wins on average.

2. **Brown, L.D. (2008). "In-season prediction of batting averages: a field test of empirical
   Bayes and Bayes methodologies." Annals of Applied Statistics 2(1), 113-152.** (arXiv:0803.3697;
   read in full, 1937-line extracted text.) Sample: every 2005 MLB player with >=11 at-bats in
   the season's first half used to predict the second half; P=567 estimation / 499 validation
   players. Six methods compared on total-squared-error ratio to the naive (direct) predictor
   (naive = 1.0): **Group mean 0.852, EB(ML) 0.902, Harmonic-prior (true Bayes) 0.884, EB(MM)
   0.593, James-Stein 0.525, nonparametric-EB (NPEB) 0.508 (best)**. Two findings directly
   relevant to Gridiron: (a) the MLE-plug-in normal-normal empirical-Bayes variant (EB(ML)) and
   the "true" harmonic-prior Bayes estimator — the class `nfl-preseason-blend.js`'s single-unit
   normal-normal update belongs to — were the **worst-performing shrinkage methods tested**,
   barely beating the crude group-mean predictor and nowhere near James-Stein or method-of-
   moments EB; (b) method-of-moments EB (`shrinkage-fit.js`'s own family) and nonparametric EB
   both clearly outperformed the MLE/harmonic-Bayes class, and NPEB won specifically because the
   real population of talent (pitchers mixed with position players) was visibly non-normal/
   bimodal — exactly the kind of population Gridiron's own QB1-vs-backup, rookie-vs-veteran
   mixtures could plausibly be. Brown also popularized the same arcsine variance-stabilizing
   transform `stats-util.js:arcsine/arcsineInverse` already implements for rate stats.

3. **Ragain, S., Peysakhovich, A., Ugander, J. (2018). "Improving pairwise comparison models
   using Empirical Bayes shrinkage." arXiv:1807.09236.** (read in full, 674-line extracted text.)
   **NFL-specific, real data.** NFL2016 dataset: N=256 games, n=32 teams (16 games/team),
   Bradley-Terry-style conditional-multinomial-logit team-strength model. Out-of-sample MSE on
   held-out win-percentage predictions: **MLE = .0591**; empirical-Bayes shrinkage toward a
   pooled mean, variance estimated via Fisher information or block bootstrap, gets MSE down to
   **.0491 (16.8% reduction)** for the best variant (parametric block bootstrap), 11.1%-15.5%
   for Fisher-information variants. Individual-matchup MSE improved 5.4%-9.2% depending on
   variance estimator. Critically: the NFL's gain was much LARGER than an identically-built
   NBA2016 comparison (N=1260 games, 30 teams, 82 games/team, denser conference connectivity):
   NBA gains were only 5-9%. Mechanism identified: shrinkage helps most exactly where the
   who-played-whom graph is SPARSE and poorly connected (NFL's division/conference schedule
   structure, few cross-conference games) — the non-parametric bootstrap variance estimator
   specifically FAILED on NFL because many team-pairs had only one game ever played, which the
   authors flag as the diagnostic case for needing a parametric (not resampling) variance
   estimate. This maps directly onto Gridiron's own division-heavy, 17-game-season schedule
   sparsity.

4. **Efron, B. & Morris, C. (1975/1977), "Data Analysis Using Stein's Estimator and its
   Generalizations" (JASA) / "Stein's Paradox in Statistics" (Scientific American 236(5),
   119-127).** Not independently fetched as a standalone PDF (paywalled/out of arXiv), but its
   full derivation, data (N=18 players, 45 at-bats, Table 1 reproduced with all 18 rows'
   observed/truth/James-Stein numbers) and >3x total-squared-error result are reproduced
   verbatim and in full mathematical detail inside source #1 above (Efron 2010 IS Efron's own
   restatement of Efron-Morris, written by the same author) — cited here as the foundational
   source per the assignment, sourced through source #1's full read rather than a second
   independent fetch of the same underlying analysis.

## 3. Verdict on Gridiron's existing shrinkage vs. the literature

- `shrinkage-fit.js`'s method-of-moments ANOVA estimator is methodologically sound and, per
  Brown (2008), sits in the SECOND-BEST tier of tested methods (TSE ratio .593, beating harmonic/
  MLE-Bayes at .88-.90) — this validates keeping it, not replacing it.
- `nfl-preseason-blend.js`'s normal-normal single-team update is CORRECTLY derived (matches
  Efron's formula (2) exactly, confirmed algebraically) but sits in the CLASS Brown found to be
  the WORST-performing shrinkage variant (EB(ML)/harmonic — TSE ratio .88-.90) because it only
  ever pools a team's OWN two seasons, never pools cross-sectionally across the other 31 teams
  the way the classical theorem requires (N>=4 units, shrink toward a JOINTLY-estimated mean).
  It is "principled" but incomplete relative to the literature's recommended form.
- `nfl-roster-strength.js`'s player-composite weights are hand-tuned by feel with no shrinkage
  theory applied at all — the actual instance of the anti-pattern FOUND's team-strength bullet
  describes, even though it lives in a different file than the one FOUND named.
- No Bradley-Terry/Elo cross-sectional team-strength model exists anywhere in the codebase that
  Gridiron itself fits and shrinks — `nfelo.js` only imports a third party's already-computed
  Elo ratings (`greerreNFL/nfelo` GitHub CSVs); Gridiron has never built the kind of model
  Ragain/Peysakhovich/Ugander (2018) shrink, so a locally-owned, shrinkage-corrected power
  rating is a genuinely new capability, not a fix to an existing broken one.

## 4. Candidates

See structured output. 3 fix-bucket, 3 new-bucket.

## 5. Do-not-do

- Don't fit or backtest against the live `fantasy-football-dashboard` database or touch any of
  its processes — read-only tonight, a server is capturing Week 1 games live.
- Don't wire any new/refit team-strength shrinkage into a live betting or fantasy decision
  before it clears `teamStrengthWalkForward`'s existing paired-bootstrap gate (>=2 of 3 seasons
  significant) — the project already has this gate; use it, don't bypass it because the method
  is textbook statistics.
- Don't assume the ranking of shrinkage methods transfers from baseball to NFL team margins
  unmeasured — Brown (2008) shows the best method (NPEB vs JS vs EB(ML)) flips depending on
  whether the underlying population is a visible mixture (pitchers/position players) or roughly
  homogeneous; each Gridiron surface needs its own held-out test, not a borrowed verdict.
- Don't apply heavy population-level shrinkage uniformly to known outlier/elite units (a true
  top-5 QB, a historically dominant defense) without a flag — Efron's own Clemente example is
  the standing caution that low aggregate error can conceal a materially worse point estimate
  for exactly the cases a user most cares about getting right.
- Don't fit a new shrinkage constant module-globally across "every season on record" the way
  `nfl-preseason-blend.js` already documented fixing (Codex correction C10) — any new work must
  copy its `asOfSeason` cutoff-safe calibration pattern, not regress to a future-leaking global.
- Don't reach for a non-parametric bootstrap variance estimator for NFL team-pair uncertainty
  the way Ragain et al.'s NBA analysis used — their own NFL result shows it fails exactly when
  many team-pairs share only one game ever played, which describes Gridiron's own division
  schedule; use a parametric (Fisher-information or parametric-bootstrap) variance estimate for
  the NFL case specifically.
