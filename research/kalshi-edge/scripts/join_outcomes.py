#!/usr/bin/env python3
"""Snapshots + settled results -> analysis tables, split so the holdout stays shut.

    data/analysis/h<h>.parquet   train and validation rows (start < 2026-10-01)
    data/holdout/h<h>.parquet    holdout rows; read only through kalshi_edge.guard

Adds: y (settlement value of YES), binary flag, family, period flag, sport, split,
taker fee rate on the start date, and the retail / large-order pressure terms.

Usage: python scripts/join_outcomes.py [--horizons 10 60 360 1440]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from kalshi_edge import guard, taxonomy  # noqa: E402
import build_bars  # noqa: E402

DATA = ROOT / "data"


def main() -> None:
    import duckdb
    import pandas as pd

    ap = argparse.ArgumentParser()
    ap.add_argument("--horizons", nargs="*", type=int, default=[10, 60, 360, 1440])
    a = ap.parse_args()
    con = duckdb.connect()
    con.execute("set threads=4")
    con.execute(f"""create temp table mk as
        select ticker, any_value(result) as result, any_value(settlement_value_dollars) as y,
               any_value(event_ticker) as api_event_ticker, any_value(title) as title, any_value(yes_sub_title) as yes_sub_title,
               any_value(floor_strike) as floor_strike, any_value(cap_strike) as cap_strike, any_value(strike_type) as strike_type,
               any_value(volume_fp) as volume_fp, any_value(close_time) as close_time
        from read_parquet('{DATA}/meta/markets/*/*.parquet') where result in ('yes', 'no', 'scalar') and settlement_value_dollars is not null
        group by ticker""")
    n_mk = con.execute("select count(*) from mk").fetchall()[0][0]
    sched = build_bars.fee_schedule()
    summary = {"markets_with_result": n_mk, "horizons": {}}
    for h in a.horizons:
        snap = f"read_parquet('{DATA}/snap/h{h}/*.parquet')"
        df = con.execute(f"""select s.*, m.result, m.y, m.api_event_ticker, m.yes_sub_title, m.floor_strike, m.strike_type
                             from {snap} s left join mk m using (ticker)""").df()
        n_all, usd_all = len(df), float(df.usd.sum())
        have = df.y.notna()
        mismatch = int((have & df.api_event_ticker.notna() & (df.api_event_ticker != df.event_ticker)).sum())
        df = df[have].copy()
        df["binary"] = df.result.isin(["yes", "no"])
        df["family"] = df.series.map(taxonomy.family_of)
        df["period"] = df.series.map(taxonomy.is_period)
        df["sport"] = df.milestone_type.map(taxonomy.sport_of)
        df["split"] = [guard.split_of(t.to_pydatetime()) for t in df.t_start]
        iso = df.t_start.dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        df["taker_rate"] = [build_bars.rate_on(sched[s], t) for s, t in zip(df.series, iso)]
        tot = df.usd.where(df.usd > 0)
        df["rp"] = (df.usd_rb_yes - df.usd_rb_no) / tot                    # net retail dollar-buy pressure, YES direction
        df["lp"] = (df.usd_inl_yes - df.usd_inl_no) / tot                  # net large integer-order pressure
        df["retail_share"] = (df.usd_rb_yes + df.usd_rb_no) / tot
        df["p0"] = (df.ask0 + df.bid0) / 2.0
        (DATA / "analysis").mkdir(exist_ok=True)
        (DATA / "holdout").mkdir(exist_ok=True)
        dev = df[df.split.isin(["train", "validation"])]
        hold = df[df.split == "holdout"]
        dev.to_parquet(DATA / "analysis" / f"h{h}.parquet", compression="zstd")
        hold.to_parquet(DATA / "holdout" / f"h{h}.parquet", compression="zstd")
        summary["horizons"][h] = {
            "snapshot_markets": n_all, "with_result": int(have.sum()), "result_share_markets": round(have.mean(), 4),
            "result_share_pregame_dollars": round(float(df.usd.sum()) / usd_all, 4) if usd_all else None,
            "event_ticker_mismatch": mismatch,
            "rows": df.split.value_counts().to_dict(), "games": df.groupby("split").milestone_id.nunique().to_dict(),
        }
        print(h, json.dumps(summary["horizons"][h]), flush=True)
    json.dump(summary, open(DATA / "analysis" / "join_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
