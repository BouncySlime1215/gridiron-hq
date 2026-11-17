#!/usr/bin/env python3
"""One pass over the public Kalshi trade tape -> 5-minute flow bars for sports markets.

Source: the Hugging Face dataset TimeSeventeen/Kalshi, one Parquet of every
(non-combo) fill per UTC day. Each day is downloaded, reduced to bars with
kalshi_edge.tape.bars_sql, and deleted, so the raw tape (about 73 GB) never has
to fit on disk. Output: data/bars/<YYYY_MM_DD>.parquet (gitignored).

The source's own README is explicit that it is a third-party archive and not a
proof of completeness; a day it lists as missing is reported, never treated as
a day with no trading.

Usage: python scripts/build_bars.py [--start 2025-01-01] [--end 2026-11-15] [--workers 3]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import multiprocessing as mp
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from kalshi_edge import fees, tape  # noqa: E402

DATA = ROOT / "data"
HF = "https://huggingface.co/datasets/TimeSeventeen/Kalshi/resolve/main"


def fee_schedule() -> dict[str, list[tuple[str, float]]]:
    """series -> [(effective_from_iso, taker_rate)], oldest first.

    Before a series' first recorded change it is priced at the base 7% rate.
    """
    series = json.load(open(DATA / "meta" / "series_sports.json"))["series"]
    changes_path = DATA / "meta" / "fee_changes.json"
    changes = json.load(open(changes_path)) if changes_path.exists() else []
    sports = {s["ticker"] for s in series}
    by_series: dict[str, list[tuple[str, float]]] = {}
    for ch in sorted(changes, key=lambda c: c["scheduled_ts"]):
        if ch["series_ticker"] not in sports:
            continue  # combo and non-sports series are outside this study; an unknown sports fee type still raises
        rate, _ = fees.series_rates(ch)
        by_series.setdefault(ch["series_ticker"], []).append((ch["scheduled_ts"], rate))
    out = {}
    for s in series:
        hist = [("0000", fees.TAKER_BASE)] + by_series.get(s["ticker"], [])
        if s["ticker"] not in by_series:
            hist = [("0000", fees.series_rates(s)[0])]
        out[s["ticker"]] = hist
    return out


def rate_on(hist: list[tuple[str, float]], day_iso: str) -> float:
    rate = hist[0][1]
    for since, r in hist:
        if since <= day_iso:
            rate = r
    return rate


def process_day(args: tuple[str, dict, int]) -> dict:
    day, sched, threads = args
    import duckdb  # imported in the worker

    name = day.replace("-", "_")
    out = DATA / "bars" / f"{name}.parquet"
    if out.exists():
        return {"day": day, "skipped": True}
    raw = DATA / "raw_dl" / f"{name}.parquet"
    raw.parent.mkdir(parents=True, exist_ok=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    if not raw.exists():
        tmp = raw.with_suffix(".part")
        r = subprocess.run(["curl", "-sS", "-L", "--fail", "--retry", "4", "--retry-delay", "3", "-m", "900",
                            "-o", str(tmp), f"{HF}/daily/{name}.parquet"], capture_output=True, text=True)
        if r.returncode != 0:
            tmp.unlink(missing_ok=True)
            return {"day": day, "error": f"download failed: {r.stderr.strip()[:200]}"}
        tmp.rename(raw)
    t1 = time.time()
    con = duckdb.connect()
    con.execute(f"set threads={threads}")
    con.execute("set preserve_insertion_order=false")
    con.execute("create table fee(series varchar, taker_rate double)")
    con.executemany("insert into fee values (?, ?)", [(s, rate_on(h, day + "T23:59:59Z")) for s, h in sched.items()])
    n_all = con.execute(f"select count(*) from read_parquet('{raw}')").fetchall()[0][0]
    tmp_out = out.with_suffix(".tmp")
    con.execute(f"copy ({tape.bars_sql(f"read_parquet('{raw}')", 'fee')}) to '{tmp_out}' (format parquet, compression zstd)")
    stats = con.execute(f"select count(*), coalesce(sum(n_fills),0), coalesce(sum(n_orders),0), count(distinct ticker), "
                        f"coalesce(sum(dollars),0) from read_parquet('{tmp_out}')").fetchall()[0]
    con.close()
    tmp_out.rename(out)
    raw.unlink()
    return {"day": day, "fills_all": n_all, "bars": stats[0], "fills_sports": int(stats[1]), "orders": int(stats[2]),
            "tickers": stats[3], "dollars": round(stats[4]), "mb": round(out.stat().st_size / 1e6, 1),
            "dl_s": round(t1 - t0, 1), "proc_s": round(time.time() - t1, 1)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2025-01-01")
    ap.add_argument("--end", default="2026-11-15")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--oldest-first", action="store_true")
    a = ap.parse_args()

    manifest = json.load(open(DATA / "raw_dl" / "manifest.json"))
    have = {k.split("/")[-1].replace(".parquet", "").replace("_", "-") for k in manifest["files"]}
    d0, d1 = dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end)
    days = [(d0 + dt.timedelta(n)).isoformat() for n in range((d1 - d0).days + 1)]
    missing = [d for d in days if d not in have]
    if missing:
        print(f"{len(missing)} days in range are absent from the source archive (not treated as zero): "
              f"{missing[:5]}{'...' if len(missing) > 5 else ''}", flush=True)
    days = [d for d in days if d in have]
    if not a.oldest_first:
        days.reverse()
    sched = fee_schedule()
    log = open(DATA / "logs" / "build_bars.jsonl", "a")
    t0 = time.time()
    done = 0
    with mp.Pool(a.workers) as pool:
        for res in pool.imap_unordered(process_day, [(d, sched, a.threads) for d in days]):
            done += 1
            log.write(json.dumps(res) + "\n")
            log.flush()
            if "error" in res or done % 10 == 0 or done <= 3:
                print(time.strftime("%H:%M:%S"), f"{done}/{len(days)}", res, f"elapsed {(time.time()-t0)/60:.1f} min", flush=True)
    print("done", done, "days in", round((time.time() - t0) / 60, 1), "min", flush=True)


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    main()
