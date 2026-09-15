# N06 — Reinforcement Learning for Drive-Sim Play-Calling and Bet-Sizing/Portfolio

Researcher: N06-rl-for-drive-sim-and-staking (bucket: new)
Date: 2026-09-12

## Scope
Two applications of RL, both currently absent from Gridiron:
1. A play-calling/game-management policy *learned* from data (as opposed to the hand-tuned
   logistic curves currently in `server/services/nfl-sim-policy.js`), gated on the drive
   simulator's physics bugs being fixed first.
2. Bet-sizing / portfolio RL for staking, read against the honest literature on why this
   usually overfits in backtests and the few places it has genuinely worked.

## Grounding in tonight's FOUND list (read first)
Relevant defects this research must respect:
- `server/services/nfl-drive-sim.js` has 6 real physics bugs (turnover field position,
  half/full clock unit mismatch, inverted kneel rule + non-decrementing timeouts, away-team
  WP using home spread, flat 7pt HFA lump, no halftime/OT in the season-remainder simulator).
- Five independent, disagreeing CLV implementations over four tables.
- `server/betting/nfl/strategy/teaser-leg-rates.js` assumes teaser-leg/same-game
  independence with no copula/dependence model.
- `server/services/nfl-policy.js`'s own comments state: "this project has measured exactly
  zero forward CLV to justify assuming otherwise" (re: probabilityHaircut) — i.e. there is
  currently no forward-evidence sample to train or honestly evaluate any RL agent against.
- No conformal/honestly-calibrated uncertainty anywhere in the pipeline.

## Codebase reconnaissance (read-only, `fantasy-football-dashboard`)

- `server/services/nfl-drive-sim.js` (1280 lines) — the play-by-play simulator. Explicitly
  documents its own philosophy in its header comment: it does NOT claim to beat the market,
  calibration is "a floor, not an edge." Structure: learned team rates in
  `nfl-sim-learn.js`, "twenty strategic decision modules" in `nfl-sim-policy.js`, engine here.
- `server/services/nfl-sim-policy.js` (618 lines) — 20 hand-written decision functions:
  `fourthDownByExpectedPoints`, `fourthDownByWinProbability`, `twoPointDecision`,
  `onsideDecision`, `kneelDecision`, `timeoutPolicy`, `preventDefense`,
  `fieldGoalRangeDecision`, `spikeDecision`, `intentionalSafety`, `twoMinuteWarning`,
  `coachAggression`, `deepShotPolicy`, `gameScriptPassRate`, `minimaxLean`, etc. These are
  logistic-curve heuristics informed by published analytics results (comment: "the
  fourth-down surface, the two-point chart, key-number distributions... encode published
  football-analytics results"), NOT learned end-to-end from Gridiron's own simulator or
  from real outcome data. `kneelDecision` (line 291) and `timeoutPolicy` (line 316) are
  exactly the functions FOUND flags as buggy (kneel inverted, timeouts not decremented).
- `server/services/nfl-sim-learn.js` — `expectedPointsSurface(driveFn, {trials, seed})`
  (line 413) and `expectedPoints(surface, yard)` (line 460) already compute a Monte-Carlo
  expected-points-by-field-position surface from the simulator itself. This is exactly the
  state-value ingredient a backward-induction/value-iteration policy needs — it already
  exists, just isn't used to *solve* for an optimal policy, only to *inform* hand-set
  thresholds.
- `server/services/nfl-policy.js` (268 lines) — `NFL_PRODUCTION_POLICY` v1.2.0: a frozen,
  versioned decision policy with `minEdge`, `maxDisagreement`, `requireCalibratedAdvantage`,
  `minExpectedReturn` (0.01, computed at the OFFERED price, not just fair-value), and a
  `probabilityHaircut` (0.01) the comments admit is not measured because there is no forward
  CLV history. This is a real governance gate any RL-driven staking policy would have to
  pass through — it is not naive.
- `server/betting/nfl/strategy/teaser-staking.js` (1364 lines) — genuinely rigorous existing
  math: derives closed-form Kelly for the actual 3-outcome (win/reduced/push/loss) teaser
  payoff structure via `g(f) = W·ln(1+fb) + R·ln(1+fr) + L·ln(1-f)`, proves g is concave,
  and implements both `closedFormKelly` and a numeric `kellyForOutcomes` solver that agree to
  1e-12. This is NOT the "naive point-estimate Kelly" a first-pass RL project might assume it
  needs to fix — Gridiron's Kelly math is already correct for its payoff structure. The gap
  is not the Kelly formula; it's that the FRACTION-OF-KELLY multiplier and the price/EV gate
  are static, not adaptive, and there's no online estimate of how well-calibrated the input
  probabilities currently are.
- `server/betting/nfl/strategy/teaser-leg-rates.js` — measures pooled leg rate 74.0586% on
  1999-2024 data (excludes 2025-2026 for a documented data defect: whole-integer spreads are
  missing from those seasons' `game_lines.spread`). Confirms FOUND's independence assumption:
  documents "no same-game double-count" via `familyPairCorrelation` finding 0 same-game
  pairs in the FAMILY, but this is about not double-counting a leg with its own counterpart —
  it is not a measured correlation between two DIFFERENT legs placed in the same week, which
  is the actual portfolio-correlation gap FOUND identifies.
- `server/migrations/027_decision_tape.js` — `nfl_decision_runs` + `nfl_decision_events`,
  an append-only, content-addressed (board_hash) decision tape recording every candidate
  considered and why it was passed over, not just what was selected. This is the ideal raw
  material for off-policy evaluation (OPE) of any future RL policy — it already exists and
  already solves the "only winners get logged" survivorship problem that plagues naive
  backtests.
- No RL, policy-gradient, Q-learning, or bandit code exists anywhere in `server/` (grep for
  reinforcement/policy gradient/q-learning returned nothing). This is a genuinely greenfield
  capability area.

## Sources read

### 1. Biro, J. & Walker, T. — "A Reinforcement Learning Based Approach to Play Calling in
   Football" (2021, published J. Quant. Analysis in Sports 2022). arXiv:2103.06939.
   **Read in full (HTML rendering).**
   - Method: NOT deep RL — exact tabular value iteration over an MDP, three algorithms of
     increasing sophistication (naive value iteration ~5 iterations to converge; an
     ordered/acyclic-state one-pass method; a semi-ordered method handling recursive
     defensive-possession states).
   - State: (DOWN, DIST, LOS) pre-play, plus score differential and time remaining late-game.
     Action: RUN or PASS (plus FG/PUNT on 4th down). Reward: terminal only (+7 TD, +3 FG,
     -7/-2 defensive TD/safety); everything else is 0 immediate reward, value comes from the
     Bellman backup.
   - Data: NFL 2017-2018 for training, 2019 for validation — exact play/game counts not
     disclosed in the paper.
   - Result vs benchmark: utilities correlate 0.95 with Yurko et al.'s published Expected
     Points model; late-game win-probability calibration plots show reasonable but
     under-confident alignment; 1,000 simulated random drives show the optimal play-caller
     beating historically-observed coaching patterns in expected utility.
   - Honest limitations stated by the authors themselves: assumes all run/pass sub-plays
     share identical yardage distributions ("clear and obvious differences" ignored);
     assumes all NFL offenses/defenses are equally effective ("obviously also a false
     assumption"); treats possessions as independent (no "establishing the run"); no
     discount factor for scoring pace; late-game utilities "not trained to convergence";
     the whole model is a "collective league-average offense," explicitly wrong for
     run-heavy teams (they name Tennessee, SF, Baltimore); "following these methods
     perfectly do[es] not guarantee success," and a defense that knows the policy could
     exploit its predictability.
   - Relevance: this is the direct academic precedent for Gridiron's proposed N1 candidate
     below — same idea (solve the MDP the simulator already implies via value iteration
     rather than hand-tuning thresholds), same honest caveat (league-average, not
     team-specific) that Gridiron would inherit at its current data scale.

### 2. (authors per arXiv listing) — "Learning Risk Preferences in Markov Decision
   Processes: an Application to the Fourth Down Decision in the National Football League"
   (2023). arXiv:2309.00756. **Read in full (HTML rendering).**
   - Method: inverse optimization over a quantile-MDP — rather than inferring a reward
     function (classic inverse RL), infers which quantile τ of the next-state value
     distribution best rationalizes each coach's observed 4th-down choices (minimizes
     Hamming distance between observed and τ-optimal actions).
   - Data: NFL play-by-play 2014-2022 (9 seasons) via the public `nflfastR` package/
     `nfl4th` win-probability model as the benchmark "optimal" actor.
   - Result vs benchmark: real coaches' inferred τ is significantly below `nfl4th`'s
     WP-optimal recommendation (i.e., empirically confirmed excessive risk aversion,
     consistent with the older Romer 2006 NBER dynamic-programming finding), more
     risk-tolerant in opponent's territory than in their own, and league-wide risk
     tolerance has risen 2014→2022 with a positive correlation to team performance.
   - Honest limitations: state space excludes score/timeouts/time explicitly for
     computational tractability (win probability is used as an imperfect proxy for all
     three); no team-specific transition probabilities (data too sparse); acknowledged
     selection bias (coaches rarely "go for it" in bad spots, so those states are
     underobserved); the paper states its own model "likely cannot perfectly describe any
     coach's objective function."
   - Relevance: independent confirmation that (a) real decision-makers are measurably
     suboptimal against a WP-based bot, which is the entire premise of building a learned
     policy at all, and (b) even a fairly sophisticated academic version of this needs to
     drop most of full game-state to stay estimable — a caution against over-scoping
     Gridiron's own state space on the first attempt.

### 3. Beggy, J., Kim, D., Mucaj, K., Nordell, J. (advisor Wyner) — "An Investigation of
   Sports Betting Selection and Sizing." Wharton Sports Analytics Student Research Journal,
   Spring 2023. **Read in full (10-page PDF, downloaded and read page-by-page).**
   - Data: top-5 European soccer leagues' odds; after filtering out obscure leagues,
     odds > 4.0 (a variance-control decision, not theory-driven), and near-arbitrage lines,
     121,507 candidate lines remain; bet selection used a fixed EV-margin threshold against
     the average-of-books "fair" proxy (a naive devig method — no vig-removal model
     comparison, same gap FOUND flags for Gridiron).
   - Method: compares constant $50 flat bets, Full Kelly, Half Kelly, Quarter Kelly, at
     three EV-margin thresholds (2.5% aggressive / 5% baseline / 10% conservative).
   - Honest quantitative result (their own numbers, not paraphrase): at the 5% baseline
     threshold (10,275 bets), Full Kelly (even capped at 20% of bankroll) goes to zero —
     "Full Kelly simply does not work... it led to bankruptcy in 100% of the scenarios";
     Half Kelly also ruins in every simulation at that threshold, just later; Quarter Kelly
     nets +$40,374 profit. At the 10% conservative threshold (only 369 bets), Full Kelly
     avoids ruin (−$1,549), Half Kelly nets +$115,097, Quarter Kelly nets +$62,425. At the
     2.5% aggressive threshold (79,860 bets, i.e. much lower-quality bets included), every
     single strategy — flat AND every Kelly fraction — goes bankrupt.
   - Their conclusion: fractional Kelly (0.5×) plus a strict, conservative EV-margin
     threshold, not the raw Kelly formula or bet volume, is what makes this profitable
     (roughly 80% annualized return over the 11-year dataset horizon, at only 369 bets/11yr
     — i.e. a low-volume, high-selectivity regime much closer to Gridiron's real teaser
     volume of 15-33 tickets/season than to a high-frequency strategy).
   - Relevance: direct, real-data confirmation that (a) full/high Kelly is dangerous even
     capped, exactly as the sports-betting folklore says, (b) the SELECTION threshold and
     the KELLY FRACTION interact — you cannot tune one without the other — and (c) a
     completely static, non-adaptive fractional-Kelly-plus-threshold rule already captures
     most of the achievable value in a low-volume regime. This directly bounds how much
     upside an RL/bandit bet-sizing layer can realistically add on top of what Gridiron's
     `teaser-staking.js` + `nfl-policy.js` gates already do.

### 4. Zhang, Z., Zohren, S., Roberts, S. — "Deep Reinforcement Learning for Trading."
   Journal of Financial Data Science, 2020 (arXiv:1911.10107, Oxford-Man Institute).
   **Read in full (13-page PDF, downloaded and read page-by-page).**
   - Data: 50 of the most liquid futures contracts (25 commodity, 11 equity index, 5 fixed
     income, 9 FX — full list in their Appendix A), daily data 2011-2019, sourced from the
     Pinnacle Data Corp CLC database.
   - Method: three RL algorithms compared — DQN (discrete position: long/flat/short),
     Policy Gradient, Advantage Actor-Critic (continuous position sizing) — with volatility
     scaling built into the reward function (scale up position when vol is low, down when
     vol is high) and realistic transaction costs (tested up to 25bp, ≈$3.5/contract,
     described as realistic for a retail trader).
   - Honest out-of-sample result vs a real benchmark: outperforms a classical time-series
     momentum baseline (Moskowitz-Ooi-Pedersen sign-of-past-year-return) IN AGGREGATE across
     all four asset classes, and remains profitable even at the highest simulated cost rate.
     BUT their own Figure 3 boxplots show this is asset-class-dependent: equity-index and
     fixed-income Sharpe ratios are solidly positive and consistent (median ~0.3-0.6+),
     while commodity and FX Sharpe ratios straddle zero with wide variance across
     individual contracts — i.e., "RL beats a naive baseline in trading" is true on average
     but not uniformly, and the paper is honest that this varies by market microstructure
     (fixed income trends persistently; FX/commodities are noisier and more mean-reverting).
   - Relevance: this is the strongest available evidence that RL CAN work in a
     closely-related low-signal-to-noise financial domain — but the setting that works
     (daily, continuously-tradeable, re-balanceable positions across dozens of correlated
     liquid instruments, years of data) is structurally almost the opposite of NFL betting
     (one-shot discrete bets, ~15-33 opportunities/season for the one strategy Gridiron has
     actually measured an edge candidate for, no ability to "hold and rebalance" a bet
     mid-flight). The paper is evidence FOR RL in finance broadly and evidence AGAINST
     assuming it transfers directly to Gridiron's data volume/action structure.

### Supporting (not read in full, cited for method only)
- Bailey, D., Borwein, J., López de Prado, M., Zhu, Q.J. — "The Probability of Backtest
  Overfitting" (SSRN 2326253 / J. Computational Finance). PDF fetch was blocked by the
  publisher (403); summarized from a secondary LBL-hosted copy and standard citations.
  Method: combinatorially symmetric cross-validation (CSCV) — repeatedly split a backtest's
  trials into in-sample/out-of-sample halves and measure how often the in-sample-best
  strategy ranks poorly out-of-sample; PBO rises sharply as the number of strategy variants
  tested on the same data grows. This (plus the companion Deflated Sharpe Ratio, Bailey &
  López de Prado 2014) is the standard honest-evaluation machinery cited by nearly every
  later paper on RL-for-trading overfitting, and is the mechanism proposed for candidate N3
  below.
- "Deep Reinforcement Learning for Cryptocurrency Trading: Practical Approach to Address
  Backtest Overfitting" (ICML/arXiv:2209.05559). Abstract + landing page read (PDF was
  binary/unparseable). Data: 10 cryptocurrencies, ~2-month out-of-sample window
  (5/1/2022-6/27/2022) spanning two crypto crashes. Method: formulates overfitting detection
  as a hypothesis test on trained DRL agents, rejects agents that fail it. Result quoted
  directly from the paper: "less overfitted deep reinforcement learning agents have a higher
  return than that of more overfitted agents, an equal weight strategy, and the S&P DBM
  Index" — i.e., filtering by an overfitting test genuinely improved live-ish results, but
  on a short window and a single volatile asset class. Not counted as read-in-full because
  only the abstract/landing text was recovered, not the method/results body.
- nflverse/nfl4th (GitHub, 22 stars, license "other", actively maintained — pushed
  2026-09-01). Cloned and inspected (`R/decision_functions.R`, `R/apply_win_prob.R`,
  `data-raw/_go_for_it_and_2pt_models.R`). Confirmed: this is NOT reinforcement learning —
  it is XGBoost-trained win-probability and 4th-down-outcome models applied as a one-step
  lookahead (enumerate punt/FG/go-for-it, predict WP for each from real nflfastR outcomes,
  pick the max). It is the real-world production analogue of what Gridiron's
  `fourthDownByWinProbability` hand-tunes with logistic curves instead of learning from
  data, and is exactly the benchmark the "Learning Risk Preferences" paper (#2 above) used
  to show coaches are too conservative. Reference-only: R codebase, not directly portable,
  but the *method* (learn outcome models from real play-by-play, do lookahead, don't
  hand-set the curve) is the adoptable idea, independent of whether the final Gridiron
  policy is built via RL/value-iteration or via a simpler supervised lookahead like this.

## Why sports-betting/trading RL usually overfits (synthesis across sources)
1. **Multiple testing without correction.** Every honest source here (Bailey et al.'s PBO,
   the crypto DRL paper's overfitting-hypothesis-test fix, and implicitly Beggy et al.'s
   own 3×4 grid-search-and-report-the-best-cell design) points to the same failure mode:
   try many variants, report the best, call it the strategy. Gridiron already has this
   exact exposure today and it's independent of RL — FOUND notes "no trial registry exists
   with real preregistration + multiplicity correction... for the 21-model historical search
   that has already been run." Any RL work multiplies this risk (hyperparameters, reward
   shaping, architecture, and random seeds are all additional "trials") unless the same
   registry discipline is applied to it.
2. **Reward/state definitions leak information or use unrealistic costs.** The crypto paper
   and the trading-RL literature broadly note that unrealistic transaction costs are a
   common inflator; Zhang/Zohren is unusually honest by explicitly stress-testing at 25bp
   and reporting the asset classes where the edge disappears. Gridiron's staking layer
   already accounts for at-the-price expected return (`minExpectedReturn` at the OFFERED
   price, not fair value) — a real strength to preserve in any RL reward function, not
   discard for a simpler backtest-friendly reward.
3. **Sample size mismatch.** RL — even simple contextual bandits — typically wants hundreds
   to thousands of decisions to separate signal from noise. Gridiron's one measured-edge
   candidate strategy (Wong teaser) sees 15-33 tickets/SEASON. This is the single biggest
   reason a bet-SIZING RL/bandit pilot here is low-expected-value almost by construction —
   there just aren't enough decisions per season for online learning to beat a well-chosen
   static fractional-Kelly rule, which is exactly what Beggy et al.'s data shows empirically
   (static rule at low volume already captures most of the value).
4. **Action-space/domain mismatch.** Where RL has "genuinely worked" (Zhang/Zohren), the
   setting is continuously-adjustable positions across many correlated, liquid instruments
   over years of daily data — not one-shot bets on discrete weekly outcomes. The genuine
   analogue in Gridiron is closer to "how much of the weekly bankroll to allocate across the
   full slate of that week's positive-EV opportunities," i.e., a portfolio problem — but that
   requires the correlation structure FOUND says doesn't exist yet (teaser-leg-rates.js
   assumes independence).
5. **Backtest-only validation is close to worthless without an OPE/PBO check.** This is the
   most consistent, most repeated finding across every source read for this brief (Bailey et
   al.'s founding paper on the topic, the crypto DRL paper built explicitly to fix it, and
   the general critical-survey literature on RL-for-trading). It applies with full force to
   any RL policy trained on the drive-sim or any bandit trained on staking history.

## Where RL has genuinely worked (honest, not hype)
- Exact/tabular value iteration and dynamic programming over small, well-understood MDPs
  (Romer 2006's NBER paper; Biro & Walker 2021) — these are not "AI hype" applications, they
  are classical operations-research techniques that happen to fall under the RL umbrella,
  and they work because the state space is small and the transition model is directly
  estimable from data, not because of deep-network function approximation.
- Continuous position-sizing RL in liquid, dense, multi-instrument financial markets with
  realistic transaction costs modeled from the start (Zhang/Zohren) — genuinely works, but
  in a data/action regime NFL betting does not have.
- Overfitting-aware pipelines that explicitly test and reject candidate policies before
  trusting backtest performance (the crypto DRL paper's core contribution, and the whole
  point of Bailey et al.'s PBO machinery) — this is "RL infrastructure," not "RL edge," and
  it is the most transferable, lowest-risk piece of this literature for Gridiron to adopt
  FIRST, independent of whether any actual RL policy ever ships.

## Do-not-do list
- Do not train any RL agent (tabular or deep) against `nfl-drive-sim.js` until the 6 physics
  bugs are fixed and re-verified — an agent trained on broken kneel/timeout/turnover-position
  mechanics will learn to exploit the bugs, not football, and will look sophisticated while
  being worse than the current hand-tuned policy.
- Do not use any of the 5 disagreeing CLV implementations as an RL/bandit reward signal.
  Consolidate to one canonical CLV computation first — an ambiguous-sign reward makes "the
  agent is improving" unfalsifiable.
- Do not allow an RL/bandit staking layer to select a Kelly multiplier above 0.5× the
  existing closed-form Kelly output. Beggy et al.'s own data shows Full Kelly bankrupts
  100% of realistic backtest scenarios even capped at 20% of bankroll, and Half Kelly still
  ruins at the more permissive EV threshold — there is no honest case for letting an
  algorithm discover this the hard way with real money.
- Do not promote any RL/bandit/value-iteration policy to production on backtest performance
  alone. Require the off-policy/PBO-style check in candidate N3 first — this is the single
  most repeated lesson across every source read for this brief.
- Do not start with a deep neural-network policy-gradient agent for play-calling. The
  corrected simulator's state space (down/distance/yard-bucket/score-bucket/clock-bucket) is
  small enough for exact tabular value iteration, which is cheaper, fully interpretable, and
  reproducible byte-for-byte — deep RL's exploration instability buys nothing extra at this
  state-space size and adds a large new source of the "many trials, pick the best seed"
  overfitting risk described above.
- Do not attempt team-specific (as opposed to league-average) play-calling RL yet. FOUND
  already notes 251,591 rows of play-by-play are "used only for hand-built features, never
  sequence models" — team-specific policies need that sequence-model upgrade as a
  prerequisite; Biro & Walker's own paper hit exactly this wall with more data than Gridiron
  currently structures for this purpose.
- Do not build a multi-bet portfolio-allocation RL/optimizer across a weekly slate while
  `teaser-leg-rates.js` still assumes zero same-game/same-week correlation. Measure the real
  correlation first (candidate F3) — it may well turn out to be indistinguishable from zero
  at Gridiron's actual bet volume, in which case the portfolio-RL idea should be shelved
  entirely rather than built on an assumption nobody has checked.
- Do not treat "reinforcement learning" as a single technique with one honest track record.
  The literature above genuinely disagrees on whether it works depending on domain (DP/value
  iteration: yes, in small MDPs; deep RL in liquid multi-asset markets: yes, but not
  uniformly across asset classes; deep RL in illiquid/low-volume/short-window domains: the
  default outcome in the honest literature is overfitting unless specifically guarded
  against). Do not let a pitch for "RL" skip specifying which of these three regimes it's
  claiming — they have different cost, different risk, and different evidence behind them.
