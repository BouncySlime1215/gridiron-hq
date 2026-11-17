# kalshi-edge — who is on the other side of Kalshi sports trades

A standalone research directory. It reads public Kalshi market data only, writes
under its own gitignored `data/`, and is imported by nothing in the server or
client. Built in one session on 2026-11-17.

## Where things stand

**No strategy here has passed a clean out-of-sample test.** Both pre-registered
money tests failed on the holdout (`results/holdout.json`, `HOLDOUT-LEDGER.md`
row 1).

| | train | validation | holdout |
|---|---|---|---|
| Pre-game taker model (P4) | no rung beats the market | 23 bets, noise | 6 bets, 6 lost |
| Early longshot offer, re-offered each minute in-game (A2) | +0.72% | +1.16% | **−1.60%** [−2.35, −0.85] |
| One resting offer set before kickoff (S11, secondary) | +2.21% | +0.97% | +2.11% [+0.22, +3.86] |
| Integer orders minus retail dollar-buys, in-game return before fees (A1) | +1.84 pts | +3.22 pts | **+3.27 pts** [2.11, 4.41] |

What held: the public tape can be split into retail dollar-buys and
integer-count orders without any trader identity, and in-game the two earn
very different returns (A1, Holm p = 0.0006). Integer flow is also followed by
the quote midpoint moving its way, about +0.3c a minute later per unit of flow
(t between 9 and 21 in each period); retail dollar-buying by a third of that or
nothing.

**Correction, same day.** The first write-up said integer flow was followed by
+1.0c and retail flow by −0.3c. Those came from comparing average trade prices,
which carry bid-ask bounce. On midpoints the integer effect is a third of that
and the retail effect is not negative (`results/s13_midpoint.json`,
`tests/test_flowprice.py`). A1 is unaffected.

What is only a lead: S11 was positive in all three periods and in 18 of 19
months, 3,209 positions pooled at +2.05% [1.22, 2.87]. It was a declared
secondary, not a primary test, and its fills are simulated from a tape. The
paper scanner is tracking it forward.

## Run it

```sh
cd research/kalshi-edge
uv venv .venv --python 3.13 && source .venv/bin/activate
uv pip install numpy pandas scipy scikit-learn lightgbm pyarrow "httpx[http2]" aiohttp duckdb matplotlib statsmodels tqdm pytest pytz

python -m pytest tests -q                 # 163 tests, about 5 seconds, no network
python scripts/scan_live.py scan --lead 20   # paper tickets for games starting in the next 20 minutes -> forward/ledger.jsonl
python scripts/scan_live.py grade         # fills and results for tickets whose window closed
```

Rebuilding the study from nothing takes about two hours, most of it waiting on
the public API's rate limit (roughly one request a second):

```sh
curl -sS "https://api.elections.kalshi.com/trade-api/v2/series?category=Sports" -o data/meta/series_sports.json
curl -sS "https://api.elections.kalshi.com/trade-api/v2/series/fee_changes?show_historical=true" \
  | python -c "import json,sys; json.dump(json.load(sys.stdin)['series_fee_change_arr'], open('data/meta/fee_changes.json','w'))"
curl -sS -L "https://huggingface.co/datasets/TimeSeventeen/Kalshi/resolve/main/manifest.json" -o data/raw_dl/manifest.json

python scripts/build_bars.py              # 684 days of tape -> 5-minute flow bars (23 min, 3.7 GB)
python scripts/build_minute_bars.py       # winner markets -> 1-minute first-print bars (10 min, 2.1 GB)
python scripts/pull_meta.py               # game clocks and settled results (the slow part)
python scripts/build_dataset.py           # pre-game decision snapshots
python scripts/build_ingame_min.py        # in-game minutes paired with the next minute's first prints
python scripts/join_outcomes.py           # attaches results; holdout rows go to their own directory
python scripts/flow_pnl.py                # who pays whom, train and validation
python scripts/freeze.py                  # frozen/model.json
python scripts/run_holdout.py --split validation
python scripts/run_holdout.py --split holdout    # writes a ledger row every time it is run
```

## Layout

| path | what |
|---|---|
| `PREREGISTRATION.md` | hypotheses, split dates, fill rules; Amendment 1 added before the holdout |
| `HOLDOUT-LEDGER.md` | every look at the holdout, numbered |
| `frozen/model.json` | the model and rule constants the holdout run used (sha256 `fb396483…`) |
| `results/*.json` | the same evaluation on train, validation and holdout |
| `forward/` | paper tickets written by the scanner, and their grading |
| `kalshi_edge/tape.py` | fills → parent orders → flow classes → bars |
| `kalshi_edge/snapshots.py` | what was knowable h minutes before a start |
| `kalshi_edge/ingame.py` | in-game fills: marketable orders and resting orders |
| `kalshi_edge/backtest.py`, `strategy.py` | fee, limit, fill and settlement arithmetic |
| `kalshi_edge/rules.py` | the frozen in-game rules and the before-kickoff offer, one code path for every split |
| `kalshi_edge/flowprice.py` | does a group's net buying predict the next minute's midpoint |
| `kalshi_edge/guard.py` | the holdout cannot be read without a ledger row |
| `kalshi_edge/live.py` | live quotes → order tickets (no network, no orders) |
| `docs/tdd/2026-11-17-kalshi-edge.tdd.md` (repo root) | RED/GREEN commits and mutation tallies |

## The idea in one paragraph

Consumer apps let people buy in dollars. Since fractional contracts launched
(the week of 2026-04-13), a "Buy $10" order prints as a fractional contract
count whose cost plus fee is a whole dollar. Fills stamped with the same
microsecond and taker side are one aggressive order. Together those two facts
sort every taker order into a retail dollar-buy, another fractional order
(mostly retail exits), or an integer-count order (contract-count apps and API
flow), from a tape that carries no identities.

## Limits

- Fills are simulated. A marketable order is filled at the next minute's first
  same-side print; a resting order is filled only when the market trades
  through it. Real queue position is not on a public tape.
- The tape is a third-party archive (`TimeSeventeen/Kalshi` on Hugging Face),
  not an exchange product.
- Maker fees use each series' current fee type.
- Scheduled start times, not actual ones.
- One year of an exchange that grew about twentyfold while it was being
  measured.
- The live scanner reads the order book's best bid and offer. The backtest used the
  last traded prices, which need recent trades on both sides. The forward ledger will
  show whether that difference matters.
- Nothing here places an order.
