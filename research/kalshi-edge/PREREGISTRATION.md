# Pre-registration: who is on the other side of Kalshi sports trades

Written 2026-11-17, committed before any settled result was joined to a price or
a flow number. The commit that adds this file is the timestamp.

## 0. What had been seen when this was written

- Kalshi's public trade tape for 2026-05-30 to 2026-11-15, reduced to 5-minute
  bars: dollars and order counts by flow class, by series and by day. Prices
  and flows only.
- The milestones table (scheduled start and end of 204,700 games and matches).
- **No outcome.** The results puller was writing settled-market files to disk
  while this was drafted; no analysis had opened one. Two settled markets were
  printed while probing the API (the Nov 16 Houston–Miami game and one NBA
  Finals game); neither was compared with a price.

## 1. The idea

The public tape has no trader identity. It does have order sizes, and consumer
apps let people buy in dollars. Since fractional contracts exist, a "Buy $10"
order prints as a fractional contract count whose cost plus fee is a whole
dollar. That fingerprint splits every taker order into:

| class | rule | reading |
|---|---|---|
| RB | fractional count, cost + fee within 1.1c of a whole dollar | retail app buying in dollars |
| FX | fractional count, off the dollar grid | mostly retail closing dollar-opened positions, partial fills |
| IN | integer count | contract-count apps and API / professional flow |

each in four sizes by order cost (under $25, $25–250, $250–2,500, $2,500+).
On 2026-11-15 alone RB was 38% of 5.07M sports taker orders.

Sportsbooks profile customers to know which money is sharp. This is the same
thing done from the outside, on an exchange where the profiling data is public.
The question is whether prices lean toward where retail dollars push them, by
enough to pay the fee.

## 2. Data

- Tape: Hugging Face `TimeSeventeen/Kalshi`, one Parquet of fills per UTC day.
  A third-party archive; its own README says it is not a proof of completeness.
- Game clock: `GET /milestones`, field `start_date` (scheduled start).
- Results: `GET /historical/markets` and `GET /markets?status=settled`, pulled
  series by series in descending order of traded dollars. Coverage is therefore
  biased toward high-volume series; the report states the covered share.
- Fees: series `fee_type` and `fee_multiplier`, with `GET /series/fee_changes`
  for history. Taker rate 7% × multiplier × p(1−p) per contract.

## 3. Universe

A market is in the study if

1. its event ticker (the first two dash-separated parts of the ticker) appears
   in the `related_event_tickers` of exactly one milestone;
2. the API returned it as settled with a settlement value;
3. it has at least one finished 5-minute bar in the 7 days before the decision
   time.

Season-long and futures markets have no milestone and are out.

## 4. Split, by scheduled start (UTC)

| set | range | use |
|---|---|---|
| train | start < 2026-09-01 | discovery, model fitting |
| validation | 2026-09-01 ≤ start < 2026-10-01 | model and threshold selection |
| **holdout** | 2026-10-01 ≤ start ≤ 2026-11-15 | **one look** |
| forward | start ≥ 2026-11-16 | live ledger written by the scanner |

Holdout snapshots are written to their own directory. One script reads it. It
refuses to run without a frozen model file, and every run appends a row to
`HOLDOUT-LEDGER.md` in the same commit as its output.

## 5. Decision time and execution

- Decision time t0 = scheduled start − h. **Primary h = 10 minutes.** Secondary:
  60, 360, 1,440.
- Features use only bars that had finished by t0 (`kalshi_edge/snapshots.py`,
  pinned by tests).
- Quotes: `ask0` is the yes-price paid by the most recent YES-taker order
  before t0; `bid0` the yes-price at which the most recent NO-taker order
  traded. Reference price `p0 = (ask0 + bid0) / 2`, used only when both quotes
  are at most 30 minutes old (120 for the longer horizons) and
  0 ≤ ask0 − bid0 ≤ 0.10. The last trade price is not used as the reference: it
  sits on the ask after a buy and on the bid after a sell, which would
  manufacture a "retail buying predicts a low outcome" result out of the
  spread.
- **Fill rule.** A bet is a limit order placed at t0. It is filled at the price
  of a real same-side taker print in one of the two 5-minute bars after t0
  (and before the start), the first whose price is at or under the limit. No
  such print, no bet. A YES buy pays that print; a NO buy pays 1 − the bid print.
- Fee at the series' taker rate on that date, rounded up to the cent on the
  order. Payout is the settlement value.
- Stake: $100 at risk per bet. At most one bet per event ticker per horizon
  (the one with the largest modelled edge), so the two sides of a game and the
  rungs of a ladder are not stacked.
- Capacity is reported, not assumed: the same-side taker dollars in the bar the
  fill came from.

## 6. Primary hypotheses, tested on the holdout at h = 10

With y the settlement value (0/1 markets only for the regressions) and p0 as
above. Standard errors clustered by game (milestone).

| id | claim | test |
|---|---|---|
| P1 | Favourite–longshot bias: longshots are overpriced, favourites underpriced. | slope β > 1 in logit P(y) = α + β·logit(p0), one-sided |
| P2 | Retail dollars push price the wrong way: net retail buying predicts a lower outcome than the price says. | γ < 0 on RP = (RB yes $ − RB no $) / all taker $, with 20 five-cent price-bin dummies and logit(p0), one-sided |
| P3 | Large integer orders are informed. | δ > 0 on LP = (IN ≥$250 yes $ − no $) / all taker $, same regression, one-sided |
| P4 | **The money test.** The frozen strategy's net return per dollar staked is positive. | game-cluster bootstrap, 10,000 draws, one-sided |

Family-wise α = 0.05 with Holm across P1–P4. Directions are fixed here and are
not flipped if train disagrees.

P1–P3 are parameter tests on the holdout and do not depend on anything fitted.
P4 depends on the frozen model.

## 7. Secondary, reported as exploratory with Benjamini–Hochberg q-values

S1 slope β by family and sport. S2 β against retail share. S3 in-game
calibration slope against pre-game. S4 taker profit by flow class before and
after fees (who pays whom). S5 the other horizons. S6 a passive entry that
rests at the bid instead of taking. S7 pre-game price change as a predictor.

## 8. Model protocol (train and validation only)

Ladder, each rung adopted only if it beats the one below on validation log
loss with a game-cluster paired bootstrap whose 90% interval excludes zero:

- M0 the market: p0.
- M1 recalibration: intercept and slope on logit(p0) by family, ridge-pooled.
- M2 M1 plus the flow terms RP, LP, retail share and their interaction with
  |logit(p0)|.
- M3 gradient-boosted trees with logit(p0) as the starting score.

Strategy: bet a side when modelled probability − (price + fee per contract)
exceeds a threshold τ. τ is chosen from {0.5c, 1c, 2c, 3c, 5c} to maximise
validation net profit subject to at least 300 bets. Model, τ and the feature
list are frozen to a JSON file whose hash is committed before the holdout is
opened.

The holdout is run once whatever validation shows. If nothing clears on
validation, the pre-specified M1 rule at τ = 1c is the frozen strategy, so the
primary test is not conditional on validation having looked good.

## 9. What counts

- **Edge found**: P4 survives Holm, its interval's lower bound is above zero,
  and the weekly sign is positive in at least 70% of holdout weeks.
- **No taker edge**: anything else. The report then says so, and what the
  secondary tables show about where the money goes.

A validation or train result is never reported as evidence of profit.

## 10. Limitations known before looking

- Fills assume the order does not move the price. True for small size only;
  capacity is reported per bet.
- Entry prices are prints that happened, so asks nobody lifted are unobserved.
  The limit-order fill rule keeps that from flattering the result, but it does
  drop bets.
- Scheduled start, not actual start. Tennis schedules slip.
- The tape is a third-party archive.
- One year of a market that grew about twentyfold while fees, products and
  participants changed. A fitted bias can be competed away.
- Rules, fees, limits and legality are the venue's and the regulators' to change.
