# F13 — Causal inference for news-to-decision impact (DML + event study)

## The gap, stated in Gridiron's own words

`server/services/nfl-news-market-latency.js:81` returns, as its literal `authority`
field: `'latency measurement only; a reaction is not proof the claim caused the
move'`. The same admission repeats verbatim in two other modules:
- `server/services/nfl-tweet-line-correlation.js:12` — "A line moving after a
  tweet is not proof the tweet caused it — books move for many reasons at once."
- `server/services/signal-latency.js:22` — "If they follow moves, we are
  downstream of the market and no amount of modelling will help" (echoed at
  line 186 in the live output string).

All three modules compute the same primitive: pair a verified fact (from
`nfl_news_signals` or `nfl_verified_events`) with the nearest sportsbook quote
before/after (`nfl_line_snapshots`) and threshold the delta
(`nfl-news-market-latency.js:49`: `reacted = |line_move|>=0.5 or |price_move|>=5`).
That is a **latency/co-occurrence test**, not a causal estimate. There is no
counterfactual ("what would this line have done absent the fact"), no
confounder adjustment (day-of-week, primetime, market liquidity, simultaneous
unrelated news, correlated moves across the whole slate), and no test of
whether the observed rate of "reacted" exceeds what a placebo/no-news period
would produce by chance. This is precisely the "packet-to-decision trace" Nick
named: a verified fact enters (`nfl_verified_events`), a number should come
out the other end (a signed point effect with a standard error, attributable
to *that* fact and not to everything else moving that day) — and it has never
existed.

Relevant tables (confirmed by reading schema):
- `nfl_verified_events` (`server/db/schema/nfl-a-to-m.js:337`): immutable,
  triggers block UPDATE/DELETE (`:698`, `:700`); `event_type`, `status_before`,
  `status_after`, `available_at`, `time_precision`, `source`.
- `nfl_news_signals` (`server/db/schema/nfl-n-to-z.js:57`): typed feed,
  `verification_state`, `confidence`, `published_at`.
- `nfl_line_snapshots` (`server/db/schema/core-and-fantasy.js:736`):
  `captured_at, event_id, book, market, side, line, price` — the sportsbook
  quote tape.
- `polymarket_quotes` (`server/db/schema/mlb-model-misc.js:562`) and
  `polymarket_price_history` (`:575`) — the 12.4M-row exchange tape Nick's
  memory flags as "essentially unused for anything beyond spread-ladder
  construction." Confirmed: `polymarket-lines.js` only builds the isotonic
  spread/total ladder (`server/services/polymarket-lines.js:1-55`); nothing
  reads it as an independent second asset reacting to the same treatment.
- Five CLV files independently confirmed present: `nfl-clv.js` (321 lines),
  `nfl-execution-clv.js` (354), `forward-ledger.js` (335, has its own CLV
  math), `nfl-quote-tape.js` (234), plus CLV logic embedded in
  `nfl-execution-edge.js` and `betting-hub.js`/`nfl-market.js` routes —
  consistent with Nick's "five independent, disagreeing CLV implementations
  over four different tables" finding.

## Primary sources read in full

### 1. Chernozhukov, Chetverikov, Demirer, Duflo, Hansen, Newey, Robins (2018/2016), "Double/Debiased Machine Learning for Treatment and Structural Parameters," *The Econometrics Journal* 21(1):C1–C68 (arXiv:1608.00060)

Read the full setup (partially linear model, cross-fitting algorithm, orthogonal
score, simulation) directly from the arXiv PDF.

- **Model**: partially linear regression `Y = D·θ0 + g0(X) + U`,
  `D = m0(X) + V`, with `θ0` the causal parameter of interest, `X` confounders,
  `g0`/`m0` unknown nuisance functions.
- **Method**: (1) fit `ĝ0(X)` and `m̂0(X)` on an auxiliary fold with any ML
  method (lasso, random forest, boosting, neural nets); (2) form the
  orthogonalized regressor `V̂ = D − m̂0(X)`; (3) estimate
  `θ̂0 = (1/n Σ V̂ᵢDᵢ)⁻¹ (1/n Σ V̂ᵢ(Yᵢ − ĝ0(Xᵢ)))` on the held-out main fold;
  (4) **cross-fit**: swap the folds and average, so every observation is
  scored out-of-sample.
- **Why it matters over a naive residual regression**: the paper's own
  numerical experiment (n=500, p=20, `g0` a smooth function of a handful of
  variables, `ĝ0` a random forest) shows the naive plug-in estimator
  `θ̂0 − θ0` badly biased and non-normal (histogram shifted well right of the
  N(0,Σ) reference), while the orthogonalized/cross-fit estimator concentrates
  on zero and matches the normal approximation (Figure 1, both panels,
  literally the same underlying data). The mechanism: any ML nuisance
  estimator has `O(n^{-1/4})`-or-slower bias; a naive score's sensitivity to
  that bias is first-order, an orthogonal score's is second-order (product of
  two `n^{-1/4}` errors → `n^{-1/2}`, i.e. it washes out at the parametric
  rate). This is the exact justification for using DML rather than "regress
  the line move on the news dummy plus some controls."
- **Real-data application in the paper**: 401(k) eligibility → net financial
  assets, ~9,915 households, point estimate ≈ $9,000 effect of 401(k)
  eligibility with SE ≈ $2,000 — the canonical illustration of recovering a
  believable, standard-error-bearing causal number from an observational
  panel with many controls, which is the same shape of problem as "does this
  verified Out designation move the spread, controlling for everything else
  that could be moving it that day."
- **Rate condition**: nuisance estimators need to converge faster than
  `n^{-1/4}` in mean-square — a condition random forests/lasso/boosting
  satisfy on the sample sizes Gridiron actually has (thousands of verified
  events, tens of thousands of quote-pairs), so this is implementable, not
  aspirational.

### 2. Lopez & Bliss (2024), "Bye-Bye, Bye Advantage: Estimating the competitive impact of rest differential in the National Football League," *Frontiers in Sports and Active Living* (arXiv:2408.10867)

Read in full (10 pages + appendix pointer). Chosen because it is the closest
real precedent for "estimate a causal NFL effect on **both** game outcomes and
**betting market prices**, with a defensible identification strategy," using
authors at the NFL itself.

- **Data**: 5,679 regular-season games, 2002–2023 (256/season through 2020,
  271–272 in realignment years), point differential + closing point spread
  (via nflreadR/aggregated sportsbook lines).
- **Identification strategy**: not DML — a **natural experiment** (the 2011
  CBA eliminated bye-week practice time) exploited via a structural break in a
  Bayesian state-space model of team strength
  (`θ_{s,i} ~ N(γθ_{s-1,i}, σ²)`, Glickman–Stern-style), with rest-differential
  dummies (`Bye`, `Mini`, `MNF`) entered additively, estimated separately
  pre/post-2011 (their Models 1–4).
- **Headline numbers** (both read directly off the results section):
  - Point differential: bye advantage +2.21 pts/game pre-2011 (95% CrI
    0.61–3.80, P(effect>0)=99.6%) → +0.31 pts/game post-2011 (CrI −1.01 to
    1.64, not significant). `Pr(post<pre)=96.6%` — a documented **decline**.
  - Point **spread** (the betting-market outcome, their Model 4): bye
    valuation **rose** from +0.39 pts pre-2011 (CrI 0.00–0.78) to +0.97 pts
    post-2011 (CrI 0.65–1.28) — `Pr(post>pre)=98.8%`. I.e., the market's
    priced-in value of the effect moved the *opposite direction* from the
    true competitive effect, and stayed elevated for over a decade.
  - Model-comparison via LOO-ELPD used to check whether the pre/post split is
    warranted at all (not just eyeballing point estimates): Model 2 beats
    Model 1 by 0.14 SE (weak), Model 4 beats Model 3 by 1.27 SE (moderate).
- **Why this is the right analog, not just a nice paper**: it is proof, on
  Gridiron's own sport and using betting-market data as one of the two
  outcomes, that (a) a *known, dated, verifiable* structural fact (the CBA
  change) can be given a real point estimate + credible interval on a market
  price, and (b) the market's belief and the ground truth can be shown to
  **diverge for years** without an explicit causal design ever catching it —
  which is exactly Gridiron's situation with the ensemble's shrink-to-market
  blend (if the market is slow or wrong about a specific verified fact, the
  ensemble's 0.632-weight on market absorbs and re-encodes that same error).
- **Limitation the authors state themselves**: they deliberately use
  *categorical* rest bins, not continuous days-of-rest, because they argue
  practice/recovery time doesn't scale linearly with rest days — a modeling
  choice, not a proof; it is also a single-country natural experiment (one
  CBA change), so the design cannot be reused for a different treatment
  without a different natural break.

### 3. Angelini & De Angelis (2026), "When Do Markets Fully Process Public Information? Evidence from Real-Time Prediction Markets," arXiv:2606.07811 (June 2026, econ.EM)

Read in full (abstract + intro + institutional-setting sections, methodology
and results summarized from the same fetch). This is the most directly
transferable design: **Kalshi NBA event contracts**, i.e. the same
prediction-market instrument type as Gridiron's own Polymarket tape, studied
with one-minute quote data merged to timestamped play-by-play.

- **Data**: one-minute Kalshi NBA winner-contract quotes (best bid/ask,
  volume, open interest) merged with second-by-second NBA play-by-play —
  every score, turnover, foul, timeout is a timestamped public signal.
- **Method**: build an **out-of-sample benchmark win probability** from
  pre-game price + live game state (score, clock, possession), then compare
  *changes* in that benchmark to *changes* in the actual traded price over
  the same minute — a market-model-style "what should have happened to the
  price given only public information" versus "what did happen," which is
  literally the abnormal-return logic of an event study applied at one-minute
  granularity, continuously, rather than around one discrete announcement.
- **Headline result**: a one-minute change in the benchmark probability is
  associated with only a **0.64-for-one** contemporaneous change in the
  traded price (i.e., ~36% underreaction on impact); the "missing" 36%
  predicts further price drift over the following several minutes, even net
  of subsequent benchmark changes — direct evidence of gradual, not
  instantaneous, incorporation of a public fact into a price.
- **Mechanism they isolate**: underreaction is not uniform — salient
  signals (three-pointers, lead changes, scoring runs) are absorbed almost
  fully in *liquid* markets but leave large, and larger, underreaction gaps
  in *thin* markets; those gaps predict subsequent drift, i.e. **liquidity
  conditions at the moment of the fact, not just the fact's importance,
  determine how much of the causal effect shows up immediately versus over
  the following minutes.**
- **Stated limitation**: the predictable drift, while statistically real, is
  smaller than the bid-ask spread once trading costs are imposed — "not a
  simple arbitrage opportunity" — the authors are explicit that market
  inefficiency detected by the design does not automatically imply an
  exploitable edge, a caveat Gridiron should inherit rather than skip.
- **Direct transfer to Gridiron**: this is the template for using
  `polymarket_quotes` (Gridiron's own one-minute-ish exchange tape) alongside
  `nfl_verified_events`/`nfl_line_snapshots` to ask the *completeness*
  question ("how much of the eventual move happened in the first N minutes,
  and does the shortfall predict further drift") rather than the *latency*
  question ("did it move at all") Gridiron currently asks.

### 4. MacKinlay (1997), "Event Studies in Economics and Finance," *Journal of Economic Literature* 35:13–39 — read via Ødegaard's graduate lecture notes (Bernt Arne Ødegaard, "Empirical Methods in Corporate Finance: Event Studies," full PDF, which is an explicit worked distillation of the MacKinlay survey, including a dedicated closing section "The MacKinlay Survey")

Read the full methodology sections directly.

- **Two-window design**: an *estimation window* (historical baseline, no
  event contamination) used to fit a "normal return" model, and a separate
  *event window* around the fact, where the deviation from that model's
  prediction is attributed to the event.
- **Market-model baseline**: `E[R_it] = α_i + β_i·R_mt + ε_it` — the expected
  outcome for asset *i* is modeled as a function of the *market's* concurrent
  move, not a flat baseline. This is the load-bearing idea Gridiron's current
  `nfl-news-market-latency.js` is missing entirely: it thresholds the raw
  line move (`|line_move|>=0.5`) with **no market-wide baseline subtracted**,
  so a leaguewide vig/limit adjustment on a Sunday morning would register as
  a "reaction" to an unrelated Tuesday practice-report claim about a
  different team, and a genuine reaction on a day when the whole board is
  moving (Polymarket-implied macro shift, weather system, a Thursday slate)
  would be underweighted or missed by the flat threshold.
- **Abnormal / cumulative abnormal return**: `AR_it = R_it − E[R_it]`,
  `CAR_i = Σ_t AR_it` over the event window — the object that should replace
  Gridiron's raw `line_move`/`price_move` fields.
- **Cross-sectional aggregation test**: `t = mean(CAR) / (sd(CAR)/√N)` across
  N events — but the notes (and the survey they distill) flag exactly the
  failure mode Gridiron would hit immediately: **event clustering**. Multiple
  verified injury designations land on the same day (Wednesday/Thursday/
  Friday practice-report cadence) across many different games; if their
  abnormal moves are cross-sectionally correlated (a leaguewide liquidity
  event, a weather system, a Sunday slate-wide vig shift), the naive
  cross-sectional t-test over-rejects — it will report "verified events cause
  reactions" far more often than is real. This is not a hypothetical: it is
  the modern literature's answer to MacKinlay's original test (Kolari &
  Pynnönen 2010, *Review of Financial Studies* — a formal cross-correlation
  correction to the same t-statistic; found via search, abstract/summary read
  but the paywalled RFS/SSRN full text was not accessible tonight, so it is
  cited as a pointer for the eventual exit-test design, not counted as one of
  the four full reads).
- **Other pitfalls documented**: confounding events (two claims about the
  same team the same week), event-induced variance changes (a line becomes
  noisier, not just displaced, right after a claim — mis-modeled as pure
  mean-shift), non-normality of the abnormal-move distribution at these
  sample sizes.

## Candidates

### FIX — grounded in tonight's exact defects

**F1 — Replace the raw-threshold "reacted" boolean with a market-model
abnormal move (event-study CAR), in `nfl-news-market-latency.js` and the
event-anchored variant `verifiedEventMarketLatency`.**
- `fixes_finding`: the literal disclaimer at `nfl-news-market-latency.js:81`
  (`'latency measurement only; a reaction is not proof the claim caused the
  move'`) and the flat, no-baseline threshold at `:49`
  (`reacted = |line_move|>=0.5 or |price_move|>=5`).
- `mechanism`: for every claim/event, build the MacKinlay market-model
  baseline from the *other* games captured in the same window (median/robust
  move of spreads on games not involving either team in the claim) and
  compute `abnormal_move = observed_move − market_baseline_move`. Replace the
  boolean threshold with `abnormal_move` plus its own noise-floor SD estimated
  from a placebo period (see N1), so "reacted" becomes a signed point estimate
  with a magnitude, not a coin flip.
- `evidence_strength`: strong — this is textbook MacKinlay methodology
  (Source 4), directly implementable on tables that already exist
  (`nfl_line_snapshots` already carries every book/market/side per capture,
  so the "control basket" of same-window games is already in the query
  Gridiron runs today at `nfl-news-market-latency.js:59-63`).
- `applies_to`: audit-method (this is a measurement-methodology fix, not a
  new bet or forecast).
- `how_in_gridiron`: add a `marketBaseline(snapshots, captureWindow, excludeTeams)`
  helper beside `quoteReaction` in `nfl-news-market-latency.js`; subtract it
  before computing `line_move`/`price_move`; keep the existing
  `research_eligible` gate but change its threshold from raw counts to
  "N abnormal-move estimates with SE below X."
- `cost`: days (1-2 days: the query surface already exists, this is a new
  aggregation function plus a schema-free derived field, no migration).
- `expected_value`: turns three modules' currently-honest-but-useless output
  ("it reacted" / "it didn't") into a number with a sign and a size that can
  actually feed a forecast or a staking decision — without this, "verified
  news market latency" cannot ever graduate past the disclaimer it already
  carries.
- `exit_test`: on a held-out slate of games with *no* verified event for a
  given team, the abnormal-move estimator should show a false-positive
  "reacted" rate statistically indistinguishable from the placebo rate in
  N1 (fails today: the flat threshold has no such property, and nobody has
  ever measured its false-positive rate).

**F2 — DML-adjusted point estimate for the causal effect of a verified
Out/Doubtful/IR designation on the closing spread, controlling for
confounders, feeding directly into `nfl-ensemble.js`'s market-blend
diagnosis.**
- `fixes_finding`: the ensemble's blend `forecast ≈ 0.68 + 0.632·market` is
  "a naive shrinkage toward the closing line, not real forecast combination,"
  with 20 components collapsing to ~3 independent signals
  (`server/services/nfl-ensemble.js`) and mean CLV of −2.28 pts. Part of why
  the ensemble's private signal (which includes the verified-news features
  computed in `nfl-online-neural.js:149-154`, `home_verified_news_burden` /
  `coverage`) adds nothing once blended toward market is that nobody has
  measured whether those news features have *any* residual causal
  relationship to the closing line once the market's own already-priced
  reaction to the same news is accounted for — i.e., the ensemble may be
  double-counting a signal the market has already absorbed, which is exactly
  the shrinkage-toward-market failure mode described.
- `mechanism`: fit the DML partially-linear model from Source 1 —
  `Y` = closing-spread move after `available_at`, `D` = verified-event
  treatment (Out/Doubtful/IR indicator, or its `unavailable_probability`),
  `X` = day-of-week, time-to-kickoff at `available_at`, primetime flag,
  pre-existing `nfl-team-strength.js` gap, market liquidity/volume from
  `polymarket_quotes`. Cross-fit `g0`/`m0` with gradient boosting (small n,
  so a simple boosted-tree or even regularized-lasso nuisance model is
  appropriate — Chernozhukov et al.'s rate condition is easily met at
  Gridiron's sample sizes). Output: `θ̂` (points per unit of `D`) with a
  standard error.
- `evidence_strength`: strong on method (Source 1's simulation directly shows
  naive vs. orthogonal estimator bias on the identical data-generating
  process class); moderate on Gridiron's specific application, since sample
  size for verified QB-level events specifically will be modest this season
  (needs 100+ per position tier before CIs are usable, mirroring the
  `research_eligible: examples.length >= 100` gate already in the codebase).
- `applies_to`: betting-model.
- `how_in_gridiron`: new module `server/services/nfl-news-causal-effect.js`,
  reading `nfl_verified_events` + `nfl_line_snapshots` + `nfl-team-strength.js`
  outputs; output feeds as a diagnostic input to `nfl-ensemble.js`'s
  component-reliability audit (the file already has a
  `candidate_shrink_only` mode at `nfl-ensemble.js:1311` for testing whether a
  component should be down-weighted — this DML estimate is exactly the kind
  of external check that mode was built to consume).
- `cost`: days (3-5 days: cross-fitting implementation, nuisance model choice,
  and enough verified events accumulated to get a stable estimate for at
  least the QB-Out tier).
- `expected_value`: if `θ̂` is near zero and tightly estimated, that is direct
  evidence the ensemble's news features are redundant with the market
  component (explains *why* the blend collapses to shrinkage, a real
  diagnosis rather than another instance of it); if `θ̂` is meaningfully
  nonzero and the market's realized move under-shoots it, that is a concrete,
  sized, defensible edge — the first one this model would have that survives
  the -2.28 CLV / 78% adverse-move history, because it targets a moment
  (verified fact release) rather than the closing line as a whole.
- `exit_test`: does `θ̂`'s sign and rough magnitude replicate on a second,
  independent slice of the season (e.g., first half vs. second half of
  verified events) — if it doesn't hold up out-of-sample, it is noise
  dressed as causal inference, and the candidate should be shelved, not
  wired into staking.

**F3 — Use the causal event-anchored move (from F1/F2) as the single
reference definition to reconcile the five disagreeing CLV implementations.**
- `fixes_finding`: "Five independent, disagreeing CLV implementations exist
  over four different tables with different math and sign conventions" —
  confirmed present tonight: `nfl-clv.js` (321 lines), `nfl-execution-clv.js`
  (354), `forward-ledger.js` (335, own CLV math), `nfl-quote-tape.js` (234),
  plus embedded CLV logic in `nfl-execution-edge.js` and the
  `betting-hub.js`/`nfl-market.js` routes.
- `mechanism`: not a rewrite of all five tonight — a *design* fix. Define one
  canonical convention: CLV attributable to a specific verified fact =
  `abnormal_move` (from F1) between the fact's `available_at` and the
  earliest capture where the abnormal move returns to the placebo noise floor
  (from N1), signed consistently (positive = line moved in the direction the
  fact implied, favoring the side taken). Publish this as the reference
  definition in a short spec doc, and add one integration test that computes
  it once and asserts each of the five existing implementations, converted to
  the same convention on a shared fixture, lands within a documented
  tolerance of it — surfacing the actual disagreements as failing assertions
  rather than as five silently different numbers.
- `evidence_strength`: moderate (the causal-move definition itself is strong;
  whether all five modules can be reconciled to it without behavior changes
  Nick doesn't want is unverified — this is a scoping/spec task, not a proof).
- `applies_to`: infrastructure.
- `how_in_gridiron`: new fixture-based test,
  e.g. `test/clv-convention-reconciliation.test.js`, plus a short doc
  (`docs/reference/clv-convention.md`) naming the canonical formula and which
  of the five files diverges how.
- `cost`: hours for the spec + fixture test skeleton; days if reconciling the
  five implementations to actually agree (separate follow-up).
- `expected_value`: stops the situation where "what was our edge on this bet"
  has five different, silently disagreeing answers depending which file
  answers it — a precondition for trusting *any* of the numbers this research
  agent's F1/F2 candidates would produce.
- `exit_test`: run the fixture test; count how many of the five
  implementations pass within tolerance today (expected: most fail, which is
  the point — the test's job is to make the five-way disagreement visible and
  countable, not to silently average over it).

### NEW — capability Gridiron has none of today

**N1 — Placebo/permutation null distribution for "did the market react,"
replacing the fixed 0.5pt/5c threshold with an empirically-calibrated
false-positive rate.**
- `fixes_finding`: none — new capability.
- `mechanism`: pick quiet windows with no verified event for a given team
  (e.g., bye weeks, or randomly-shifted fake `available_at` timestamps
  attached to real teams/games — a standard event-study placebo/permutation
  design, the modern answer to the clustering problem MacKinlay's survey
  flags and Kolari & Pynnönen formalize) and run the exact same
  `quoteReaction`/abnormal-move pipeline against them. The resulting
  distribution of "reacted" rates and abnormal-move sizes *under no real
  news* is the honest null — compare the real verified-event rate against it
  with a permutation p-value instead of eyeballing a fixed threshold.
- `evidence_strength`: strong (this is the direct, well-established fix for
  exactly the over-rejection failure mode Source 4 documents for naive
  cross-sectional event-study tests); moderate on Gridiron's specific
  implementation effort since it requires careful selection of placebo
  windows that are truly free of confounding news (a nontrivial data-quality
  task given the `nfl_news_signals` quarantine states already show fake/
  unverified news is common).
- `applies_to`: audit-method.
- `how_in_gridiron`: new module `server/services/nfl-news-causal-placebo.js`,
  built directly on `nfl-news-market-latency.js`'s existing `quoteReaction`
  export (`server/services/nfl-news-market-latency.js:29`, already exported
  via `__test`) — reuse it, don't reimplement it, just feed it placebo
  claims instead of real ones.
- `cost`: days (2-3 days for a first pass on QB-Out-caliber events, where
  placebo-window selection is easiest because bye weeks are a clean natural
  placebo).
- `expected_value`: converts "reacted: true/false" from an arbitrary
  guess into a calibrated statistical claim — the single missing ingredient
  for every other causal candidate in this research (F1, F2, F3 all cite or
  depend on the noise floor N1 produces).
- `exit_test`: the estimated false-positive rate on placebo windows should be
  close to the nominal significance level chosen (e.g., 5-10%); if it is
  wildly higher, the abnormal-move/CAR construction in F1 needs more
  aggressive market-baseline control before it's trustworthy for anything
  downstream.

**N2 — Heterogeneous treatment effects (causal forest / DML-based CATE) for
how a verified-event effect varies by position, injury type, and team
scheme-dependency.**
- `fixes_finding`: none — new capability (team-strength updates today are a
  single hand-tuned scalar blend in `nfl-team-strength.js`, not any kind of
  causal or state-space model, per tonight's finding on that file; this
  candidate is a genuinely new estimator type, not a repair of that blend).
- `mechanism`: once F2's baseline DML estimator exists, swap the final-stage
  linear model for an honest causal forest (Wager & Athey; the residualize-
  then-forest three-step named in the search results above, itself built on
  Chernozhukov et al.'s orthogonalization) to get a conditional average
  treatment effect surface: does a WR2 "Out" designation move the total more
  for a pass-heavy offense than a run-heavy one; does a starting-LT "Out"
  move the QB-sack-prop market more than the spread. This is a genuinely new
  question type Gridiron cannot currently ask about any signal.
- `evidence_strength`: moderate — the causal-forest extension is a natural
  next step from Source 1's framework but was not itself read in one of the
  four full-read primary sources tonight (flagged honestly, not counted as
  "strong" on that basis); it also needs materially more verified events per
  stratum than F2's aggregate estimate, so early strata (e.g., "backup TE
  scratches") will simply be too sparse to estimate this season.
- `applies_to`: props (the position/injury-type heterogeneity is most useful
  precisely where Gridiron's memory says it already has "genuine measured
  skill" — 2+ TD Brier skill +27% — so a verified-injury CATE on a teammate's
  prop distribution is the highest-leverage place to point this).
- `how_in_gridiron`: extends N2's DML module with a causal-forest final stage;
  reads player-prop projections already computed for the props module (not
  yet located by file name in this pass — flag for the props research agent
  to confirm the exact prop-projection module this should attach to).
- `cost`: weeks (needs F2 built and validated first, plus enough verified
  events accumulated across the season to stratify).
- `expected_value`: could be Gridiron's first real example of a causal,
  stratified, standard-error-bearing "this specific fact is worth this many
  points to this specific market," rather than a single average effect —
  but only pays off once sample size accumulates; not a this-week deliverable.
- `exit_test`: does not proceed past F2 until F2's exit test (out-of-season-
  half replication) passes; premature stratification on a noisy average
  effect just multiplies the noise.

**N3 — Cross-market triangulation: use the 12.4M-row Polymarket quote tape and
the sportsbook line-snapshot tape as two independent assets reacting to the
same verified-event treatment, to (a) validate the causal estimate by
agreement across markets and (b) measure which market discovers a given class
of news first.**
- `fixes_finding`: none — new capability, but directly answers "a
  12.4-million-row Polymarket quote tape exists and is essentially unused for
  anything beyond spread-ladder construction" (confirmed: `polymarket-lines.js`
  only builds the isotonic ladder, `server/services/polymarket-lines.js:1-55`,
  nothing else in the codebase reads `polymarket_quotes` as an independent
  reaction series).
- `mechanism`: run the same abnormal-move (F1) and DML (F2) pipeline twice —
  once against `nfl_line_snapshots` (sportsbook), once against
  `polymarket_quotes`/`polymarket_price_history` (exchange) — for the same
  verified-event treatments. Two uses: (1) triangulation — if both markets
  show a same-signed, similar-magnitude abnormal move for the same fact, that
  is much stronger evidence of a real causal effect than either alone
  (addresses the "a reaction is not proof of causation" problem structurally,
  the way a second, independent asset class serves as an out-of-sample check
  in Source 3's design); (2) lead-lag — whose price moves first, by how many
  minutes, replacing eyeballed latency with the same kind of one-minute
  benchmark-vs-actual completeness measure Source 3 builds for Kalshi/NBA.
- `evidence_strength`: moderate — the Polymarket NFL markets are much thinner
  than Kalshi's NBA markets in Source 3's study, so the "thin-market
  underreaction" mechanism that paper documents should be expected to bind
  even harder here, which is itself a useful, checkable prediction of the
  design (not just an assumption).
- `applies_to`: simulation (cross-market validation) and audit-method.
- `how_in_gridiron`: new module, e.g.
  `server/services/nfl-cross-market-causal.js`, parameterizing F1's
  `quoteReaction`-style pairing over either table; a first pass can just
  compute both abnormal moves and report agreement/disagreement without
  building full DML for both, as a cheap triangulation check before investing
  in N2-level heterogeneity work.
- `cost`: days (3-4 days for the triangulation pass alone, since both quote
  tapes and the event table already exist and F1's pairing logic is reusable
  almost as-is).
- `expected_value`: turns Gridiron's largest and most neglected single table
  (12.4M rows) into the independent second measurement that makes every other
  causal claim in this research more credible, for a cost lower than any of
  F2/N2 individually.
- `exit_test`: on a sample of verified QB-Out events, do the sportsbook and
  Polymarket abnormal-move estimates agree in sign at a rate clearly above
  chance? If they routinely disagree in sign, that is evidence the abnormal-
  move construction (F1) still has a confounding problem that needs fixing
  before any of it is trusted for staking.

## Do not do

- Do not wire any of F1/F2/N1/N2/N3's output directly into staking or bet
  sizing this week. Every candidate here produces a *diagnostic estimate*;
  none has been validated out-of-sample yet, and the existing model's history
  (-2.28 CLV, 78% adverse moves) is exactly the track record that should make
  Nick require a clean out-of-sample replication (F2's exit test, at minimum)
  before any causal estimate touches a real dollar.
- Do not build the causal-forest/CATE layer (N2) before F2's flat-average DML
  estimate is validated — stratifying a noisy or non-replicating average
  effect produces confident-looking numbers on strata too small to mean
  anything, which is a worse failure mode than the current honest "we don't
  know" disclaimers.
- Do not treat a single significant abnormal-move estimate (from F1, before
  N1's placebo calibration exists) as evidence of a real reaction — this is
  the same over-rejection risk MacKinlay's survey and the modern
  cross-sectional-correlation literature (Kolari & Pynnönen) explicitly warn
  about for exactly this kind of clustered-event data (multiple injury
  designations landing the same practice-report day across many games).
- Do not rewrite all five existing CLV implementations (F3) as a single
  refactor tonight — reconcile the *definition* first (a spec + failing
  fixture test), and let each file's owner-context decide whether/how to
  converge; a blind mass-refactor risks breaking whichever of the five is
  currently load-bearing for a live capture during Week 1.
- Do not present any DML or event-study point estimate without its standard
  error / credible interval — Source 1's entire contribution is that a point
  estimate without a valid inference procedure is actively misleading (worse
  than no estimate), and Source 2's own headline number is a credible
  interval, never a bare point.
- Do not assume Polymarket NFL liquidity is comparable to the Kalshi NBA
  liquidity in Source 3 — that paper's central finding is that thin markets
  underreact more; treat any early Polymarket-vs-sportsbook disagreement (N3)
  as the expected liquidity effect first, before treating it as evidence
  against the causal design itself.
