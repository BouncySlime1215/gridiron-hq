#!/usr/bin/env python3
"""Pull public Kalshi sports metadata: milestones (game start times) and settled markets.

Outputs (all under data/meta/, gitignored):
  milestones.parquet                      one row per sports milestone (game / match)
  markets/historical/<SERIES>.parquet     markets settled before the historical cutoff
  markets/live/<SERIES>.parquet           settled markets still on the live endpoint

Resumable: a series whose file already exists is skipped. Run with --refresh-live to
re-pull the live tier (it keeps growing).

Usage: python scripts/pull_meta.py [--only-milestones] [--series KXNBAGAME ...]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from kalshi_edge.api import KalshiPublic  # noqa: E402

META = ROOT / "data" / "meta"

MARKET_FIELDS = [
    "ticker", "event_ticker", "market_type", "title", "yes_sub_title", "no_sub_title",
    "open_time", "close_time", "expected_expiration_time", "expiration_time", "occurrence_datetime",
    "settlement_ts", "result", "settlement_value_dollars", "expiration_value", "status",
    "volume_fp", "open_interest_fp", "strike_type", "floor_strike", "cap_strike", "functional_strike",
    "can_close_early", "price_level_structure", "rules_primary",
]


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def market_row(m: dict, series: str) -> dict:
    row = {k: m.get(k) for k in MARKET_FIELDS}
    row["series"] = series
    for k in ("floor_strike", "cap_strike"):
        v = row.get(k)
        row[k] = float(v) if v is not None and v != "" else None
    for k in ("volume_fp", "open_interest_fp", "settlement_value_dollars"):
        v = row.get(k)
        try:
            row[k] = float(v) if v is not None and v != "" else None
        except (TypeError, ValueError):
            row[k] = None
    cs = m.get("custom_strike")
    row["custom_strike"] = json.dumps(cs, sort_keys=True) if cs else None
    rp = row.get("rules_primary")
    row["rules_primary"] = rp[:400] if isinstance(rp, str) else None
    fs = row.get("functional_strike")
    row["functional_strike"] = str(fs) if fs is not None else None
    row["can_close_early"] = bool(row.get("can_close_early")) if row.get("can_close_early") is not None else None
    return row


MARKET_SCHEMA = pa.schema(
    [(k, pa.string()) for k in [
        "ticker", "event_ticker", "market_type", "title", "yes_sub_title", "no_sub_title", "open_time", "close_time",
        "expected_expiration_time", "expiration_time", "occurrence_datetime", "settlement_ts", "result",
        "expiration_value", "status", "strike_type", "functional_strike", "price_level_structure", "rules_primary",
        "series", "custom_strike"]]
    + [(k, pa.float64()) for k in ["settlement_value_dollars", "volume_fp", "open_interest_fp", "floor_strike", "cap_strike"]]
    + [("can_close_early", pa.bool_())]
)


def write_markets(rows: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cols = {name: [r.get(name) for r in rows] for name in MARKET_SCHEMA.names}
    table = pa.table(cols, schema=MARKET_SCHEMA)
    tmp = path.with_suffix(".tmp")
    pq.write_table(table, tmp, compression="zstd")
    tmp.rename(path)


async def pull_series_markets(api: KalshiPublic, series: str, tier: str) -> int:
    path = META / "markets" / tier / f"{series}.parquet"
    if path.exists():
        return -1
    rows: list[dict] = []
    if tier == "historical":
        pages = api.paginate("/historical/markets", {"series_ticker": series}, "markets")
    else:
        pages = api.paginate("/markets", {"series_ticker": series, "status": "settled"}, "markets")
    async for page in pages:
        rows.extend(market_row(m, series) for m in page)
    write_markets(rows, path)
    return len(rows)


async def pull_milestones(api: KalshiPublic, since: str) -> int:
    path = META / "milestones.parquet"
    rows = []
    n_pages = 0
    async for page in api.paginate("/milestones", {"minimum_start_date": since, "category": "Sports"}, "milestones", limit=500):
        n_pages += 1
        for m in page:
            det = m.get("details") or {}
            rows.append({
                "id": m.get("id"), "type": m.get("type"), "title": m.get("title"),
                "start_date": m.get("start_date"), "end_date": m.get("end_date"),
                "league": det.get("league"), "status": det.get("status"),
                "main_event": det.get("main_game_event_ticker"),
                "home_team_id": det.get("home_team_id"), "away_team_id": det.get("away_team_id"),
                "primary_event_tickers": json.dumps(m.get("primary_event_tickers") or []),
                "related_event_tickers": json.dumps(m.get("related_event_tickers") or []),
                "details": json.dumps(det, sort_keys=True)[:2000],
            })
        if n_pages % 50 == 0:
            log(f"  milestones: {len(rows)} rows, last start {rows[-1]['start_date'] if rows else None}")
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows), path, compression="zstd")
    return len(rows)


def priority(series: str) -> int:
    s = series.upper()
    if any(k in s for k in ("GAME", "MATCH", "FIGHT")):
        return 0
    if any(k in s for k in ("SPREAD", "TOTAL")):
        return 1
    return 2


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only-milestones", action="store_true")
    ap.add_argument("--skip-milestones", action="store_true")
    ap.add_argument("--series", nargs="*")
    ap.add_argument("--tiers", nargs="*", default=["historical", "live"])
    ap.add_argument("--since", default="2024-12-01T00:00:00Z")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--rate", type=float, default=4.0)
    a = ap.parse_args()

    api = KalshiPublic(rate=a.rate)
    try:
        if not a.skip_milestones and not (META / "milestones.parquet").exists():
            n = await pull_milestones(api, a.since)
            log(f"milestones: {n} rows ({api.n_requests} requests, {api.n_throttled} throttled)")
        if a.only_milestones:
            return
        if a.series:
            series = a.series
        else:
            series = [s["ticker"] for s in json.load(open(META / "series_sports.json"))["series"]]
        series = sorted(set(series), key=lambda s: (priority(s), s))
        jobs = [(s, t) for t in a.tiers for s in series]
        # interleave so priority-0 series of both tiers come first
        jobs.sort(key=lambda j: (priority(j[0]), j[1], j[0]))
        q: asyncio.Queue = asyncio.Queue()
        for j in jobs:
            q.put_nowait(j)
        done = {"n": 0, "rows": 0, "t0": time.time()}

        async def worker() -> None:
            while True:
                try:
                    s, t = q.get_nowait()
                except asyncio.QueueEmpty:
                    return
                try:
                    n = await pull_series_markets(api, s, t)
                except Exception as e:  # report and carry on; the series stays un-pulled for the next run
                    log(f"FAILED {t}/{s}: {e!r}")
                    n = 0
                done["n"] += 1
                if n > 0:
                    done["rows"] += n
                if n > 5000 or done["n"] % 250 == 0:
                    el = time.time() - done["t0"]
                    log(f"{done['n']}/{len(jobs)} jobs, {done['rows']} markets, {api.n_requests} req "
                        f"({api.n_throttled} throttled, rate {api.limiter.rate:.1f}/s), {el/60:.1f} min; last {t}/{s}={n}")

        await asyncio.gather(*[worker() for _ in range(a.workers)])
        log(f"done: {done['rows']} markets over {len(jobs)} jobs, {api.n_requests} requests")
    finally:
        await api.aclose()


if __name__ == "__main__":
    asyncio.run(main())
