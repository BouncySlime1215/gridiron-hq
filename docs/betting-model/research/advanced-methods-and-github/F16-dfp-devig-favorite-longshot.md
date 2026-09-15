# F16 — Favorite-longshot bias × devig choice × Gridiron's dog-shrinkage

## The question
Is Gridiron's dog/over pick bias (152/153 spread picks and 48/48 total picks were
dogs/overs; mean CLV −2.28, 78% adverse moves) a REAL signal the favorite-longshot-bias
(FLB) literature would predict, or an ARTIFACT of a biased devig/blend?

## Answer, precisely
**It is not a devig artifact. It is a point-margin blend artifact, and the FLB
literature — read carefully for the fixed-odds/bookmaker case that actually
applies to Gridiron — predicts the opposite direction from what Gridiron does.**

### 1. The call graph rules out devig as the cause
Traced end to end in the live repo (read-only, no edits, no DB access):

- `server/services/nfl-ensemble.js`: `marketMargin = g.home_spread == null ? null
  : -g.home_spread` — a raw POINTS number. The 0.68 + 0.632·market shrinkage lives
  entirely here, in point-margin space. No `noVig`/`shinNoVig`/`americanToProb` call
  appears anywhere in this file (grepped).
- `server/services/nfl-auto-picks.js:104-107`: `edge = projectedMargin -
  marketMargin; home = (edge ?? 0) > 0; selection = home ? game.home : game.away;`
  — the pick's SIDE is fixed here, from margins alone.
- Only on the next line (`nfl-auto-picks.js:114`) does devig (`noVigProbability` →
  `shinNoVig`, from `server/services/nfl-devig.js`) get called at all — and only to
  compute a *confidence/EV* number for a side that has already been chosen.
- `server/services/nfl-clv.js`'s `gradeClosingLineValue` also calls devig
  (`noVigProbability`, defaulting to Shin) only to convert the *closing* price into a
  fair probability for *scoring* a bet already taken — again strictly downstream of
  which side was picked.

So devig choice cannot be the mechanism that makes 152/153 picks dogs: that ratio is
set before any devig call executes. This is provable from the code alone, not an
assumption.

### 2. Shin's method (already implemented tonight, apparently by a sibling
   devig-focused fix) is well-targeted, but for the WRONG market type to explain this
Gridiron already has a real, literature-grounded devig implementation:
`server/services/nfl-devig.js` implements Shin's method (Shin 1992) with a bisection
solve for the insider-money fraction `z`, correctly falls back to proportional
splitting when there is no real overround, and is wired into `nfl-market.js`,
`nfl-clv.js`, `nfl-auto-picks.js`, `nfl-cover-calibration.js`, `nfl-props.js`,
`nfl-prop-clv.js`, `nfl-execution-attribution.js`, `nfl-replay.js`, and
`betting-hub.js`. `test/nfl-devig.test.js` confirms Shin pushes the FAVORITE's fair
probability UP relative to naive proportional splitting on a skewed line (e.g.
−900/+600) — i.e., Shin's correction, if it mattered here, would argue for MORE
favorites, not more dogs. That is the opposite sign from Gridiron's observed bias,
which is a second, independent reason the bias cannot be "explained away" as an
under-corrected devig.

Crucially, Ottaviani & Sørensen (2009) are explicit that Shin's information-based
explanation was built for and applies to **fixed-odds bookmaker markets** — which is
what Gridiner actually trades (NFL spreads/moneylines from books) — while their own
parimutuel model is a different mechanism for a different market structure (footnote
13: "In fixed-odds markets... an increase in the fraction of informed bettors
strengthens the FLB, because adverse selection is worsened," vs. the opposite
comparative static in parimutuel markets). So Shin, not the O&S parimutuel model, is
the right theoretical anchor for Gridiron — and the code's own comments already say
this correctly.

### 3. Whether FLB is even large in the specific market Gridiron trades is an open,
   testable, and probably favorable-to-Gridiron question
Every dataset I read in full documents FLB in markets with a WIDE odds range — horse
racing (favorite ≈ evens/2-1, longshots 100/1+; Snowberg & Wolfers 2010), soccer
match-odds and tennis moneylines (Hegarty & Whelan 2025). Gridiron's spread market is
a narrow-odds, roughly-symmetric HANDICAP market (mostly −105 to −130), structurally
closest to soccer's **Asian Handicap** — and Hegarty & Whelan (2025, cited within
their own overround paper) find the realized-vs-predicted-loss gap that drives FLB
*does not appear* in Asian Handicap betting, a market "popular with professional
bettors and syndicates." NFL point spreads share exactly that customer-base and
market-structure profile. This means the FLB/devig question, while real in general,
may be nearly moot for the specific surface (spreads) where Gridiron's dog-bias is
measured — reinforcing that hunting for an FLB explanation there is very unlikely to
pay off, and any real FLB-relevant mispricing in Gridiron's book is more likely to
show up in moneylines and rare-event props (anytime-TD, +400 to +1200 territory),
which the test file's own divergence example (−900/+600) confirms is where Shin vs.
proportional actually differ by more than a rounding error.

## Bottom line
The −2.28 CLV / 78%-adverse-move / dog-heavy pattern is a **mechanical attenuation
bug in the margin blend** (classic shrinkage-toward-anchor, β≈0.632<1), not a
mispriced-vig signal. Devig method choice is real, already reasonably well-handled
for two-sided markets, and matters most where NFL prices actually get skewed
(moneylines, rare-event props) — not on the spread surface where the bias was
measured.

---

## Primary sources read in full

1. **Snowberg, E. & Wolfers, J. (2010), "Explaining the Favorite–Long Shot Bias: Is
   it Risk-Love or Misperceptions?"**, *Journal of Political Economy* 118(4),
   723-746. Read pp.723-730 (title/abstract, intro, stylized facts with Figs. 1-2,
   the two stark models) directly from the NBER-hosted PDF
   (http://users.nber.org/~jwolfers/papers/Favorite_Longshot_Bias.pdf).
   Sample: **all 6,403,712 US horse-race starts 1992-2001** (Jockey Club data), plus
   a 1,485,112-start subsample with exacta/quinella/trifecta prices, plus new
   Australia (2.725M starts, 1991-2004) and UK (380K starts, 1994-2004) data.
   Key result: rate of return is ≈ −5.5% betting every favorite, ≈ −23% betting
   randomly, ≈ **−61% at 100/1+ odds**. Using compound-bet (exacta/quinella/trifecta)
   prices as a second, independent choice set to discriminate risk-love from
   misperceptions, they find the **misperceptions class (prospect-theory-style
   probability weighting) fits better** — bettors don't just accept worse odds for
   upside (risk-love), they appear to genuinely misjudge small probabilities.
   Limitation (their own framing): win-bet prices alone are observationally
   equivalent under either theory; the identification comes entirely from the
   exotic-bet extension, which is itself a modeling choice.

2. **Ottaviani, M. & Sørensen, P.N. (2009 draft; published as "Noise, Information,
   and the Favorite-Longshot Bias in Parimutuel Predictions," *AEJ: Microeconomics*
   2(1), 58-85, 2010).** Read pp.1-6 (abstract, intro, literature section) from
   https://web.econ.ku.dk/sorensen/papers/niaflb.pdf. This is a **theoretical**
   paper — no proprietary dataset of its own; it derives comparative-statics
   predictions and checks them against the existing empirical FLB literature.
   Key results: FLB emerges when informed bettors are numerous/precise relative to
   noise; a *reverse* FLB emerges in pure-noise settings (e.g. Lotto). Explicitly
   distinguishes their **parimutuel** mechanism from **Shin's (1991, 1992) fixed-odds
   bookmaker** mechanism (footnote 13: more informed bettors *strengthens* FLB in
   fixed-odds markets via worsened adverse selection, the *opposite* comparative
   static from parimutuel markets). This is the load-bearing citation for why Shin
   (already in `nfl-devig.js`), not an O&S-style parimutuel model, is the correct
   theoretical frame for Gridiron.

3. **Ottaviani, M. & Sørensen, P.N. (2005), "The Timing of Bets and the
   Favorite-Longshot Bias."** Read pp.1-4 (abstract, intro, stated contribution)
   from https://web.econ.ku.dk/sorensen/Papers/tobaflb.pdf. Also purely theoretical
   (no dataset): models early vs. late informed betting in parimutuel markets as a
   Cournot-style game, explaining three stylized facts (early betting, late informed
   betting, FLB) as one mechanism. Limitation: parimutuel-only; the paper itself says
   fixed-odds timing dynamics are different (footnote 4) and out of scope.

4. **Hegarty, T. & Whelan, K. (2025), "Estimating Expected Loss Rates in Betting
   Markets: Theory and Evidence,"** University College Dublin working paper (revised
   draft, April 2025). Read pp.1-6 and 10-16 (full derivation of the overround
   formula, the FLB-adjusted formula, empirical results, tables, figures) from
   https://www.karlwhelan.com/Papers/Overround.pdf. Sample: **soccer, N=151,683
   matches, 2005/06-2025/26 seasons; tennis, N=131,283 matches, 2010-2024**
   (Buchdahl's odds data, including 10 individual bookmakers for soccer, 5 for
   tennis). Key result: the "normalized probability" / overround formula
   *understates* true average loss rates once FLB is present — **soccer: 7.1%
   predicted vs. 8.7% realized (+20%); tennis: 5.4% predicted vs. 7.5% realized
   (+40%)** — because bookmakers set higher-margin, not equal-margin, prices on
   lower-probability outcomes, and this holds even at Pinnacle (a sharp book), though
   the gap is smaller there. Directly relevant limitation/finding for Gridiron:
   the paper notes (citing a companion Hegarty & Whelan 2025 result) that this
   pattern **does not hold for Asian Handicap betting** — a two-way, near-even
   point-spread-style soccer market structurally close to NFL spreads — attributing
   the difference to that market's professional/syndicate customer base. This paper
   is fixed-odds-market-native (unlike 1-3, which are horse-racing/parimutuel), which
   makes it the most directly transferable of the four to Gridiron's actual market
   structure.

### Secondary sources (cited within the above, not independently fetched/read)
- Shin, H.S. (1991, 1992), *The Economic Journal* 102(411), 426-435 — the original
  fixed-odds/insider-trading FLB model; already correctly cited and implemented
  (bisection solve for `z`) in `server/services/nfl-devig.js`.
- Jullien, B. & Salanié, B. (1994), "Measuring the Incidence of Insider Trading: A
  Comment on Shin," *Economic Journal*; and Jullien & Salanié (2000), "Estimating
  Preferences under Risk: The Case of Racetrack Bettors," *JPE* 108(3), 503-530
  (34,443 British races) — found cumulative prospect theory fits better than
  expected-utility/rank-dependent-utility models, which is convergent with, not
  contested against, Snowberg & Wolfers' later "misperceptions" conclusion.
- Štrumbelj, E. (2014), "On determining probability forecasts from betting odds,"
  *International Journal of Forecasting* 30(4), 934-943 — per its abstract/citing
  literature (I could not obtain readable full text tonight, so this is NOT counted
  among the "read in full" sources): compares multiplicative, Shin, and power
  devig methods across several sports/bookmakers and finds Shin-derived
  probabilities the most accurate forecasts overall.

## Repo grounding (read-only; no edits, no tests run, no DB touched)
- `server/services/nfl-devig.js` (121 lines) — Shin's method, added in a very recent
  commit (`c4a61ba`, "Tighten live-feed cadence, add Shin's-method de-vigging, and a
  live pick-watch board"), with `test/nfl-devig.test.js` covering the -900/+600
  divergence case and the antisymmetric/fallback edge cases.
- Consumers of `nfl-devig.js` (grep-confirmed): `nfl-market.js:253` (`noVigProb`),
  `nfl-auto-picks.js:15,227`, `nfl-clv.js:22,197-205` (keeps `proportionalNoVigProbability`
  "for comparison," confirmed unused elsewhere), `nfl-cover-calibration.js:5,13,288`,
  `nfl-props.js` (two-sided markets via a shared `noVig` import), `betting-hub.js:620,643`.
- Remaining un-devigged/raw-vig-inclusive "market probability" surfaces found by grep:
  - `server/services/staking.js:91-92,119` — `stakeFor`'s `marketProb` is
    `americanToProb(americanOdds)` on a SINGLE price, no opposite side, no devig of
    any kind (worse than the "one ad hoc method" FOUND description — it's zero
    methods). Consumed live by `server/routes/nfl-betting.js:949` (`GET /nfl/stake`),
    which the route's own comment calls "the RAW Kelly calculator... no validation
    gate at all... dangerous if read as advice."
  - `server/services/line-shopping.js:24,157` — `edge_vs_worst` uses a local raw
    `americanToProb`, no devig.
  - `server/services/nfl-props.js:658-665` — the anytime-TD market's `marketP` is
    `americanToProb(m.over)` (raw, one-sided) because the feed genuinely has no
    "No" price to pair against; every other (two-sided) props market on the same
    board correctly calls `noVig`.
- Confirmed the real, gated staking path is a DIFFERENT function:
  `server/services/nfl-execution-edge.js:623` `stakeFor({source})`, which zeroes any
  `'model'`-sourced stake until `provenClv` is supplied — this is the memory-file's
  documented guardrail and is NOT the one with the un-devigged probability bug.
