"""Pool every Track B fill sample: reward against fills, by the price the order rested at.

Reads the per-order files written by track_b_fills.py. Per-day figures are per dollar resting.
The interval is a bootstrap over events (a market's ticker without its last part).
  python scripts/track_b_pool.py [--boot 4000]
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
ap = argparse.ArgumentParser()
ap.add_argument("--boot", type=int, default=4000)
ap.add_argument("--dollars", type=float, default=50.0)
a = ap.parse_args()

files = sorted((ROOT / "data" / "track_b_fills").glob("*.parquet"))
o = pd.concat([pd.read_parquet(f) for f in files]).drop_duplicates(["pair", "ticker", "side"])
o["event"] = o.ticker.str.rsplit("-", n=1).str[0]
o["days"] = (o.ts_b - o.ts_a) / 86_400
o["bucket"] = pd.cut(o.price / 10_000, [0, 0.10, 0.25, 0.75, 1.0], labels=["10c and under", "10-25c", "25-75c", "over 75c"])


def line(d: pd.DataFrame, label: str) -> dict:
    g = d.groupby("event").agg(rest=("days", lambda z: a.dollars * z.sum()), reward=("reward", "sum"), cost=("cost", "sum"),
                               bid=("pnl_at_bid", "sum"), mid=("pnl", "sum"))
    pick = np.random.default_rng(1).integers(0, len(g), size=(a.boot, len(g)))
    rest = g.rest.values[pick].sum(1)
    net = (g.reward.values + g.bid.values)[pick].sum(1) / rest * 100
    row = dict(label=label, orders=len(d), events=len(g), filled_orders=int((d.cost > 0).sum()),
               reward_pct_per_day=float(100 * g.reward.sum() / g.rest.sum()), filled_pct_per_day=float(100 * g.cost.sum() / g.rest.sum()),
               fill_pnl_at_bid_pct_of_filled=float(100 * g.bid.sum() / g.cost.sum()) if g.cost.sum() else None,
               fill_pnl_at_mid_pct_of_filled=float(100 * g.mid.sum() / g.cost.sum()) if g.cost.sum() else None,
               net_at_bid_pct_per_day=float(100 * (g.reward.sum() + g.bid.sum()) / g.rest.sum()),
               net_at_mid_pct_per_day=float(100 * (g.reward.sum() + g.mid.sum()) / g.rest.sum()),
               net_at_bid_ci=[float(np.percentile(net, 2.5)), float(np.percentile(net, 97.5))])
    f = lambda v: "   n/a" if v is None else f"{v:+6.1f}"
    print(f"{label:<14} orders {row['orders']:>5} filled {row['filled_orders']:>4}  reward {row['reward_pct_per_day']:5.2f}%/day  "
          f"filled {row['filled_pct_per_day']:5.1f}%/day  fills made {f(row['fill_pnl_at_bid_pct_of_filled'])}% at bid, "
          f"{f(row['fill_pnl_at_mid_pct_of_filled'])}% at mid  net {row['net_at_bid_pct_per_day']:+6.2f}%/day "
          f"[{row['net_at_bid_ci'][0]:+.2f}, {row['net_at_bid_ci'][1]:+.2f}] at bid, {row['net_at_mid_pct_per_day']:+.2f} at mid")
    return row


print(len(files), "samples,", o.pair.nunique(), "pairs of passes,", o.ticker.nunique(), "markets")
rows = [line(o, "all")] + [line(d, str(b)) for b, d in o.groupby("bucket", observed=True)]
json.dump(dict(as_of=datetime.now(timezone.utc).isoformat(timespec="seconds"), samples=[f.stem for f in files], rows=rows),
          open(ROOT / "results" / "track_b_pool.json", "w"), indent=1)
