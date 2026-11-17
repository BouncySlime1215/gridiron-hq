#!/usr/bin/env python3
"""In-game minutes for game-winner markets, each paired with the NEXT minute's first prints.

    data/ingame_min/<YYYY-MM-DD>.parquet      keyed by the UTC day of the scheduled start

A row is what was knowable at the end of one in-game minute (prices, flow by class,
running totals, price 5 and 15 minutes earlier, the pre-game close) plus what an order
sent then could have met: the first YES-taker and NO-taker prints of the following
minute (nx_ask_first, nx_bid_first) and how far away that minute was (nx_gap_min).
The nx_* columns are execution outcomes, never model inputs. No results in here.

Usage: python scripts/build_ingame_min.py [--start 2025-09-01] [--end 2026-11-15]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import multiprocessing as mp
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import build_dataset  # noqa: E402

DATA = ROOT / "data"
FLOWS = [f"usd_{k}_{s}" for k in ("rb", "fx", "in", "inl") for s in ("yes", "no")]


def process_day(day: str) -> dict:
    import duckdb

    out = DATA / "ingame_min" / f"{day}.parquet"
    if out.exists():
        return {"day": day, "skipped": True}
    d = dt.date.fromisoformat(day)
    files = [DATA / "min1" / f"{(d + dt.timedelta(n)).isoformat().replace('-', '_')}.parquet" for n in (-1, 0, 1, 2)]
    files = [str(f) for f in files if f.exists()]
    if not files:
        return {"day": day, "rows": 0, "note": "no minute files"}
    t0 = time.time()
    con = duckdb.connect()
    con.execute("set threads=2")
    con.execute(f"create temp table ev as {build_dataset.milestone_events_sql()}")
    con.execute(f"""create temp table game as select * from ev
                    where t_start >= timestamptz '{day} 00:00:00+00' and t_start < timestamptz '{day} 00:00:00+00' + interval '1 day'""")
    cum = ",\n".join(f"sum({c}) filter (where bucket >= t_start) over (partition by ticker order by bucket) as cum_{c}" for c in FLOWS)
    sql = f"""
    with b as (
        select x.*, g.t_start, g.t_end, g.event_ticker, g.milestone_id, g.milestone_type, g.league
        from read_parquet({files!r}) x
        join game g on g.event_ticker = array_to_string(list_slice(string_split(x.ticker, '-'), 1, 2), '-')
        where x.bucket >= g.t_start - interval '60 minutes'
          and x.bucket < coalesce(g.t_end, g.t_start + interval '6 hours') + interval '90 minutes'
    ),
    w as (
        select *,
               lead(bucket) over t as nx_bucket,
               lead(ask_first) over t as nx_ask_first,
               lead(bid_first) over t as nx_bid_first,
               lead(ask_first_sec) over t as nx_ask_first_sec,
               lead(bid_first_sec) over t as nx_bid_first_sec,
               lead(px_low) over t as nx_low,
               lead(px_high) over t as nx_high,
               lead(dollars) over t as nx_usd,
               arg_max(vwap, bucket) filter (where bucket < t_start) over (partition by ticker) as pre_close,
               first_value(vwap) over (partition by ticker order by bucket range between interval '5 minutes' preceding and current row) as vwap_5m,
               first_value(vwap) over (partition by ticker order by bucket range between interval '15 minutes' preceding and current row) as vwap_15m,
               max(px_high) over (partition by ticker order by bucket range between interval '15 minutes' preceding and current row) as high_15m,
               min(px_low) over (partition by ticker order by bucket range between interval '15 minutes' preceding and current row) as low_15m,
               sum(dollars) over (partition by ticker order by bucket range between interval '5 minutes' preceding and current row) as usd_5m,
               sum(usd_in_yes - usd_in_no) over (partition by ticker order by bucket range between interval '5 minutes' preceding and current row) as in_net_5m,
               sum(usd_rb_yes - usd_rb_no) over (partition by ticker order by bucket range between interval '5 minutes' preceding and current row) as rb_net_5m,
               sum(usd_fx_yes - usd_fx_no) over (partition by ticker order by bucket range between interval '5 minutes' preceding and current row) as fx_net_5m,
               sum(dollars) filter (where bucket >= t_start) over (partition by ticker order by bucket) as cum_usd,
               {cum}
        from b
        window t as (partition by ticker order by bucket)
    )
    select *, date_diff('minute', t_start, bucket) as mins_in,
           date_diff('minute', bucket, nx_bucket) as nx_gap_min
    from w where bucket >= t_start
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    con.execute(f"copy ({sql}) to '{tmp}' (format parquet, compression zstd)")
    n = con.execute(f"select count(*) from read_parquet('{tmp}')").fetchall()[0][0]
    tmp.rename(out)
    return {"day": day, "rows": n, "s": round(time.time() - t0, 1)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2025-09-01")
    ap.add_argument("--end", default="2026-11-15")
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args()
    d0, d1 = dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end)
    days = [(d0 + dt.timedelta(n)).isoformat() for n in range((d1 - d0).days + 1)][::-1]
    log = open(DATA / "logs" / "build_ingame_min.jsonl", "a")
    t0 = time.time()
    with mp.Pool(a.workers) as pool:
        for i, res in enumerate(pool.imap_unordered(process_day, days), 1):
            log.write(json.dumps(res) + "\n")
            log.flush()
            if i % 25 == 0 or i <= 2:
                print(time.strftime("%H:%M:%S"), f"{i}/{len(days)}", res, f"{(time.time()-t0)/60:.1f} min", flush=True)
    print("done", round((time.time() - t0) / 60, 1), "min", flush=True)


if __name__ == "__main__":
    main()
