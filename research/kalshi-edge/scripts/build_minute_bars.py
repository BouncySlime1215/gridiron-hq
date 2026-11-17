#!/usr/bin/env python3
"""Second pass over the public tape: one-minute bars with first prints, game-winner series only.

    data/min1/<YYYY_MM_DD>.parquet

Same source and same download-reduce-delete loop as build_bars.py. Winner markets are
where in-game volume is, and one-minute first prints are what an in-game order can
actually be filled against (see tape.minute_bars_sql).

Usage: python scripts/build_minute_bars.py [--start 2025-09-01] [--end 2026-11-15]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import multiprocessing as mp
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from kalshi_edge import tape, taxonomy  # noqa: E402
import build_bars  # noqa: E402

DATA = ROOT / "data"


def process_day(args) -> dict:
    day, sched, winners, threads = args
    import duckdb

    name = day.replace("-", "_")
    out = DATA / "min1" / f"{name}.parquet"
    if out.exists():
        return {"day": day, "skipped": True}
    raw = DATA / "raw_dl" / f"m_{name}.parquet"
    raw.parent.mkdir(parents=True, exist_ok=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    tmp = raw.with_suffix(".part")
    r = subprocess.run(["curl", "-sS", "-L", "--fail", "--retry", "4", "--retry-delay", "3", "-m", "900",
                        "-o", str(tmp), f"{build_bars.HF}/daily/{name}.parquet"], capture_output=True, text=True)
    if r.returncode != 0:
        tmp.unlink(missing_ok=True)
        return {"day": day, "error": f"download failed: {r.stderr.strip()[:200]}"}
    tmp.rename(raw)
    t1 = time.time()
    con = duckdb.connect()
    con.execute(f"set threads={threads}")
    con.execute("set preserve_insertion_order=false")
    con.execute("create table fee(series varchar, taker_rate double)")
    con.executemany("insert into fee values (?, ?)",
                    [(s, build_bars.rate_on(sched[s], day + "T23:59:59Z")) for s in winners])
    tmp_out = out.with_suffix(".tmp")
    con.execute(f"copy ({tape.minute_bars_sql(f"read_parquet('{raw}')", 'fee')}) to '{tmp_out}' (format parquet, compression zstd)")
    n = con.execute(f"select count(*), coalesce(sum(dollars), 0) from read_parquet('{tmp_out}')").fetchall()[0]
    con.close()
    tmp_out.rename(out)
    raw.unlink()
    return {"day": day, "rows": n[0], "dollars": round(n[1]), "mb": round(out.stat().st_size / 1e6, 1),
            "dl_s": round(t1 - t0, 1), "proc_s": round(time.time() - t1, 1)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2025-09-01")
    ap.add_argument("--end", default="2026-11-15")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--threads", type=int, default=2)
    a = ap.parse_args()
    manifest = json.load(open(DATA / "raw_dl" / "manifest.json"))
    have = {k.split("/")[-1].replace(".parquet", "").replace("_", "-") for k in manifest["files"]}
    d0, d1 = dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end)
    days = [(d0 + dt.timedelta(n)).isoformat() for n in range((d1 - d0).days + 1)]
    days = [d for d in days if d in have][::-1]
    sched = build_bars.fee_schedule()
    winners = [s for s in sched if taxonomy.family_of(s) == "winner"]
    print(f"{len(winners)} winner series, {len(days)} days", flush=True)
    log = open(DATA / "logs" / "build_minute_bars.jsonl", "a")
    t0 = time.time()
    with mp.Pool(a.workers) as pool:
        for i, res in enumerate(pool.imap_unordered(process_day, [(d, sched, winners, a.threads) for d in days]), 1):
            log.write(json.dumps(res) + "\n")
            log.flush()
            if "error" in res or i % 20 == 0 or i <= 2:
                print(time.strftime("%H:%M:%S"), f"{i}/{len(days)}", res, f"{(time.time()-t0)/60:.1f} min", flush=True)
    print("done", round((time.time() - t0) / 60, 1), "min", flush=True)


if __name__ == "__main__":
    main()
