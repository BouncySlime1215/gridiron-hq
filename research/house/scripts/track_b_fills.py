"""Pessimistic fills for Track B orders, from Kalshi's own trades endpoint.

For one pair of passes saved by track_b.py: draw a random sample of the selected markets, fetch
the public trades between the two passes, fill each never-moved order by any trade at its price
or worse (house.shadow.fills), and mark the fills at the later pass's quote midpoint.
  python scripts/track_b_fills.py data/track_b/<pair>.parquet [--markets 40] [--seed 5]

Ticker-filtered trade queries have their own small allowance for callers without a key: on
2026-11-17 it ran dry after roughly 150 requests and answered 429 to every one for at least ten
minutes while every other endpoint kept working. So this asks slowly, gives up after five
refusals in a row, and reports on however many markets it reached. For anything larger, use the
daily archive (scripts/hist_extract.py) once it covers the hours in question.
"""
import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from house import shadow                    # noqa: E402
from house.client import ApiError, Kalshi   # noqa: E402
from house.grid import to_units             # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
ap = argparse.ArgumentParser()
ap.add_argument("pair")
ap.add_argument("--markets", type=int, default=40)
ap.add_argument("--seed", type=int, default=5)
ap.add_argument("--skip", type=int, default=0, help="start this far down the same shuffled list, to extend a sample")
ap.add_argument("--dollars", type=float, default=50.0)
ap.add_argument("--budget", type=float, default=400.0, help="seconds to spend asking Kalshi before working with what was reached")
a = ap.parse_args()

sel = pd.read_parquet(a.pair)
sel = sel[sel.ts_b.notna()]
tickers = sorted(sel.ticker.unique())
pick = sorted(np.random.default_rng(a.seed).permutation(tickers)[a.skip:a.skip + a.markets])
sel = sel[sel.ticker.isin(pick)].copy()
api, trades, failed, refused, reached = Kalshi(rate=0.2), [], 0, 0, []
cache = ROOT / "data" / "trades_cache" / Path(a.pair).stem      # what Kalshi has already told us is never asked for twice
cache.mkdir(parents=True, exist_ok=True)
began = time.time()
for t in pick:
    kept = cache / f"{t}.json"
    if kept.exists():
        trades += json.loads(kept.read_text())
        reached.append(t)
        continue
    if refused >= 5 or time.time() - began > a.budget:
        continue
    lo, hi = sel[sel.ticker == t].ts_a.min(), sel[sel.ticker == t].ts_b.max()
    got, params = [], {"ticker": t, "min_ts": int(lo), "max_ts": int(hi) + 1, "limit": 1000}
    try:
        for _ in range(5):                       # a short page is the last page; do not spend a request to learn that
            d = api.get("/markets/trades", params, tries=2)
            got += d.get("trades") or []
            if len(d.get("trades") or []) < 1000 or not d.get("cursor"):
                break
            params["cursor"] = d["cursor"]
    except ApiError:
        failed += 1
        refused += 1
        continue
    refused = 0
    reached.append(t)
    seen, mine = set(), []
    for tr in got:
        if tr["trade_id"] in seen:
            continue
        seen.add(tr["trade_id"])
        mine.append(dict(ticker=t, ts=datetime.fromisoformat(tr["created_time"].replace("Z", "+00:00")).timestamp(),
                         taker_yes=tr["taker_side"] == "yes", yes_px=to_units(tr.get("yes_price_dollars") or tr["yes_price"] / 100),
                         contracts=float(tr.get("count_fp") or tr["count"])))
    kept.write_text(json.dumps(mine))
    trades += mine
trades = pd.DataFrame(trades, columns=["ticker", "ts", "taker_yes", "yes_px", "contracts"])
sel = sel[sel.ticker.isin(reached)].copy()
pos = sel.rename(columns={"ts_a": "ts", "price": "ref"}).assign(dt=lambda d: d.ts_b - d.ts)
f = shadow.fills(pos, trades)
if len(f):
    f = f.merge(sel[["ticker", "side", "mid_b", "bid_b"]], on=["ticker", "side"])
    f = shadow.mark(f[f.mid_b.notna()].reset_index(drop=True), f[f.mid_b.notna()].mid_b.reset_index(drop=True))
    # the cautious mark: what the filled contracts could be sold for at the later pass (nothing if there is no bid)
    f["pnl_at_bid"] = f.filled * (f.bid_b.fillna(0.0) - f.price / 10_000)
    print(f[["ticker", "side", "price", "filled", "cost", "mid_b", "bid_b", "pnl", "pnl_at_bid"]].round(3).to_string())
hours = float((sel.ts_b - sel.ts_a).median() / 3600)
sel["reward"] = (sel.y0 + sel.y1) / 2 * a.dollars * (sel.ts_b - sel.ts_a) / 86_400
reward = float(sel.reward.sum())
# one row per order, filled or not, kept so that samples can be pooled later
cols = ["ticker", "side", "filled", "cost", "pnl", "pnl_at_bid"]
orders = sel.merge(f[cols] if len(f) else pd.DataFrame(columns=cols), on=["ticker", "side"], how="left").fillna(
    {"filled": 0.0, "cost": 0.0, "pnl": 0.0, "pnl_at_bid": 0.0})
orders["pair"] = Path(a.pair).stem
(ROOT / "data" / "track_b_fills").mkdir(exist_ok=True)
orders.to_parquet(ROOT / "data" / "track_b_fills" / f"{Path(a.pair).stem}_s{a.seed}_k{a.skip}.parquet")
out = dict(pair=Path(a.pair).stem, as_of=datetime.now(timezone.utc).isoformat(timespec="seconds"), hours=round(hours, 2),
           markets_sampled=len(pick), markets_reached=len(reached), markets_failed=failed, orders=len(sel), dollars_resting=float(len(sel) * a.dollars),
           trades_seen=len(trades), markets_with_a_trade=int(trades.ticker.nunique()) if len(trades) else 0,
           orders_filled=int(len(f)), dollars_filled=float(f.cost.sum()) if len(f) else 0.0,
           fill_pnl_at_later_mid=float(f.pnl.sum()) if len(f) else 0.0,
           fill_pnl_at_later_bid=float(f.pnl_at_bid.sum()) if len(f) else 0.0, reward_accrued=reward, seed=a.seed, skip=a.skip)
out["net_at_bid"] = out["reward_accrued"] + out["fill_pnl_at_later_bid"]
out["net_if_every_fill_is_a_total_loss"] = out["reward_accrued"] - out["dollars_filled"]
per_day = 100 / out["dollars_resting"] * 24 / hours if out["dollars_resting"] else 0.0
out["reward_pct_per_day"] = out["reward_accrued"] * per_day
out["filled_pct_per_day"] = out["dollars_filled"] * per_day
out["net_at_bid_pct_per_day"] = out["net_at_bid"] * per_day
print(json.dumps(out, indent=1))
path = ROOT / "results" / "track_b_fills.json"
prior = json.loads(path.read_text()) if path.exists() else []
path.write_text(json.dumps([p for p in prior if (p["pair"], p.get("seed"), p.get("skip")) != (out["pair"], a.seed, a.skip)] + [out], indent=1))
