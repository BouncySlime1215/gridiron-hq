#!/usr/bin/env python3
"""In-game bars for game-winner markets (no outcomes in here).

One row per (ticker, 5-minute bar) from the scheduled start until the milestone's end
plus 30 minutes, with the bar's prices and flow, and the NEXT bar's taker prints (the
prices an order placed at the end of this bar could have been filled at).

    data/ingame/<YYYY-MM-DD>.parquet     keyed by the UTC day of the scheduled start

Usage: python scripts/build_ingame.py [--start 2025-05-01] [--end 2026-11-15]
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
from kalshi_edge import snapshots, taxonomy  # noqa: E402
import build_dataset  # noqa: E402

DATA = ROOT / "data"


def _grp(name: str, side: str) -> str:
    kind, sizes = snapshots.FLOW_GROUPS[name]
    return " + ".join(f"d_{kind}{z}_{side}" for z in sizes)


def process_day(day: str) -> dict:
    import duckdb

    out = DATA / "ingame" / f"{day}.parquet"
    if out.exists():
        return {"day": day, "skipped": True}
    d = dt.date.fromisoformat(day)
    files = [DATA / "bars" / f"{(d + dt.timedelta(n)).isoformat().replace('-', '_')}.parquet" for n in (-1, 0, 1, 2)]
    files = [str(f) for f in files if f.exists()]
    if not files:
        return {"day": day, "rows": 0}
    t0 = time.time()
    con = duckdb.connect()
    con.execute("set threads=2")
    con.execute(f"create temp table ev as {build_dataset.milestone_events_sql()}")
    con.execute(f"""create temp table game as select * from ev
                    where t_start >= timestamptz '{day} 00:00:00+00' and t_start < timestamptz '{day} 00:00:00+00' + interval '1 day'""")
    series = [r[0] for r in con.execute(f"select distinct series from read_parquet({files!r})").fetchall()]
    con.execute("create temp table fam(series varchar)")
    con.executemany("insert into fam values (?)", [(s,) for s in series if taxonomy.family_of(s) == "winner"])
    flows = ",\n".join(f"{_grp(g, s)} as usd_{g}_{s}" for g in snapshots.FLOW_GROUPS for s in ("yes", "no"))
    sql = f"""
    with b as (
        select x.ticker, x.series, x.bucket, x.px_open, x.px_close, x.px_high, x.px_low, x.vwap, x.ask_px, x.bid_px,
               x.dollars, x.n_orders, {flows},
               g.t_start, g.t_end, g.event_ticker, g.milestone_id, g.milestone_type, g.league
        from read_parquet({files!r}) x
        join fam using (series)
        join game g on g.event_ticker = array_to_string(list_slice(string_split(x.ticker, '-'), 1, 2), '-')
        where x.bucket >= g.t_start - interval '30 minutes'
          and x.bucket < coalesce(g.t_end, g.t_start + interval '6 hours') + interval '30 minutes'
    ),
    w as (
        select *,
               lead(bucket) over (partition by ticker order by bucket) as next_bucket,
               lead(ask_px) over (partition by ticker order by bucket) as next_ask,
               lead(bid_px) over (partition by ticker order by bucket) as next_bid,
               lead(dollars) over (partition by ticker order by bucket) as next_usd,
               arg_max(px_close, bucket) filter (where bucket + interval '5 minutes' <= t_start) over (partition by ticker) as pre_close
        from b
    )
    select *, date_diff('minute', t_start, bucket) as mins_in from w where bucket >= t_start
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    con.execute(f"copy ({sql}) to '{tmp}' (format parquet, compression zstd)")
    n = con.execute(f"select count(*) from read_parquet('{tmp}')").fetchall()[0][0]
    tmp.rename(out)
    return {"day": day, "rows": n, "s": round(time.time() - t0, 1)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2025-05-01")
    ap.add_argument("--end", default="2026-11-15")
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args()
    d0, d1 = dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end)
    days = [(d0 + dt.timedelta(n)).isoformat() for n in range((d1 - d0).days + 1)][::-1]
    log = open(DATA / "logs" / "build_ingame.jsonl", "a")
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
