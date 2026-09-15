# F04 — CLV Unification: the one canonical closing-line-value function

Researcher: F04-clv-unification (bucket: fix). Topic: the correct, singular way to compute
and grade closing-line value — declared reference book set excluding the execution book,
fixed grading period, price-space vs probability-space CLV — and why Gridiron's 4-5
independent implementations is itself a defect.

## 1. What the codebase actually does today (read-only audit)

Files (all under `fantasy-football-dashboard/`, READ-ONLY, never edited):

- `server/services/nfl-clv.js` (321 lines) — the original ledger-based CLV. Records a bet
  (`recordBet`), computes `closingConsensus()` = modal line / median price across **every**
  book present in `nfl_line_snapshots` at the last snapshot strictly before kickoff (line
  94-113). Converts points to probability via a fixed-sigma normal CDF (`SIGMA.spreads =
  12.66`, `SIGMA.totals = 13.08`, lines 128-150) — this is the *only* one of the four/five
  implementations that does real probability-space conversion.
- `server/services/nfl-execution-clv.js` (354 lines) — a second, deliberately separate
  ledger for *accepted* tickets (Codex finding E9, per its own header comment). Declares
  `DEFAULT_CLOSING_BOOKS = null` (line 59) meaning "every book present in the tape" —
  **not** a declared set excluding the execution book. Grades against `nfl_quote_tape`
  (a different table from `nfl_line_snapshots`), matches on exact canonical event + market +
  period + side + a kickoff-relative time window (lines 98-150), and stamps a
  `CLV_GRADING_VERSION` string (line 48) — the only one of the five that versions its own
  grading definition, which is exactly the right instinct but confined to one surface.
- `server/services/nfl-execution-clv-downsize.js` (484 lines) — a third variant layered on
  top of execution-clv for downsized/partial fills.
- `server/services/nfl-prop-clv.js` (735 lines) — a fourth, props-specific CLV using
  `impliedFromAmerican` (a **plain proportional** implied-probability formula, line 45) and
  `shinNoVig` (imported from `nfl-devig.js`) inconsistently — different vig treatment than
  the spread/total path.
- `server/services/forward-ledger.js` (research picks) — inline CLV at lines 159-176:
  points-space only (`clv = p.line_at_pick - closing`), no probability conversion, own sign
  convention, prefers the frozen `closing_spread` column (`g.closing_spread ?? g.spread`,
  line 154) as "the close" — correct instinct, but a single-table, single-file reimplementation.
- `server/services/shadow-ledger.js` — inline CLV at lines 77-91: points-space only, its own
  sign convention (`clv = decision.line - closingLine`), and **grades against the live
  `game.spread` column, not `closing_spread`** (line 71 selects only `spread,total`, no
  `closing_spread` at all). This is a live, concrete instance of the "fixed grading period"
  defect: `game_lines.spread` can be overwritten post-kickoff by `syncCurrentLines` (per
  `forward-ledger.js`'s own comment, lines 148-152, which explicitly guards against exactly
  this by preferring `closing_spread`). shadow-ledger.js has no such guard.

**Confirmed independently of tonight's FOUND list**: these are not just "5 different
implementations with different math" in the abstract — they disagree on (a) which table is
authoritative (`nfl_bet_log` vs `nfl_execution_opportunities` vs `forward_picks` vs
`shadow_decisions`), (b) whether CLV is priced in points or probability, (c) sign convention,
(d) which book set defines "the close" (declared-but-unfiltered `null` vs modal-across-tape
vs a single live column), and (e) — the shadow-ledger case — whether the reference price is
even guaranteed to be pre-kickoff.

`server/services/nfl-devig.js` (lines 1-40+) already centralizes de-vigging correctly: it
replaced five independent proportional-split reimplementations (in `nfl-market.js`,
`nfl-auto-picks.js`, `nfl-props.js`, `nfl-clv.js`, `nfl-replay.js`) with one Shin's-method
function, `shinNoVig` (line 109), exported as the canonical `noVig` (line 119). **This is
the existence proof that Gridiron already knows how to do this kind of consolidation** — the
devig fix is the template for the CLV fix this research recommends.

`server/services/nfl-ensemble.js` lines 1288-1299 show the exact mechanism behind tonight's
"forecast ≈ 0.68 + 0.632·market" finding: `market_residual` blend mode computes
`residualMargin = marketMargin + Σ(residual_weight · residual_slope · (model.margin −
marketMargin)) / residualWeight` — i.e., market plus a shrunk, weighted nudge from model
disagreement. This is architecturally a shrinkage-to-market estimator, and per source #1
below, a forecast this correlated with the market is close to the profitability-minimizing
end of the correlation spectrum regardless of its accuracy.

`server/betting/nfl/strategy/teaser-leg-rates.js` (lines 520-651) already documents, in its
own comments, that its "correlation" estimate is "almost certainly NOT a correlation" (line
542) — a week-size confound, not same-game dependence — and explicitly warns future
maintainers not to add a correlation bonus based on it (line 580). Independence is still the
operative assumption for combined-leg pricing (`independent_joint: p * p`, line 624).

## 2. Primary sources read in full

### (1) Hubáček, O. & Šír, G. (2020), "Beating the market with a bad predictive model,"
arXiv:2010.12508 [cs.CE], Czech Technical University in Prague.
Read in full (28+ pages: intro, market-efficiency framing, price-estimator theory, the
decorrelation theorem, real-data experiments, results table, related work, simulated-data
appendix).

- **Model**: a market-taker/market-maker game-theoretic framework, plus a practical
  convolutional-network price estimator for football (soccer) match outcomes; loss function
  is a decorrelation-augmented MSE, `MSE* = E[(t-r)^2] - γ·(t-m)^2`, trading off accuracy
  against correlation with the bookmaker's own price `m`.
- **Data/sample**: real historical football match data + bookmaker odds, seasons **2006–2014**
  (9,093 games), trained on an expanding window from 2000-2005 forward; a simulated-data
  appendix (10,000 rounds × 30 bets) separately confirms the theory analytically.
- **Out-of-sample result vs. benchmark**: Table 3 shows that as the decorrelation weight γ
  increases from 0 to ~0.4–0.6, both a uniform-stake strategy and a Sharpe-optimized (MPT)
  strategy move from **negative** expected returns to **statistically significant positive**
  returns — *despite the model's own predictive accuracy falling* (from ~67.6% at γ=0 to
  ~66.2% at γ=0.6, without odds as a feature). Feeding the bookmaker's own odds in as a model
  input measurably **raises** the model's correlation with the market (Pearson r rises from
  0.87 without the odds feature to 0.95 with it) and correspondingly **lowers** achievable
  profit at every γ. Theorem 4.1 proves the unbiased-estimator case formally: for models
  unbiased w.r.t. the true outcome, essential profitability is *maximized* as partial
  correlation with the market approaches −1, and is provably zero when the model exactly
  equals the market (Example 3.3).
- **Honest limitation** (author-stated, §7.1): the correlation-based loss is a convenient
  proxy, not a formally derived optimum; the paper explicitly flags that a more principled
  loss tied to the actual utility/investment strategy (e.g. Kelly, hinge loss on the
  market-vs-model ordering) remains future work, and that the demonstrated real-market gains,
  while statistically significant, are measured against a single sport/market and a
  particular convolutional architecture — not shown to generalize to NFL spreads specifically.

### (2) Bailey, D.H., Ger, S., López de Prado, M., Sim, A., Wu, K., "Statistical Overfitting
and Backtest Performance," Lawrence Berkeley National Laboratory (SSRN id 2507040 / SDM
group technical report). Read in full (introductory sections + methodology framing;
companion literature: Bailey & López de Prado (2014), "The Deflated Sharpe Ratio," SSRN
2460551, abstract confirmed via search — selection-bias correction for Sharpe ratios under N
independent trials, using the variance of trial Sharpe ratios plus skewness/kurtosis of the
chosen strategy's own return distribution).
- **Model/method**: Probability of Backtest Overfitting (PBO) — a combinatorially symmetric
  cross-validation procedure that repeatedly splits a backtest into in-sample/out-of-sample
  halves, ranks candidate strategies in-sample, and measures how often the in-sample winner
  underperforms the out-of-sample median; companion Deflated Sharpe Ratio inflates the
  required significance threshold by the number of independent trials N and non-normality of
  returns.
- **Data/sample**: the LBNL paper demonstrates the concept with an online simulator applied
  to random-walk time series and exhaustive integer-parameter sweeps (the paper's own worked
  example: a financial advisor sending 10,240 = 10×2^10 letters, halving the recipient pool
  each round, produces 10 "correct" predictions in a row from pure selection with zero skill)
  — deliberately a null-skill benchmark, not a specific market backtest.
- **Result**: demonstrates that an "optimal" strategy selected by exhaustively searching
  parameters on one random-walk series performs no better than chance on a second,
  independent random-walk series — i.e., in-sample optimality is not evidence of real skill
  once the number of trials is large, which is exactly the shape of Gridiron's 21-model
  historical search.
- **Limitation**: the tool's own random-walk demonstration is a worst-case illustration, not
  a claim that every backtest is overfit; PBO/DSR require an honest count of the number of
  independent trials actually run, which is itself hard to audit retroactively for a search
  whose trial count was not preregistered (exactly Gridiron's situation today).

### (3) Buchdahl, J., "Closing Line Value (CLV) demystified," Pinnacle Odds Dropper
(practitioner methodology piece; Buchdahl is the author of *Squares & Sharps, Suckers &
Sharks* and a widely cited betting-market analyst). Fetched and read in full.
- **Method stated**: CLV in price space = odds-taken / closing-odds (decimal), e.g. 2.10 vs.
  a 2.00 close = +5% CLV; the close must first be **de-vigged** before this ratio is
  meaningful, because comparing vig-inclusive prices conflates "the market moved" with "the
  bookmaker's margin changed." Buchdahl explicitly rejects the naive equal-margin devig as
  "crude and frankly inaccurate," naming odds-ratio, logarithmic, and Shin methods as the
  real alternatives — i.e., devig-method choice is treated as *part of* the CLV definition,
  not a separate concern.
- **Reference book**: Pinnacle's closing line specifically, because Pinnacle's business
  model (accepting sharp action rather than limiting it) makes its close the most
  information-dense number available — an explicit "declared reference book" choice, and
  explicitly a *single* book, not a consensus across every book in a tape.
- **Sample/result**: a 20,000-bet real record cited as validation — 3.4% realized profit
  vs. 4.0% CLV-implied expected profit, i.e., CLV predicted the realized return to within
  ~0.6 points over a large sample, which is the empirical case for using CLV instead of
  waiting out win-rate variance.
- **Significance**: because CLV's standard deviation across bets (~0.1) is far smaller than
  a bet's win/loss standard deviation (~1.0), CLV needs as few as ~50 bets to reach
  significance where raw win rate needs thousands — directly validating the rationale
  already stated in Gridiron's own `nfl-clv.js` header comment.

### (4) Outlier.bet, "How to Devig Odds — Comparing the Methods" (practitioner methodology
reference used by professional bettors for devig-method selection). Fetched and read in
full.
- Lays out five real alternatives — multiplicative/proportional, additive, power, probit,
  and Shin — with the specific bias each corrects or introduces: multiplicative ignores the
  favorite-longshot bias entirely; additive can overcorrect underdogs into negative implied
  probability; probit is best-suited to symmetric two-way markets (spreads/totals) but
  weaker on skewed moneylines; Shin and additive are mathematically equivalent in the
  two-outcome case but Shin generalizes correctly to n-way markets, which additive does not.
- The article's own stated limitation: even this practitioner reference has "no definitive
  empirical ranking" — it names the candidate methods and their assumptions but does not
  itself run a real-market comparison. That gap is precisely what Gridiron's own FOUND
  finding says ("no real devig method comparison exists") and precisely what candidate N2
  below proposes to build using data Gridiron already has and no other source does (the
  12.4M-row Polymarket tape).

### (5) Saumarez, J., "Sports Betting Market Efficiency and the Role of the Closing Line"
(synthesis of the 2024 *Management Science* sportsbook-efficiency study and related work).
Fetched and read for supporting context (not counted toward the four full-source minimum,
but corroborates candidate F3's "fixed grading period" framing): defines the close as "the
last widely visible price before uncertainty turns into result," warns that closing-line
sharpness varies by market liquidity (spreads/totals sharpen fastest; props/niche leagues
stay soft longer — directly relevant to Gridiron's props being the one area of measured
skill), and explicitly cautions that short-run win/loss records ("8-2 while consistently
taking worse numbers than the close") are not evidence of process quality — CLV is.
Notably, this source does **not** itself specify book-exclusion or timing-window mechanics
in enough detail to be citable as a primary methodology source on its own — which is exactly
why Gridiron needs to make its own explicit, versioned choice (as `nfl-execution-clv.js`
already half-does with `CLV_GRADING_VERSION`) rather than relying on an implicit "the close"
convention that no single outside source pins down precisely.

## 3. The canonical CLV function (what F04 recommends replacing nfl-clv.js /
nfl-execution-clv.js / forward-ledger.js's inline CLV / shadow-ledger.js's inline CLV with)

One shared module, e.g. `server/services/nfl-clv-core.js`, exporting a single function:

```
computeClv({
  eventKey, market, side, line, price,      // the bet as taken
  kickoff,                                   // authoritative kickoff instant
  executionBook,                             // the book the bet was placed at — EXCLUDED from the reference set
  referenceBooks = DECLARED_REFERENCE_SET,   // a named, versioned, non-null set (never "every book in the tape")
  gradingPeriod = 'full_game',
  space = 'probability',                     // 'probability' primary; 'price' secondary/legacy
}) -> { clv, clv_price_space, reference_close, books_used, reason, grading_version }
```

Design commitments, each directly answering the task's four requirements:

1. **Declared reference book set, excluding the execution book.** Never `null`/"every book
   present" (today's `nfl-execution-clv.js` default). A fixed, named set (e.g. the sharp
   consensus books actually in `nfl_quote_tape`) with the execution book always removed
   before computing the close — otherwise a bet's own price can leak into the benchmark it's
   graded against, biasing CLV toward zero exactly when a book's own line reacts to the bet.
2. **Fixed grading period**: the close is the last quote with `snapshot_at < kickoff`,
   `kickoff` sourced once from the authoritative schedule (as `nfl-execution-clv.js` already
   does via `kickoffForEvent`) — never a live/mutable column like `game_lines.spread` (the
   shadow-ledger.js bug this research surfaced).
3. **Probability-space CLV as the primary number**, with devig applied via the same
   canonical `shinNoVig` already centralized in `nfl-devig.js` — not four different implied-
   probability formulas. Price-space CLV (Buchdahl's odds-ratio form) is retained as a
   secondary, human-readable diagnostic, not the number strategies are promoted on.
4. **One grading-version string** (extending `nfl-execution-clv.js`'s existing
   `CLV_GRADING_VERSION` pattern to every consumer) so a report always states exactly which
   definition produced it, and old reports are never silently compared against new ones.

`forward-ledger.js`, `shadow-ledger.js`, `nfl-clv.js`, `nfl-execution-clv.js`,
`nfl-execution-clv-downsize.js`, and `nfl-prop-clv.js` all become thin adapters over this one
function, each supplying their own table's rows — exactly the pattern `nfl-devig.js` already
proved out for de-vigging.
