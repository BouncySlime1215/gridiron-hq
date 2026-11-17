"""Settlement results for rewarded markets that traded during a reward window, biggest first.

Markets settled before Kalshi's historical cutoff are served by /historical/markets, later ones by
/markets; each batch is asked of the likelier endpoint and the leftovers of the other.
Appends to data/hist/results.jsonl and can be stopped and restarted.
  python scripts/hist_results.py [--top 60000] [--rate 0.125]
"""
import argparse
import json
import sys
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from house.client import ApiError, Kalshi   # noqa: E402

ROOT = Path(__file__).resolve().parents[1] / "data" / "hist"
CUTOFF = "2026-09-18"

ap = argparse.ArgumentParser()
ap.add_argument("--top", type=int, default=60_000)
ap.add_argument("--rate", type=float, default=0.125)
a = ap.parse_args()

out = ROOT / "results.jsonl"
have = {json.loads(line)["ticker"] for line in out.open()} if out.exists() else set()
con = duckdb.connect()
rows = con.execute(f"""
    select w.ticker, sum(w.taker_dollars) d, max(p."end") < timestamptz '{CUTOFF}' as old
    from read_parquet('{ROOT}/windows.parquet') w join read_parquet('{ROOT}/programs_2026-11-17.parquet') p on p.id = w.id
    where w.contracts > 0 group by 1 order by d desc limit {a.top}""").fetchall()
todo = [(t, old) for t, _, old in rows if t not in have]
print(len(rows), "wanted,", len(todo), "to fetch", flush=True)
api = Kalshi(rate=a.rate)


def ask(path: str, tickers: list[str]) -> dict:
    try:
        ms = api.get(path, {"tickers": ",".join(tickers), "limit": 1000})["markets"]
    except ApiError as e:
        print("failed", path, str(e)[:120], flush=True)
        return {}
    return {m["ticker"]: m for m in ms}


for group, first, second in ((True, "/historical/markets", "/markets"), (False, "/markets", "/historical/markets")):
    tickers = [t for t, old in todo if old == group]
    for i in range(0, len(tickers), 100):
        chunk = tickers[i:i + 100]
        got = ask(first, chunk)
        missing = [t for t in chunk if t not in got]
        if len(missing) >= 5:
            got.update(ask(second, missing))
        with out.open("a") as f:
            for t in chunk:
                m = got.get(t)
                f.write(json.dumps({"ticker": t, "found": m is not None, "status": (m or {}).get("status"),
                                    "result": (m or {}).get("result"), "value": (m or {}).get("settlement_value_dollars"),
                                    "close": (m or {}).get("close_time"), "event": (m or {}).get("event_ticker")}) + "\n")
        if (i // 100) % 20 == 0:
            print(f"{'old' if group else 'new'} {i + len(chunk)}/{len(tickers)} throttled {api.throttled}", flush=True)
