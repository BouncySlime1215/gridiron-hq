"""Trades in every market that has ever carried a liquidity reward, from the public daily archive.

One output file per UTC day: (ticker, minute, taker_side, yes_px) -> contracts, fills.
The archive is third-party (TimeSeventeen/Kalshi on Hugging Face); scripts/hist_verify.py checks it
against Kalshi's own trades endpoint.   python scripts/hist_extract.py [--workers 3] [--since 2025-09-17]
"""
import argparse
import json
import subprocess
import sys
import urllib.request
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1] / "data" / "hist"
HF = "https://huggingface.co/datasets/TimeSeventeen/Kalshi/resolve/main"


def one_day(day: str, key: str) -> tuple[str, int, int]:
    out = ROOT / "trades" / f"{day}.parquet"
    if out.exists():
        return day, -1, -1
    raw = ROOT / "raw" / f"{day}.parquet"
    raw.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["curl", "-sS", "-L", "--fail", "--retry", "5", "--retry-delay", "5", "-C", "-", "-o", str(raw), f"{HF}/{key}"], check=True)
    con = duckdb.connect()
    con.execute("set threads=1; set memory_limit='3GB'")
    n_all = con.execute(f"select count(*) from read_parquet('{raw}')").fetchall()[0][0]
    tmp = out.with_suffix(".tmp")
    con.execute(f"""
        copy (
          select t.ticker,
                 date_trunc('minute', t.created_time) as minute,
                 t.taker_side = 'yes' as taker_yes,
                 cast(round(coalesce(try_cast(t.yes_price_dollars as double), t.yes_price / 100.0) * 10000) as integer) as yes_px,
                 sum(t.count) as contracts, count(*) as fills
          from read_parquet('{raw}') t
          semi join read_parquet('{ROOT / "prog_tickers.parquet"}') p on t.ticker = p.ticker
          group by all
        ) to '{tmp}' (format parquet, compression zstd)""")
    n = con.execute(f"select coalesce(sum(fills),0) from read_parquet('{tmp}')").fetchall()[0][0]
    tmp.rename(out)
    raw.unlink()
    return day, n_all, int(n)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--since", default="2025-09-17")
    a = ap.parse_args()
    (ROOT / "trades").mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(urllib.request.Request(f"{HF}/manifest.json", headers={"User-Agent": "research-client"}), timeout=60) as r:
        manifest = json.load(r)
    (ROOT / "manifest.json").write_text(json.dumps(manifest))
    days = sorted((v["day"], k) for k, v in manifest["files"].items() if k.startswith("daily/") and v["day"] >= a.since)
    print(len(days), "days", days[0][0], "to", days[-1][0], flush=True)
    done = 0
    with ProcessPoolExecutor(a.workers) as ex:
        futs = [ex.submit(one_day, d, k) for d, k in reversed(days)]
        for f in as_completed(futs):
            try:
                day, n_all, n = f.result()
            except Exception as e:
                print("FAILED", repr(e)[:300], flush=True)
                continue
            done += 1
            if n_all >= 0:
                print(f"{done}/{len(days)} {day}: {n:,} of {n_all:,} fills kept", flush=True)


if __name__ == "__main__":
    sys.exit(main())
