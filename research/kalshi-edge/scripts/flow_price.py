#!/usr/bin/env python3
"""S13 on quote midpoints, for train (fractional era), validation and the holdout period.

Prices and flow only: no outcome is read, so this is not a look at the holdout results.
It is logged in HOLDOUT-LEDGER.md anyway because it uses holdout-period games.
Writes results/s13_midpoint.json.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from kalshi_edge import flowprice  # noqa: E402

DATA = ROOT / "data"
PERIODS = {"train": ("2026-04-20 00:00:00+00", "2026-09-01 00:00:00+00"),
           "validation": ("2026-09-01 00:00:00+00", "2026-10-01 00:00:00+00"),
           "holdout": ("2026-10-01 00:00:00+00", "2026-11-16 00:00:00+00")}


def main() -> None:
    import duckdb

    con = duckdb.connect()
    con.execute("set threads=4")
    con.execute("set memory_limit='7GB'")
    out = {"note": "price change in cents per unit of signed flow share; d_mid = quote midpoint next minute, d_mid5 = five minutes on, "
                   "d_vwap = average trade price next minute (the registered measure, biased by bid-ask bounce)"}
    for name, (lo, hi) in PERIODS.items():
        df = con.execute(flowprice.minute_sql(f"{DATA}/ingame_min/*.parquet", lo, hi)).df()
        out[name] = {t: flowprice.fit(df, t) for t in ("d_mid", "d_mid5", "d_vwap")}
        m = out[name]["d_mid"]
        print(name, m["minutes"], "minutes,", m["games"], "games |",
              " | ".join(f"{k} mid {out[name]['d_mid'][k]['coef_cents']:+.3f}c (t {out[name]['d_mid'][k]['t']:+.1f}), "
                         f"avg-price {out[name]['d_vwap'][k]['coef_cents']:+.3f}c" for k in flowprice.GROUPS), flush=True)
    (ROOT / "results" / "s13_midpoint.json").write_text(json.dumps(out, indent=1) + "\n")
    print("wrote results/s13_midpoint.json")


if __name__ == "__main__":
    main()
