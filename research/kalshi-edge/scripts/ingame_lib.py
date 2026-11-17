"""Loader for the in-game minute table with results attached. Holdout rows need a guard token."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from kalshi_edge import guard, taxonomy  # noqa: E402

DATA = ROOT / "data"

RANGES = {
    "train": ("1900-01-01T00:00:00+00:00", guard.VALIDATION_START.isoformat()),
    "validation": (guard.VALIDATION_START.isoformat(), guard.HOLDOUT_START.isoformat()),
    "holdout": (guard.HOLDOUT_START.isoformat(), guard.FORWARD_START.isoformat()),
}


def load(split: str, where: str = "true", columns: str = "b.*", token=None) -> pd.DataFrame:
    """In-game minutes of one split joined with settled results and the series taker rate.

    `where` is extra SQL on alias b (for example a price filter, to keep memory down).
    """
    import duckdb

    if split == "holdout" and not isinstance(token, guard.HoldoutToken):
        raise guard.HoldoutRefused("in-game holdout rows are read only with a token from open_holdout()")
    lo, hi = RANGES[split]
    series = json.load(open(DATA / "meta" / "series_sports.json"))["series"]
    con = duckdb.connect()
    con.execute("set threads=4")
    con.execute("create temp table fee(series varchar, taker_rate double)")
    con.executemany("insert into fee values (?, ?)", [(s["ticker"], 0.07 * float(s.get("fee_multiplier") or 1)) for s in series])
    df = con.execute(f"""
        with mk as (select ticker, any_value(settlement_value_dollars) y, any_value(result) result
                    from read_parquet('{DATA}/meta/markets/*/*.parquet')
                    where result in ('yes', 'no', 'scalar') and settlement_value_dollars is not null group by ticker)
        select {columns}, m.y, m.result, f.taker_rate
        from read_parquet('{DATA}/ingame_min/*.parquet') b
        join mk m using (ticker) join fee f using (series)
        where b.t_start >= timestamptz '{lo}' and b.t_start < timestamptz '{hi}' and ({where})
    """).df()
    if len(df):
        assert df.t_start.min() >= pd.Timestamp(lo) and df.t_start.max() < pd.Timestamp(hi)
    df["sport"] = df.milestone_type.map(taxonomy.sport_of)
    df["split"] = split
    return df
