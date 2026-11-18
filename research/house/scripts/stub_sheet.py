"""The live list: minimum-price orders that Kalshi's reward formula pays for, from the newest full pass.

For each side of each rewarded market, the restable order of one target size costing at most
--max-cents a contract with the best reward per dollar (house.stub.best). Keeps those whose reward
until the programme ends is at least --min-total dollars, so the $1.00 minimum payout is cleared.
  python scripts/stub_sheet.py [--max-cents 2] [--min-total 2] [--top 25]
Writes results/stub_sheet.json and data/stub_sheet.parquet. Places nothing.
"""
import argparse
import glob
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from house import stub                         # noqa: E402
from house.grid import UNIT, Grid              # noqa: E402
from house.recorder import NO, YES, Program    # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
D = ROOT / "data"
ap = argparse.ArgumentParser()
ap.add_argument("--max-cents", type=float, default=2.0)
ap.add_argument("--min-total", type=float, default=2.0)
ap.add_argument("--top", type=int, default=25)
a = ap.parse_args()

programs = defaultdict(list)
for line in (D / "programs.jsonl").open():
    r = json.loads(line)
    if r.get("incentive_type") == "liquidity" and r.get("target_size_fp"):
        programs[r["market_ticker"]].append(Program.from_row(r))
grids = {}
for line in (D / "grids.jsonl").open():
    r = json.loads(line)
    grids[r["ticker"]] = Grid.from_market(r["price_ranges"])
files = sorted((D / "books").rglob("*.parquet"))
full = [f for f in files if pd.read_parquet(f, columns=["ticker"]).ticker.nunique() >= 5000][-1]
book = pd.read_parquet(full)
titles = {}
boards = sorted(glob.glob(str(ROOT.parent / "arb" / "data" / "board" / "*" / "markets.parquet")))
if boards:
    t = pd.read_parquet(boards[-1], columns=["ticker", "event_title", "yes_sub", "close_time", "volume_24h"])
    titles = t.set_index("ticker").to_dict("index")

rows = []
for ticker, g in book.groupby("ticker"):
    ts = float(g.ts.iloc[0])
    live = [p for p in programs.get(ticker, ()) if p.start <= ts < p.end and p.target > 0]
    grid = grids.get(ticker)
    if not live or grid is None:
        continue
    prog = max(live, key=lambda p: p.start)
    yes = [(int(p), float(s)) for p, s in zip(g.price[g.side == YES], g["size"][g.side == YES])]
    no = [(int(p), float(s)) for p, s in zip(g.price[g.side == NO], g["size"][g.side == NO])]
    for side in (YES, NO):
        try:
            s = stub.best(yes, no, side, prog.per_day, prog.target, prog.discount, grid, max_price=int(a.max_cents * 100))
        except ValueError:
            continue
        if s is None:
            continue
        days_left = (prog.end - ts) / 86_400
        info = titles.get(ticker, {})
        other = max((p for p, _ in (no if side == YES else yes)), default=0) / UNIT
        rows.append(dict(ticker=ticker, side="YES" if side == YES else "NO", price_cents=s.price / 100, contracts=s.contracts, cost=s.cost,
                         per_day=s.per_day, days_left=days_left, to_end=s.per_day * days_left, pool_per_day=prog.per_day,
                         other_side_best=other, what=f"{info.get('event_title', '')} | {info.get('yes_sub', '')}",
                         market_closes=info.get("close_time"), volume_24h=info.get("volume_24h"), snapshot=ts))
df = pd.DataFrame(rows)
df = df[df.to_end >= a.min_total].copy()
df["per_dollar_day"] = df.per_day / df.cost
df = df.sort_values("per_day", ascending=False)
df.to_parquet(D / "stub_sheet.parquet")
when = datetime.fromtimestamp(float(book.ts.max()), timezone.utc).isoformat(timespec="seconds")
print(f"pass at {when}: {len(df)} orders clear ${a.min_total:.0f} before their programme ends")
tiers = []
for label, d in (("all", df), ("earning $1+/day", df[df.per_day >= 1]), ("earning $3+/day", df[df.per_day >= 3]), ("top 25", df.head(25)), ("top 100", df.head(100))):
    tiers.append(dict(tier=label, orders=len(d), cost=float(d.cost.sum()), per_day=float(d.per_day.sum()), to_end=float(d.to_end.sum())))
    print(f"  {label:<16} {len(d):>5} orders  tie up ${d.cost.sum():>8,.0f}  reward ${d.per_day.sum():>7,.0f}/day  ${d.to_end.sum():>8,.0f} until their programmes end")
pd.set_option("display.width", 250)
pd.set_option("display.max_colwidth", 60)
print(df.head(a.top)[["ticker", "side", "price_cents", "contracts", "cost", "per_day", "days_left", "other_side_best", "what"]].round(2).to_string(index=False))
json.dump(dict(snapshot=when, max_cents=a.max_cents, min_total=a.min_total, tiers=tiers,
               top=df.head(100).round(4).to_dict("records")), open(ROOT / "results" / "stub_sheet.json", "w"), indent=1)
