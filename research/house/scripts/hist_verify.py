"""Is the third-party trade archive the same as Kalshi's own record?

Draws random (market, UTC day) pairs from the extracted archive, asks Kalshi for the same market-day
(/historical/trades before the cutoff, /markets/trades after), reduces both to
(minute, taker side, YES price) -> contracts and fills, and compares them exactly.
  python scripts/hist_verify.py [--n 30] [--seed 11]
"""
import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from house.client import ApiError, Kalshi   # noqa: E402
from house.grid import to_units             # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CUTOFF = datetime(2026, 9, 18, tzinfo=timezone.utc)
ap = argparse.ArgumentParser()
ap.add_argument("--n", type=int, default=30)
ap.add_argument("--seed", type=int, default=11)
a = ap.parse_args()

con = duckdb.connect()
con.execute(f"select setseed({a.seed / 100})")
pairs = con.execute(f"""
    with md as (select ticker, cast(minute as date) d, sum(fills) fills from read_parquet('{ROOT}/data/hist/trades/*.parquet') group by 1, 2)
    select ticker, d, fills from md where fills between 3 and 3000 order by random() limit {a.n}""").fetchall()
api = Kalshi(rate=0.3)
report, same = [], 0
for ticker, day, fills in pairs:
    t0 = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    t1 = t0 + timedelta(days=1)
    path = "/historical/trades" if t1 <= CUTOFF else "/markets/trades"
    try:
        trades, complete = api.pages(path, {"ticker": ticker, "min_ts": int(t0.timestamp()), "max_ts": int(t1.timestamp()), "limit": 1000}, "trades", max_pages=6)
    except ApiError as e:
        report.append(dict(ticker=ticker, day=str(day), error=str(e)[:120]))
        print("ERR ", ticker, day, str(e)[:80], flush=True)
        continue
    ours = Counter()
    for minute, taker_yes, px, contracts, n in con.execute(
            f"select epoch(minute)::bigint, taker_yes, yes_px, contracts, fills from read_parquet('{ROOT}/data/hist/trades/{day}.parquet') where ticker = ?", [ticker]).fetchall():
        ours[(minute, taker_yes, px)] += round(contracts * 100)
    theirs, seen = Counter(), set()
    for tr in trades:
        if tr["trade_id"] in seen:
            continue
        seen.add(tr["trade_id"])
        ts = datetime.fromisoformat(tr["created_time"].replace("Z", "+00:00"))
        if not (t0 <= ts < t1):
            continue
        minute = int(ts.timestamp()) // 60 * 60
        px = to_units(tr.get("yes_price_dollars") or tr["yes_price"] / 100)
        theirs[(minute, tr["taker_side"] == "yes", px)] += round(float(tr.get("count_fp") or tr["count"]) * 100)
    ok = complete and ours == theirs
    same += ok
    row = dict(ticker=ticker, day=str(day), endpoint=path, archive_fills=int(fills), kalshi_fills=len(seen), complete=complete,
               archive_contracts=sum(ours.values()) / 100, kalshi_contracts=sum(theirs.values()) / 100, identical=bool(ok),
               only_archive=len(set(ours) - set(theirs)), only_kalshi=len(set(theirs) - set(ours)))
    report.append(row)
    print("SAME" if ok else "DIFF", json.dumps(row), flush=True)
checked = [r for r in report if "error" not in r]
print(f"{same} of {len(checked)} market-days identical; {len(report) - len(checked)} could not be fetched")
json.dump(dict(as_of=datetime.now(timezone.utc).isoformat(timespec="seconds"), seed=a.seed, identical=same, checked=len(checked),
               errors=len(report) - len(checked), rows=report), open(ROOT / "results" / "archive_check.json", "w"), indent=1)
