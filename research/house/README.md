# house — getting paid to quote on Kalshi

Started 2026-11-17 from nothing: no code, data or conclusion is imported from
`research/kalshi-edge`. That study's one durable finding (no prediction rule
beat the fee) is the reason this one does not predict.

**Nothing here places an order.** Everything reads public endpoints.

## The idea

Kalshi pays a fixed pool per market per period to whoever has orders resting
near the best price, and publishes every pool (`GET /incentive_programs`).
The order book is public too (`GET /markets/orderbooks`, 100 books a request).
So the reward a new order would earn is computable for every market, live,
without an account. What is not known is what such an order loses when it is
filled just before the price moves. This directory measures both.

## What is checked, and against what

| claim | source | where |
|---|---|---|
| The scoring formula | Kalshi's CFTC filing of 2026-10-14, Appendix B section 5 | `house/lip.py`, `tests/test_lip.py` (each test quotes its sentence) |
| Tick counts on tapered price grids | each market's own `price_ranges` | `house/grid.py` |
| Books and programmes | Kalshi's public API, read every ~2.5 minutes | `house/recorder.py` |

One correction already made: the first pass counted only the first
target-size contracts at each price as qualifying and reported incumbents
earning 2% a day. The filing says *all* bids at a qualifying price count. The
right figure for 2026-11-17 20:15 UTC was $93k a day on $64.5M of qualifying
orders, 0.14% a day. `test_every_bid_at_a_qualifying_level_counts_not_just_the_first_thousand`
pins it.

## Run it

```sh
cd research/house
uv venv .venv --python 3.13 && source .venv/bin/activate && uv pip install -r requirements.txt
python -m pytest tests -q                       # no network
nohup setsid scripts/run_recorder.sh &          # books for every rewarded market, to data/
python scripts/hist_extract.py                  # 14 months of trades in rewarded markets (72 GB read, ~25 min)
```

## Layout

| path | what |
|---|---|
| `house/grid.py` | prices as integers, ticks on a market's own grid |
| `house/lip.py` | the reward formula: qualifying bids, reference price, score, payout |
| `house/client.py` | paced public reader with backoff |
| `house/recorder.py` | programmes, books, scores, market facts, trades -> `data/` (gitignored) |
| `scripts/` | entry points |

## Known limits

- The public API allowed about 40 books a second from this address on
  2026-11-17, so a full pass takes ~2.5 minutes. Kalshi samples once a second.
  A share estimated from our passes is unbiased but noisier than theirs.
- The programme is filed to run until 2027-01-01 unless Kalshi re-files.
- Rewards go to "Eligible Participants": Kalshi members, not affiliates, not
  customers of an introducing broker or FCM.
- Orders placed only to collect a reward and pulled before they can trade are
  what Rule 5.17 calls spoofing. Anything built on this has to quote prices it
  is willing to trade at.
