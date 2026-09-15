# N05 — Prediction-Market Mining: What the Polymarket Quote Tape Could Newly Support

Bucket: **new** (this agent). Topic: cross-market arbitrage detection, implied-probability
time series as leading indicator, liquidity/microstructure signals, market-consensus
tracking distinct from sportsbooks — read against the actual Gridiron code, not against
what the code's own comments claim it does.

## 0. What Gridiron already has (grepped, not assumed)

Read-only pass over `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard`:

- **Tables** (`server/db/schema/mlb-model-misc.js:534-580`): `polymarket_line_moves`
  (derived spread/total ladder crossings), `polymarket_markets` (condition_id →
  question/kind/player/stat/threshold), `polymarket_quotes` (captured_at, condition_id,
  mid_yes, best_bid, best_ask, bid_size, ask_size, spread, volume, liquidity — one row
  per capture per market), `polymarket_price_history` (condition_id, ts, price — raw
  tick series). `prediction_market_quotes` / `prediction_market_flow` hold Kalshi.
  The "12.4-million-row quote tape" in this brief is this quote/tick family; the code
  captures order books roughly every 30 minutes across ~600+ open NFL markets
  (`server/services/polymarket.js`), which is exactly the row-count order of magnitude
  a season of 30-minute ticks across hundreds of markets produces.
- **`server/services/polymarket-lines.js`**: builds the spread/total *ladder* into a
  single implied number via `isotonic()` (pool-adjacent-violators monotone fit) +
  `crossing()` (linear-interpolated 50% crossing). This is the "spread-ladder
  construction" the brief refers to. It is **unweighted** — every ladder point
  contributes equally to the fit regardless of its own bid/ask spread or depth
  (grepped: `crossing(points, {increasing, minPoints})` takes only `{x, p}` pairs, no
  size or spread field).
- **`server/services/market-movement.js`**: surfaces `polymarketMovement()` in the
  descriptive `/market-movement` panel, explicitly labelled `'descriptive only'`.
- **`server/services/signal-latency.js`**: the one latency-measurement module that
  exists. Its `MOVE_UNION` (`espn_line_moves UNION ALL polymarket_line_moves`) **pools**
  ESPN reference-line moves and Polymarket-implied-line moves into a single undifferentiated
  movement log, then asks only "did OUR news signals lead this pooled log?" It never asks
  "does the Polymarket series lead or lag the ESPN/book series?" — the two markets are
  never compared to each other, only used together as one proxy for "the market."
- **`server/services/prediction-markets.js`**: a *different*, still-untested hypothesis —
  does Kalshi trade *flow* (size + aggressor side) lead sportsbook line moves? This is
  about trade flow, not price level, and is Kalshi-specific, not Polymarket.
- **`server/services/nfl-ensemble.js`**: grepped for `polymarket` — **zero references**.
  Polymarket's implied line has never been fed into the actual forecast blend
  (`forecast ≈ 0.68 + 0.632·market`, the F02 defect) or into `nfl-team-strength.js`
  (also zero references). Polymarket today is purely a monitoring/cost feed, never a
  forecasting input.
- **`server/services/polymarket.js`**: props (`parsePolymarketProp`, `polymarket_markets`
  kind='threshold_prop') are ingested and costed (`polymarketCost()`) but never compared
  against Gridiron's own player projections or against sportsbook prop lines, and never
  read as a *time series* — `polymarket_price_history` is written
  (`server/services/polymarket.js:342`) but nothing in the codebase reads it back for
  anything except a two-point before/after diff (lines 397-400).
- **`server/services/who-plays.js`**: the fantasy-facing availability engine. Explicitly
  documents a precedence rule — official report > beat-reporter signal > snap-count
  inference — and is architecturally built to accept additional ranked sources. It has
  no market-derived source today.

So: the ladder-construction use of the tape is real and already shipped. Everything else
listed in the brief — arbitrage detection, the tape as a *leading-indicator time series*
(as opposed to a two-point diff), liquidity-aware weighting, and market-consensus-as-a-
distinct-forecast-input — is genuinely unbuilt.

## 1. Primary sources read in full

### 1.1 Dubach (2026), "The Anatomy of a Decentralized Prediction Market: Microstructure
Evidence from the Polymarket Order Book," arXiv:2604.24366v2, 14 May 2026.
https://arxiv.org/abs/2604.24366

- **Sample**: continuous tick-level archive of Polymarket's public order-book WebSocket
  feed, 30,287,264,368 events over 52 calendar days (2026-02-21 to 2026-04-15), 385,198
  distinct market_ids, joined on a 28-day overlap window to 255,425,405 on-chain
  `OrderFilled` fills from the CTF Exchange V1 contract. Pre-registered, stratified
  600-market panel (top-100 by volume + random-500), volume range $4.56M–$96.0M
  (top stratum).
- **Key result 1 (trade-direction inference is unreliable from the public feed alone)**:
  the feed's `change_side` field marks which side of the book moved, not who initiated the
  trade. Sign agreement between feed-inferred trade direction and authoritative on-chain
  trade direction is only **~59%** volume-weighted (bootstrap 95% CI [0.58, 0.65]) — barely
  above the 50% chance floor, vs. the ~80% Lee-Ready accuracy documented on Nasdaq/NYSE.
  Direction-dependent microstructure measures (effective spread, Kyle's λ) built on the
  feed alone **flip sign** between windows 43-67% of the time.
- **Key result 2 (longshot spread premium, SF1)**: quoted half-spread is ~400bps at
  mid-price [0.4, 0.6] and balloons to **1,300–1,800bps** for markets trading below 0.10
  probability — an order of magnitude wider than the classic racetrack longshot premium
  (a few percent of stake), which the author reads as a liquidity-provision/inventory-risk
  effect (bounded upside, unbounded downside for a maker on a low-probability binary) rather
  than pure behavioural longshot bias.
- **Key result 3 (depth concentration, SF2)**: top-of-book carries a median 13.6% of
  cumulative top-10 depth vs. a 10% uniform-grid null — a modest premium, not the
  top-heavy book the "folk view" assumes. 57% of markets sit within a factor-of-two of
  uniform. Depth is explained by market duration, price level, and volume, with no
  residual time-to-close effect once those three are controlled.
- **Limitation, stated by the author**: any Polymarket microstructure result that depends
  on trade direction inferred from the public feed (rather than the on-chain
  `OrderFilled` log) is not trustworthy; the paper releases a replication package for the
  on-chain join specifically because the feed-only route fails this badly.

### 1.2 Cheng, Yang & Zou (UCLA, 2026), "Arbitrage Analysis in Polymarket NBA Markets,"
arXiv:2605.00864v1, 5 May 2026. https://arxiv.org/abs/2605.00864

- **Sample**: 75,088,497 top-of-book (Level-1) LOB snapshots across 173 NBA games
  (2026-02-04 to 2026-03-04), polled every 3.6-5.5 seconds; separately, 8.59M
  combinatorial market-state observations across the same games for the Moneyline↔Spread
  cross-market test.
- **Key result 1 (single-market arbitrage is almost extinct)**: only **7** valid,
  executable in-game episodes across 3,042 markets survived after excluding 30 of 37
  raw hits as post-game liquidity-withdrawal artefacts (median post-game spread 7,533bps
  vs. 1,031bps in-game vs. 392bps pre-game). Median episode duration **3.6 seconds** —
  below the polling cadence itself, meaning true frequency is a *lower bound*. Aggregate
  capped profit (at $100/episode) was $210.19; median per-episode yield excluding one
  outlier was 11.0%.
- **Key result 2 (combinatorial Moneyline↔Spread arbitrage is more common but
  liquidity-bound)**: 290 executable episodes (median 2.0/game), overwhelmingly
  concentrated in the final minutes of live play, median duration 16 seconds, median
  return 101bps. But **76.9%** of episodes were constrained to an average executable
  size of just **14.8 shares** — the "Middle" double-payout jackpot (both legs resolve
  YES) was never realized once, empirically, across the sample. The authors' explicit
  framing: execution, not detection, is the binding constraint (Shleifer & Vishny 1997
  limits-to-arbitrage).
- **Limitation, stated by the authors**: Level-1-only data is a conservative floor —
  deeper-book combinatorial opportunities may exist but were not measured; the 3.6-5.5s
  poll cadence structurally cannot see sub-poll flash arbitrage, so both frequency
  numbers understate true occurrence while the survivorship numbers (duration ≥ 1 poll)
  overstate true persistence.

### 1.3 Nechepurenko (2026), "Per-Market Information Leakage and Order-Flow Skill: Two
Methodological Lenses on Informed Trading in Decentralized Prediction Markets,"
arXiv:2605.02287v2, 15 May 2026. https://arxiv.org/abs/2605.02287

- **Not an empirical paper on Gridiron's own tape** — a methodological comparison of
  three 2026 approaches to detecting informed trading on Polymarket, useful for scoping
  what is and isn't reachable from a quote-only archive (Gridiron has no wallet-level
  on-chain data).
- **Result summarized (Mitts & Ofir 2026)**: composite wallet-market anomaly screen over
  210,000+ wallet-market pairs, 2023-early 2026, ≈$143M aggregate anomalous profit
  estimated platform-wide.
- **Result summarized (Gomez-Cram et al. 2026)**: sign-randomization skill classifier
  (10,000 event-level direction permutations per account) over 1.72M accounts / 210,322
  markets / $13.76B volume, 2023-2025. 3.14% of accounts (54,477) classify as "skilled
  winners"; skilled winners + market makers (<3.5% of accounts) capture >30% of platform
  gains; 44% out-of-sample skill persistence (vs. ~10% in published equity mutual-fund
  studies).
- **The paper's own market-level contribution, ILS** (Information Leakage Score):
  `ILS(M) = [p(T_news) - p(T_open)] / [p(T_resolve) - p(T_open)]` — the fraction of a
  resolved market's total price move that had already happened *before* the corresponding
  public news event. This is a **market-level, price-trajectory-only** score — no wallet
  data required — which is exactly what Gridiron's `polymarket_price_history` tick table
  can compute for any resolved market with an identifiable news anchor.
- **Limitation, stated by the author**: none of the three layers (wallet anomaly score,
  wallet skill classifier, market-level ILS) subsumes the others; ILS says nothing about
  *who* moved the price, and ILS requires an externally-dated news event, which for NFL
  usually exists (injury reports, roster moves) but is not automatically joined to the
  Polymarket price series anywhere in the literature reviewed or in Gridiron's code.

### 1.4 Wolfers & Zitzewitz (2004), "Prediction Markets," NBER Working Paper 10504 /
Journal of Economic Perspectives. https://www.nber.org/papers/w10504

- **Foundational, not new**: the classic survey establishing prediction-market prices as
  usable probability estimates under the efficient-markets logic ("the marginal trade
  need only be motivated by a rational trader"), documented against Iowa Electronic
  Markets and Tradesports data, including the DARPA/Poindexter Tradesports anecdote
  (price moved from 40 to 80 within minutes of a Pentagon-insider news leak, well before
  the story broke widely — the original empirical case for "prediction markets as an
  early-warning system," which is precisely the mechanism candidate 1 below tries to
  measure for NFL).
- **Stated caveat directly relevant here**: the paper explicitly warns against treating
  a single market's price level as a clean probability without accounting for thin
  trading, risk-premium effects near extreme probabilities, and small-population
  information aggregation failures — i.e., exactly the failure modes Dubach (2026) later
  quantifies for Polymarket specifically (the longshot spread premium, the depth
  concentration). Twenty-plus years apart, both papers land on the same warning: price
  *level* trust degrades near 0 and 1, which is where fantasy-relevant player-prop
  markets (season TD/yardage thresholds) mostly live.

## 2. What this actually rules in and out for Gridiron

- **Do not build a live arbitrage-execution bot.** Cheng et al.'s own numbers are the
  argument against it: 7 single-market episodes across 3,042 markets, median 3.6-second
  life, and even the more frequent combinatorial opportunities are capped at ~15 shares
  of executable size 77% of the time. Gridiron's server polls Polymarket every 30 minutes
  (`server/services/polymarket.js` comment, and the scheduler cadence), two orders of
  magnitude slower than the 3.6-5.5s cadence that still only caught 7 episodes over a
  month of NBA games. There is no capital-deployment story here at Gridiron's poll rate.
- **Do build detection/measurement, not execution.** The rate and depth-boundedness of
  crossed-book instances is itself a *liquidity-quality* signal (see candidate 2) —
  cheap to compute from data already stored, and it tells you when to trust vs. discount
  the spread-ladder crossing, which is a real, already-shipped consumer.
- **Wallet-level informed-flow detection (Mitts & Ofir / Gomez-Cram style) is out of
  reach.** Gridiron's schema stores condition_id + captured_at + bid/ask/size, not
  maker/taker wallet addresses or on-chain fills — matching Dubach's own finding that the
  *public feed alone* cannot even recover trade direction reliably (59% vs. 50% chance).
  Building a skill classifier or wash-trade detector would require ingesting on-chain
  `OrderFilled` events, which nothing in the codebase does today and which is out of
  scope for "features from data already collected." Market-level ILS-style scoring,
  by contrast, needs only the price trajectory Gridiron already has — that is what's
  reachable and is candidate 3's basis, retargeted at fantasy availability rather than
  full ILS since the exact news-anchor join Nechepurenko's ILS needs is itself a
  meaningful build (already-existing `nfl_news_signals.published_at` is close but not
  identical to "public disclosure of the specific fact the market moved on").

## 3. Do not do

- Do not build a Polymarket/Kalshi/sportsbook execution arbitrage bot. Every read-in-full
  source that measured this (Cheng et al.) found the opportunity real but capped at
  retail scale and invisible at Gridiron's 30-minute poll cadence; building it would burn
  engineering time on an edge smaller than Gridiron's own transaction costs.
- Do not fold a raw Polymarket implied-line level into `nfl-ensemble.js`'s existing
  blend as one more linear-shrinkage input. F02 already shows the ensemble is naive
  shrinkage toward the close with 20 components collapsing to ~3 independent signals;
  adding Polymarket's level the same way is adding a 21st correlated component to a
  blend already proven not to combine information, not fixing the defect.
- Do not attempt wallet-level informed-trader detection (skill classifiers, wash-trade
  screens) — Gridiron has no on-chain fill data, the public feed cannot substitute
  (Dubach 2026's 59% sign-agreement result), and the three 2026 papers reviewed all
  require infrastructure Gridiron does not have and this brief does not authorize
  building (no paid API calls; on-chain RPC scraping is a materially different, costlier
  system).
- Do not treat Polymarket's mid-price as automatically vig-free "truth" without checking
  depth. Dubach's SF1 shows the quoted half-spread reaches 1,300-1,800bps exactly in the
  low-probability range where fantasy-relevant player props live — a "no-vig" price with
  a 15-18% spread around it is not a precise probability, it's a wide band.
- Do not chase the combinatorial "Middle" jackpot pattern (Moneyline+Spread double
  payout) as a strategy — it was never realized once in Cheng et al.'s full sample;
  it is a theoretical curiosity, not an EV source.

## 4. Candidates

See structured output for the full 6-candidate table (4 new-capability, 2 fix-tagged).
Summary of the three genuinely new capabilities the brief specifically asked for:

1. **Exchange-vs-book lead/lag test** — stops pooling Polymarket and ESPN moves into one
   undifferentiated `MOVE_UNION` (as `signal-latency.js` does today) and instead asks,
   symmetrically, whether the Polymarket-implied line systematically leads or lags the
   free ESPN reference line, using the exact `nextMoveAfter`/`priorMoveBefore` pattern
   already proven out in that file. This is "implied-probability time series as a leading
   indicator," built with zero new data collection.
2. **Liquidity-weighted spread-ladder crossing** — `polymarket-lines.js`'s `isotonic()`/
   `crossing()` treats every ladder point as equally informative; Dubach's SF1 (spread
   premium in the tails) is the direct empirical reason not to. Weight by depth/inverse-
   spread already sitting unused in `polymarket_quotes` (bid_size, ask_size, spread).
3. **Market-implied player-availability signal for `who-plays.js`** — reads
   `polymarket_price_history` ticks on season-long player-prop threshold markets as a
   new, continuously-updating source slotted into the existing official/beat-reporter/
   snap-count precedence chain — this is the one candidate that serves fantasy directly,
   which the standing priority note ranks above betting.

Two fix-bucket candidates piggyback on the same tape because it is the one clean,
vig-free, already-collected price source Gridiron has for cross-checking defects found
tonight in the devig and CLV code.
