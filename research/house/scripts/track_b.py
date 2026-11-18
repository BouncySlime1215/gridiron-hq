"""Track B of GATE.md: does a reward last from one full pass to the next?

For every pair of consecutive full passes (keyframes): take each side-market where $50 at the
reference price earned at least 1% a day at the first pass, and value the same order, left at
the same price, against the book at the second pass. Also what the better of staying put or
re-posting at the new reference would earn.   python scripts/track_b.py [--dollars 50] [--min-yield 0.01]
"""
import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from house.grid import Grid                      # noqa: E402
from house.persist import NO, YES, newcomer      # noqa: E402
from house.recorder import Program               # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
ap = argparse.ArgumentParser()
ap.add_argument("--dollars", type=float, default=50.0)
ap.add_argument("--min-yield", type=float, default=0.01)
ap.add_argument("--data", default=str(ROOT / "data"))
a = ap.parse_args()
D = Path(a.data)

programs = defaultdict(list)
for line in (D / "programs.jsonl").open():
    r = json.loads(line)
    if r.get("incentive_type") == "liquidity" and r.get("target_size_fp"):
        programs[r["market_ticker"]].append(Program.from_row(r))
grids = {}
for line in (D / "grids.jsonl").open():
    r = json.loads(line)
    grids[r["ticker"]] = Grid.from_market(r["price_ranges"])


def active(ticker: str, ts: float):
    live = [p for p in programs.get(ticker, ()) if p.start <= ts < p.end and p.target > 0]
    return max(live, key=lambda p: p.start) if live else None


def load(path: Path) -> dict:
    df = pd.read_parquet(path)
    out = {}
    for ticker, g in df.groupby("ticker"):
        out[ticker] = (float(g.ts.iloc[0]),
                       [(int(p), float(s)) for p, s in zip(g.price[g.side == YES], g["size"][g.side == YES])],
                       [(int(p), float(s)) for p, s in zip(g.price[g.side == NO], g["size"][g.side == NO])])
    return out


files = sorted((D / "books").rglob("*.parquet"))
keyframes = [f for f in files if pd.read_parquet(f, columns=["ticker"]).ticker.nunique() >= 5000]
print(len(files), "book files,", len(keyframes), "full passes:", [f.stem for f in keyframes])
report = []


def when(f: Path) -> float:
    return datetime.strptime(f.parent.name + f.stem, "%Y-%m-%d%H%M%S").replace(tzinfo=timezone.utc).timestamp()


# each pass against the next one, and against the first pass at least 24 and 72 hours later
pairs = list(zip(keyframes, keyframes[1:]))
for hours in (24, 72):
    for fa in keyframes:
        later = [f for f in keyframes if when(f) - when(fa) >= hours * 3600]
        if later and (fa, later[0]) not in pairs:
            pairs.append((fa, later[0]))
for fa, fb in pairs:
    A, B = load(fa), load(fb)
    rows = []
    for ticker, (ts_a, yes_a, no_a) in A.items():
        prog, grid = active(ticker, ts_a), grids.get(ticker)
        if prog is None or grid is None:
            continue
        for side in (YES, NO):
            try:
                y0, price, contracts = newcomer(yes_a, no_a, side, a.dollars, prog.per_day, prog.target, prog.discount, grid)
            except ValueError:
                continue
            if y0 < a.min_yield:
                continue
            y1 = y1r = 0.0
            gone = "market not in the later pass"
            if ticker in B:
                ts_b, yes_b, no_b = B[ticker]
                later = active(ticker, ts_b)
                gone = "programme ended"
                if later is not None:
                    try:
                        y1 = newcomer(yes_b, no_b, side, a.dollars, later.per_day, later.target, later.discount, grid, price=price)[0]
                        y1r = max(y1, newcomer(yes_b, no_b, side, a.dollars, later.per_day, later.target, later.discount, grid)[0])
                    except ValueError:
                        pass
                    gone = "" if y1 > 0 else "order no longer counts"
            mid_b = bid_b = None
            if ticker in B and B[ticker][1] and B[ticker][2]:      # YES midpoint at the later pass, for marking fills
                mid_b = (max(p for p, _ in B[ticker][1]) + 10_000 - max(p for p, _ in B[ticker][2])) / 2 / 10_000
            if ticker in B and B[ticker][1 if side == YES else 2]:  # what the position could be sold for there: the best bid on its own side
                bid_b = max(p for p, _ in B[ticker][1 if side == YES else 2]) / 10_000
            rows.append(dict(ticker=ticker, side=side, price=price, contracts=contracts, ts_a=ts_a,
                             ts_b=B[ticker][0] if ticker in B else np.nan, mid_b=mid_b, bid_b=bid_b, y0=y0, y1=y1, y1r=y1r, gone=gone,
                             hours=(B[ticker][0] - ts_a) / 3600 if ticker in B else np.nan, age_h=(ts_a - prog.start) / 3600))
    df = pd.DataFrame(rows)
    if df.empty:
        continue
    (D / "track_b").mkdir(exist_ok=True)
    df.to_parquet(D / "track_b" / f"{fa.parent.name}_{fa.stem}__{fb.parent.name}_{fb.stem}.parquet")
    hours = float(df.hours.median())
    out = dict(first=f"{fa.parent.name} {fa.stem}", second=f"{fb.parent.name} {fb.stem}", hours_between=round(hours, 2), side_markets=len(df),
               entry_yield_mean=float(df.y0.mean()), entry_yield_median=float(df.y0.median()),
               later_yield_mean_unmoved=float(df.y1.mean()), later_yield_median_unmoved=float(df.y1.median()),
               later_yield_mean_reposted=float(df.y1r.mean()),
               kept_fraction_of_yield=float(df.y1.sum() / df.y0.sum()),
               still_at_least_min=float((df.y1 >= a.min_yield).mean()), earning_nothing=float((df.y1 == 0).mean()),
               why_nothing=df[df.y1 == 0].gone.value_counts().to_dict())
    report.append(out)
    print(json.dumps(out, indent=1))
    df["bucket"] = pd.cut(df.y0, [0.01, 0.02, 0.05, 0.10, 0.25, 10], include_lowest=True)
    print(df.groupby("bucket", observed=True).agg(n=("y0", "size"), entry=("y0", "mean"), later=("y1", "mean"), reposted=("y1r", "mean"),
                                                   zero=("y1", lambda z: (z == 0).mean())).round(4).to_string())
json.dump(dict(as_of=datetime.now(timezone.utc).isoformat(timespec="seconds"), dollars=a.dollars, min_yield=a.min_yield, pairs=report),
          open(ROOT / "results" / "track_b.json", "w"), indent=1)
