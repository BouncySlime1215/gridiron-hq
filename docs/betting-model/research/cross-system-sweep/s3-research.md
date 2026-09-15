# s3-research — betting-relevant findings the plan is missing

Sweep of `/scratchpad/research2/` (all 56 agent notes + 12 scoring chunks + the catalog +
FIX_AND_ADD_ARCHITECTURE.md), cross-checked read-only against
`/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` and against
`server/data.sqlite` via a `node:sqlite` `readOnly:true` one-liner. No edits, no tests, no
processes touched, no network.

## The one-line answer to Nick

WHAT_NEXT.md contains **zero market-structure content**. Grepping it for
`news|latency|steam|limit|polymarket|kalshi|exchange|event study|abnormal|liquid|depth|
origin|timing|opener|opening` returns three incidental hits, none of them an item. The
category Nick's own instruction says to bias toward — and the category where this project's
only documented positive expectation lives — is the one the plan does not cover at all.
Meanwhile the codebase already contains four built, tested, market-structure engines
(`nfl-sharp.js`, `sharp-lag.js`, `signal-latency.js`, `beat-the-close.js`) that the plan
never names once.

---

## Q1 — scored candidates that never made either final list

### N05 (prediction-market mining) was read and scored, then dropped entirely

`FIX_AND_ADD_ARCHITECTURE.md:106` lists N05/GN05 in the reading table with **3 candidates**.
Grepping the FIX list (c), the ADD list (d) and the rejected list (e) for
`lead.lag|isotonic|signal-latency|MOVE_UNION|liquidity-weight` returns nothing. All three
N05 candidates vanished in synthesis — not rejected, just lost. Two of them are
market-structure items:

- **Exchange-vs-book lead/lag test.** Today `server/services/signal-latency.js:57-64`
  defines `MOVE_UNION` as `espn_line_moves UNION ALL polymarket_line_moves` and asks only
  "did OUR signals lead this pooled log?" It never asks whether one market leads the other.
- **Liquidity-weighted spread-ladder crossing.** `polymarket-lines.js`'s `isotonic()` /
  `crossing()` weight every ladder rung equally; `bid_size`, `ask_size` and `spread` are
  captured by `captureOrderBooks()` and discarded.

### The other "scored but dropped" items worth re-reading now

The consolidation objection ("five disagreeing CLV calculators") is gone, so these change
status:

- **F13-N1, the placebo/permutation null for "did the market react."** FIX #29's own exit
  test says the false-positive rate "should be statistically indistinguishable from the
  placebo rate" and the prose says "build alongside item #35" — but #35 is
  sorted-neighborhood blocking. The placebo null has no line item anywhere. F13's own
  do-not-do list says F1 cannot be trusted without it.
- **FIX #20 / #21 (team-leg × player-prop copula; nested spread ⊂ moneyline independence).**
  Both scored 11.7/11.0 with 3/3 votes and are in the FIX list, but neither survived into
  WHAT_NEXT.md. #21 is a *provable* error, not an approximation.
- **FIX #17 and #29 (DML causal news effect, score 13.0; event-study abnormal move, score
  15.0 — tied for the highest score in the audit bucket).** Neither is in WHAT_NEXT.md.
  Nick explicitly asked about "the news."

---

## Q2 — market structure, timing, limits, line origination, steam

### What the research actually found (and the plan does not carry)

| Source | Finding | Bears on |
|---|---|---|
| Ramesh et al. 2019 (arXiv:1910.08858), N14 S4 | Cross-book **price dispersion** across 16 books produces bootstrap-significant, Bonferroni-corrected positive ROI in all 5 sports, with **no forecasting skill required**. Random spread betting = −4.4%. | The shopping board's whole premise; nothing in the plan measures it historically. |
| Simon 2024, *Management Science* 70(12), N14 S6 | 3,681 MLB games: line changes are **significantly negatively autocorrelated** (overreact, then revert); forecasts do **not** improve monotonically toward kickoff. Peer-reviewed grounding for middling. | Middles; the timing of when to take a number. |
| Marshall 2009, *QREF* 49(3), N14 S5 | Median sports-arb persistence **~15 minutes**; most corrected within the hour. | Capture cadence is the binding constraint on whether any of this is observable. |
| Dubach 2026 (arXiv:2604.24366), N05 §1.1 | Polymarket quoted half-spread ≈400bps at mid 0.4–0.6, **1,300–1,800bps below 0.10**. Depth concentration is near-uniform, not top-heavy. Trade direction from the public feed is only ~59% accurate — microstructure measures built on it flip sign 43–67% of the time. | Any use of a Polymarket mid as a "vig-free" price, especially for props, which live in the tail. |
| Bürgi/Deng/Whelan 2026 (UCD), N14 S3 | Kalshi sub-10¢ contracts lose **>60% of stake**; overall average return ≈ **−20%**; the **taker** side (what any detector does) is systematically worse. | ADD #17 covers the haircut. Also a general warning about the dog side. |
| Cheng/Yang/Zou 2026 (UCLA, arXiv:2605.00864), N14 S2 | Whole NBA month: **$210** single-market arb, **$560** combinatorial, 76.9% capped at ~15 shares. | Correctly settled: cross-venue arb is not a revenue plan. Do not revisit. |

### Code-side market-structure facts I verified myself

**`server/services/nfl-sharp.js`** — the project's own comment calls sharp-vs-rec divergence
"the only group that reliably beats the closing line." It exports `steamMoves()` (line 214)
and `sharpScorecard()` (line 282). `sharpScorecard()` requires ≥10 graded bets with
`source IN ('sharp_divergence','steam')`; **`nfl_bet_log` has zero rows for any source**, so
the scorecard has never once been readable and steam has never been validated against CLV.
`sharpBoard()` still routes through the paid Odds API (`hasKey`/`gameOdds`), which is out of
credits; `steamMoves()` reads `nfl_line_snapshots` and is unaffected.

**`server/services/sharp-lag.js`** — a genuinely good, already-tested engine: Pinnacle move →
soft-book follow latency → opportunity window → CLV graded against Pinnacle's last pre-kickoff
line, restricted to `provider LIKE 'free:%'` so every book shares a `captured_at`. Its
docstring says latency is "quantised to the poll interval (hourly): '60 minutes' means 'by the
next poll'." **Measured from the tape, the free-feed cadence is a 6.0-minute median**
(p10 5.4, p90 18.6, n=1,195 Pinnacle captures). The documentation and the default parameters
were written for a tape ten times coarser than the one that now exists. That matters because
Marshall's 15-minute median persistence is invisible at 60 minutes and observable at 6.

Sobering counterweight, measured directly: across the entire free tape there are only
**26 Pinnacle spread moves of ≥0.5 points** (12 of ≥1.0, mean |move| 0.885). The half-point
tick is the floor, so `minMove` cannot be lowered. The binding constraint on this engine is
sample accumulation and breadth (it defaults to spreads; totals and h2h are parameterized but
unused), not resolution.

**`server/services/signal-latency.js`** — this module states the project's whole thesis in its
own header: *"Edge in that world is not 'we predict better', it is 'we knew at 14:02 and the
number did not move until 14:40'."* It also says it is "deliberately built on the FREE ESPN
reference line." Measured: `espn_line_moves` = **81 rows**; `polymarket_line_moves` = **4,961
rows**. The union it studies is **98% Polymarket**. The module is measuring something other
than what it says it measures, at a 61:1 ratio.

**`server/services/beat-the-close.js`** — the live, zero-stake forward test of the one +CLV
signal (nfelo/ratings vs Pinnacle opener: +0.58 CLV, 57.7% direction, 570 held-out games). It
is running: `nfl_signal_snapshots` = 38,055 rows across 9 signals since 2026-09-02, and
`shadow_decisions` holds 61 `beat-the-close-v1.1:*` rows (5 signals, all `decision='observe'`,
6 settled). Its retirement rule — "two consecutive weeks with a signal's live CLV interval
below zero retire its rule; that judgement lives in the weekly read" — has `weeklyRead()` and
a route, and no owner in the plan.

### Timing / line origination: the data reality

`nfl_line_snapshots` = **2,041,217 rows, 30,049 capture instants, 25 books**, three markets
(h2h 662,444 / spreads 689,379 / totals 689,394). But by provider:

| provider | rows | capture instants | range |
|---|---|---|---|
| free:oddstrader | 1,516,672 | 1,198 | 2026-09-02 → now |
| free:pinnacle | 109,962 | 1,193 | 2026-09-02 → now |
| free:rotowire / kambi / sbr / bovada / fanduel | 255,934 | — | 2026-09-02 → now |
| **archive:oddstrader** | **135,930** | **28,493** | **2022-05-05 → 2026-09-02** |
| (null — paid Odds API) | 22,719 | 11 | 2026-08-05 → 2026-09-01 |

The archive looks like four seasons of history and is not. Measured: of 68,108
(captured_at, event_id, market) groups, **67,528 contain exactly one book**. Per
(event, book, market) there is essentially **one capture** (22,524 groups with n=1, 169 with
n=2). The mean span of `captured_at` **within a single event is 18,396 minutes — 12.8 days**
(max 230 days). A sample event shows `bookmaker` quoting on 2022-05-14 at 0, `bodog` on
2022-05-16 at −1.5, `betanysports` on 2022-09-11 at −2.5, `bovada` on 2022-09-12 at −2.5:
these are openers and near-closers stacked under one event id, not simultaneous quotes.

`nfl-shopping-board.js`'s own header states the rule this breaks: *"Comparing a stale book
against a fresh one measures latency and reports it as dispersion, which would manufacture
edges that do not exist."* The board itself is safe (`simultaneousQuotes()` groups on
`captured_at`). The consequence is for the plan, not the code.

---

## Q3 — rejected candidates whose reason has changed

Honest answer: **mostly no.** Section (e) rejections hold up well and several are
*strengthened* by what I read:

- Copula machinery for teaser legs (GF06-1..4, GF05-6): still correct to reject.
  `teaser-leg-rates.js` structurally guarantees legs come from different games
  (`same_game_pairs: 0` asserted, not assumed), and cross-game correlation was measured to
  ρ = −0.044 with a permutation p = 0.116 and a bootstrap CI [−0.095, +0.008] containing
  zero, then shown to be a week-size composition artifact. The file explicitly warns future
  editors against adding a correlation bonus. Do not reopen.
- GN04 DFS: reject stands — chunk11 grepped the whole repo and found zero salary-cap /
  DFS-contest infrastructure and no signal Nick plays DFS. (Note the internal contradiction:
  chunk20 voted *build* on GN04-C1/C2. Section (e)'s rejection is the better-evidenced call.)
- Cross-venue arbitrage as revenue, social sentiment, GP/MoE/deep-generative/RL: all
  correctly closed. Not reopened here.

The one rejection whose *reason* has genuinely changed: **GN05-C2/C3 and the GN05 bundle were
rejected as "pitched as three separate PRs against a tape that has exactly zero current
consumers beyond spread-ladder construction."** That objection is now weaker on two counts —
the tape has grown to **15,733,418** `polymarket_quotes` rows (the research said 12.4M), and
finding #2 below creates a real consumer (Polymarket as the independent second reaction series
for the news work). Note that ADD #16 already absorbed the depth-aware fill half of GN05-C2;
what is still unowned is the *ladder-weighting* half.

---

## Q4 — props-to-spread, same-game correlation, cross-market consistency beyond Step 4

Step 4a (market-prop vs market-total consistency) is genuinely novel — I found nothing in
the 56 agent notes that duplicates or beats it, and I am not proposing a substitute. Three
things sit next to it that the plan does not have:

1. **The book's SGP price vs. the book's own component prices.** `sgpAnalysis()`
   (`nfl-prop-correlation.js:263`) already computes a `correlation_multiplier` and its own
   note says *"A multiplier far from 1 is where a blanket book haircut is most likely to be
   wrong — it is a measured disagreement, not yet a proven edge."* `recordSgpQuote()` and
   `sgpQuoteEvidence()` already implement the governance loop with a stated bar (50
   candidate/close pairs, positive CLV, 0u staking until then). **`nfl_sgp_quotes` has 0
   rows** — capture is a manual POST, so the loop has never run. Same family as 4a
   (the market disagreeing with itself across its own products), different product.
2. **Team leg × player prop is still priced independently.** `propPairCorrelation(a,b)`
   keys on `stat|position`; a spread or total leg has neither, so it falls through to
   `table().get(key) ?? 0`. FIX #20 covers this and did not reach WHAT_NEXT.
3. **Spread-cover ⊂ moneyline-win** is priced as independent (FIX #21). Provably wrong, and
   `signedMarginDistribution()` already provides the correct machinery.

---

## The findings, ranked

### 1. The receipt-clock fix exists on an unmerged branch, and every capture until it merges is unrecoverable

`nfl-t60-packet.js:214`: `const realClock = scopedQuotes.filter(q => q.receipt_clock_source
=== 'response_completion')`. Measured on the live DB: **all 1,521 rows of
`nfl_quote_batches` carry `receipt_clock_source = 'legacy_request_time_only'`**, including
all 1,353 `free-book-feeds` batches from 2026-09-02 through **2026-09-13T01:47:36** — i.e.
still, right now. So `realClock` is empty for every game, `received_by_cutoff` can never be
granted, and the T-60 packet's quote section is empty always.

WHAT_NEXT.md Step 5b names the symptom — *"no forecast has yet consumed a frozen packet in
production, which was the original point of the whole architecture"* — without naming the
cause. The cause is a two-field fix that **already exists**:
`build-2026-09-12-v2-integration:server/services/book-feeds.js:418` has
`receivedAt: at, receiptClockSource: 'response_completion'`. `main` does not. No other branch
has it.

What the plan gets wrong is priority, not existence: Step 1 item 2 lists merging the branches
as housekeeping alongside a `.Rhistory` deletion. Rows written before the merge cannot be
relabelled afterwards, because the receipt time was never recorded. Week 2 is being captured
into permanent unusability as of this writing.

*Caveat: the merge itself is in the plan. What is missing is the causal link, the
irreversibility, and therefore the ordering.*

### 2. `signal-latency.js` is measuring Polymarket while claiming to measure ESPN, and the fix was dropped from every list

`signal-latency.js:57-64` pools `espn_line_moves` (81 rows) and `polymarket_line_moves`
(4,961 rows) into one undifferentiated union. 98% of the "market" this module grades our
signals against is Polymarket, while its header says it is "deliberately built on the FREE
ESPN reference line." Any latency conclusion drawn from it today is a conclusion about
Polymarket with an ESPN label.

The fix is N05's candidate 1: split the two series and ask the question symmetrically —
does the exchange lead or lag the book? The `nextMoveAfter`/`priorMoveBefore` pattern is
already proven in that same file. Zero new data collection; `polymarket_quotes` is at
15.7M rows across 17,109 condition_ids since 2026-08-29.

This is the purest form of the edge Nick's instruction says to bias toward: it is a timing
question answered from stored data, with no forecasting claim attached.

*Caveat: with only 81 ESPN moves the lead/lag test is underpowered today; the immediate
deliverable is the separation and an honest power statement, not a verdict.*

### 3. The news→market measurement asset is forward-only and started eleven days ago

Nick asked about the news. The plan has nothing. The research had two high-scoring items
(#29 event-study abnormal move, score 15.0 — tied highest in the audit bucket; #17 DML causal
estimate, score 13.0) plus the placebo null they both depend on, and none of the three reached
WHAT_NEXT.md.

Two measured facts change the cost/benefit from what F13 assumed:

- **The event side is not thin.** `nfl_verified_events` holds **119,639** immutable,
  `available_at`-timestamped rows: 39,052 `official_injury_report`, 46,470
  `weekly_roster_status_change`, 1,695 `trade`, spanning 2021-09 → 2026-04, including
  **7,133 with `status_after = 'Out'`**. F13 worried that "sample size for verified QB-level
  events specifically will be modest this season" — on the event side that worry is wrong by
  an order of magnitude.
- **The market side is the constraint, and it is a clock.** There is no intraday quote
  history before 2026-09-02 (the paid-API provider contributed 11 capture instants across all
  of August; the archive is one snapshot per book per game). So the abnormal-move study can
  only ever be run forward, and its sample started eleven days ago and grows at ~1,200
  captures/week.

That is a genuine sequencing argument the plan does not make: every week this is deferred is
a week of sample that cannot be recovered later, which is the opposite of the usual "it can
wait" calculus. The cheapest first move is F13-F1's `marketBaseline(...)` helper next to
`quoteReaction` (`nfl-news-market-latency.js:29`, already exported via `__test`) plus the
placebo null built on the same export.

*Caveat: the honest prior is still that the effect is already priced — F13's own F2 says a
tightly-estimated θ̂ near zero is the likely and still-useful outcome.*

### 4. The middle finder is spreads-only and prices windows with the wrong distribution, while the right one sits orphaned

- `nfl-shopping-board.js:267-268`: `findMiddles()` calls `simultaneousQuotes('spreads')`.
  Totals (689,394 captured rows) and h2h (662,444) are never scanned for middles or arbs,
  despite `shoppingBoard()` already accepting a `market` parameter and `bookHold()` already
  working per-market. Simon (2024, *Management Science*) is peer-reviewed evidence that the
  overreact-then-revert mechanic middles exploit is real; totals are where books move most.
- `signedMarginDistribution()` (line 46) pools **every** home margin in `game_lines`
  unconditionally. A middle window is a specific interval on a specific game's scale, so the
  correct object is P(margin | spread). `server/betting/nfl/strategy/margin-distribution.js`
  is exactly that: a fitted, walk-forward-validated, key-number-calibrated conditional PMF
  with exported `marginPmf(spread)` and `coverProbability({spread, handicap})`.
- **That module has zero importers anywhere in the repo** (`grep -rln margin-distribution`
  returns only itself), and the test file its own header cites —
  `test/margin-distribution.test.js` — does not exist.

Its own `MARGIN_MODEL_VERDICT` is honest about where it loses: it is beaten by the empirical
lookup on the eight cross-both teaser lines (3.36pp under-pricing, z = 3.42). It is explicit
about where it wins: *"on 7,646 non-family legs the model is within 0.05pp and beats the
windowed lookup by 23.2 nats"* and *"on sparse lines the model is the best estimator
available because the lookup has nothing to look up."* Middles are sparse lines by
construction — arbitrary windows at arbitrary spreads.

Its `family_line_bias` field also records a measured pricing error nothing in the plan
mentions: favourites at −7 to −8.5 historically beat their number by 1.04 points (z = +2.36)
and underdogs at +1.5 to +3 by 0.85 points (z = +2.84), against an otherwise linear
efficiency slope (chi-square 31.2 on 25 cells, p = 0.18).

*Caveat: middles need two books straddling at the same instant; the live free tape is 11
days old, so the historical yield of this is unknown — see finding #5.*

### 5. Step 2's leaderboard cannot honestly include the execution strategies on pre-September history

WHAT_NEXT.md Step 2 item 5e promises one purged walk-forward protocol over "the incumbent
ensemble, the raw blend, the market-residual blend, the new joint scoring model … and the
execution/teaser strategies." The teaser strategies can do this — `margin-distribution.js`
already walk-forwards 2007–2024 on `game_lines`. The **execution** strategies cannot, and the
plan does not know it yet.

Shopping value, middles, arbitrage and sharp-vs-rec divergence all require two or more books
priced at the same instant. Measured: in `archive:oddstrader`, **67,528 of 68,108
(captured_at, event_id, market) groups contain exactly one book**, and the mean span of
capture times within a single event is **12.8 days**. Running a dispersion backtest across
that would measure staleness and report it as edge — the precise failure
`nfl-shopping-board.js`'s header warns about.

So Step 2 needs an explicit decision before it runs: either (a) a stated tolerance-window join
with the latency confound measured and reported, or (b) execution strategies are scoped to the
forward record only, with a stated accumulation horizon. Silently including them produces the
one thing Step 2 exists to prevent — a number that looks like a verdict and isn't.

*Caveat: I did not check whether a same-instant multi-book subset exists in some other
provider I did not enumerate; the 580 two-and-three-book groups are too few to matter.*

### 6. The SGP self-consistency loop is built, gated, and empty

`nfl_sgp_quotes` = **0 rows**. `recordSgpQuote()` requires a manual POST with
`event_key`, `book`, `legs`, `offered_odds`; nothing auto-captures. `sgpQuoteEvidence()`
already implements the right gate (50 candidate/close pairs, positive mean probability CLV,
`staking_authority: '0u until …'`). `prop_correlation_estimates` has 182 fitted archetypes
ready to feed it.

This is Step 4a's mechanism applied to a second product: compare the book's posted parlay
price against the book's own component prices, and the residual is the correlation haircut
the book is charging. No predictive superiority required. It also has the one property 4a
lacks — a governance gate that already exists in code.

*Caveat: books apply blanket SGP haircuts and hold small limits on correlated parlays;
"the book's haircut is wrong" and "you can get paid for it" are different claims, and 50
manually-entered pairs is real operational cost.*

### 7. The Polymarket implied line weights its least trustworthy rungs equally

`polymarket-lines.js`'s `isotonic()` + `crossing()` takes only `{x, p}` pairs — no size, no
spread. Dubach 2026 measured the exact reason not to: the quoted half-spread is ~400bps in
the middle of the book and **1,300–1,800bps below 0.10 probability**, which is where the
tails of any spread ladder sit. `captureOrderBooks()` already stores `bid_size`, `ask_size`
and `spread` on all 15.7M `polymarket_quotes` rows and nothing reads them.

This is distinct from ADD #16 (depth-aware *fill* simulation, which asks whether you can
transact). This asks whether the number you derived is biased before you ever act on it —
which matters most if finding #2 promotes Polymarket to an independent reaction series.

*Caveat: lower priority than 1–5. Only pays off if the ladder crossing is actually used for
something beyond monitoring.*

---

## Things I checked and found the plan (or the code) already handles

- **ADD #16 depth/fill-aware execution simulator** covers the "can you fill it" half of
  Polymarket microstructure. Not re-proposed.
- **Book limits.** `nfl-execution-replay.js:106-123` reports `book_limit_modeled: false` and
  says so in prose rather than inventing a number. That is the right behaviour; no gap.
- **Delayed execution realism.** `nfl-execution-replay.js` already models nine honest
  outcomes including `repriced`, `disappeared`, `capped`, `pending` and
  `post_kickoff_unknown`. The "seeing a number vs. acting on it" gap is closed.
- **Cross-venue arbitrage as a revenue plan** — settled negative ($210 single-market / $560
  combinatorial per NBA month, 76.9% capped at ~15 shares). Not reopened.
- **Social/market sentiment** — settled. The one replicating effect (Feddersen/Humphreys/
  Soebbing: books shade toward popular teams, but those teams do not win more often) is a
  bookmaker bias already priced in, exactly as the plan says.
- **Teaser same-game/cross-game correlation** — measured to insignificance in
  `teaser-leg-rates.js` with unusual rigor; the file warns against "fixing" it. Do not build
  copula machinery for it.
- **Step 2's statistical spine** (purged walk-forward, trial backfill, Geyer-corrected
  `effective_n_trials`, DSR/PBO haircut) is well covered by F06/GF10 and the `purgedcv` port.
  Nothing to add.
- **Step 4a itself** is not duplicated anywhere in the 56 agent notes. It stands.
- **`beat-the-close.js`** — the forward CLV record Step 2 and the "What I would NOT do"
  section both call for already exists and is running (38,055 signal snapshots, 61 shadow
  decisions across 5 signals). The plan should credit it rather than treat the forward record
  as unbuilt.
- **Devig.** `nfl-devig.js` already ships proportional + Shin with a documented default
  switch; the Step 5c seven-method dispatcher is the right next step and is already listed.
