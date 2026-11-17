#!/usr/bin/env python3
"""In-game discovery on TRAIN only (scheduled start before 2026-09-01): winner markets.

Reads data/ingame/*.parquet (prices and flows) and joins settled results only for
train-period games. Prints calibration and naive taker returns by in-game price.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from kalshi_edge import guard, stats, taxonomy  # noqa: E402

DATA = ROOT / "data"
pd.set_option("display.width", 250)
BINS = [0, .02, .05, .1, .2, .3, .4, .5, .6, .7, .8, .9, .95, .98, 1.0]


def load_train(columns: str = "*", split: str = "train") -> pd.DataFrame:
    import duckdb

    lo, hi = {"train": ("1900-01-01", guard.VALIDATION_START.isoformat()),
              "validation": (guard.VALIDATION_START.isoformat(), guard.HOLDOUT_START.isoformat())}[split]
    con = duckdb.connect()
    con.execute("set threads=4")
    df = con.execute(f"""
        with mk as (select ticker, any_value(result) result, any_value(settlement_value_dollars) y
                    from read_parquet('{DATA}/meta/markets/*/*.parquet')
                    where result in ('yes','no') and settlement_value_dollars is not null group by ticker)
        select {columns}, m.y
        from read_parquet('{DATA}/ingame/*.parquet') b join mk m using (ticker)
        where b.t_start >= timestamptz '{lo}' and b.t_start < timestamptz '{hi}'
    """).df()
    assert df.t_start.max() < pd.Timestamp(guard.HOLDOUT_START), "in-game discovery must not read holdout games"
    df["sport"] = df.milestone_type.map(taxonomy.sport_of)
    return df


def tables(df: pd.DataFrame) -> None:
    both = df.ask_px.notna() & df.bid_px.notna() & ((df.ask_px - df.bid_px).between(0, 0.10))
    d = df[both].copy()
    d["p"] = (d.ask_px + d.bid_px) / 2
    d["pb"] = pd.cut(d.p, BINS, include_lowest=True)
    print(f"in-game bars with two-sided prints: {len(d)} of {len(df)}; games {d.milestone_id.nunique()}; $ {d.dollars.sum()/1e9:.2f}bn")

    def tab(x, by):
        g = x.groupby(by, observed=True)
        out = g.agg(bars=("y", "size"), games=("milestone_id", "nunique"), p=("p", "mean"), y=("y", "mean"), usd_m=("dollars", lambda s: round(s.sum() / 1e6)))
        def se(z):
            c = (z.y - z.p).groupby(z.milestone_id).sum()
            return 100 * np.sqrt((c ** 2).sum()) / len(z)
        out["resid_c"] = 100 * (out.y - out.p)
        out["se_c"] = g.apply(se, include_groups=False)
        out["t"] = out.resid_c / out.se_c
        return out.round({"p": 3, "y": 3, "resid_c": 2, "se_c": 2, "t": 1})

    print("\n--- in-game calibration, all sports"); print(tab(d, ["pb"]).to_string())
    for sp in ("basketball", "football", "baseball", "tennis", "soccer", "hockey", "mma", "esports"):
        x = d[d.sport == sp]
        if len(x) > 5000:
            print(f"\n--- in-game calibration, {sp}"); print(tab(x, ["pb"]).to_string())

    # naive taker: at the end of a bar, buy the side at the next bar's print
    rate = 0.07
    rows = []
    for side in ("yes", "no"):
        px = d.next_ask if side == "yes" else 1 - d.next_bid
        x = d[px.between(0.01, 0.995)].assign(px=px)
        gap = (x.next_bucket - x.bucket).dt.total_seconds() / 60
        x = x[gap <= 10]
        win = x.y if side == "yes" else 1 - x.y
        cost = x.px + rate * x.px * (1 - x.px)
        rows.append(pd.DataFrame({"g": x.milestone_id, "px": x.px, "pnl": win - cost, "cost": cost, "side": side, "sport": x.sport}))
    z = pd.concat(rows)
    z["pb"] = pd.cut(z.px, BINS)
    out = []
    for (side, pb), x in z.groupby(["side", "pb"], observed=True):
        if x.g.nunique() < 50:
            continue
        ci = stats.cluster_bootstrap_ratio(x.pnl.values, x.cost.values, x.g.values, n_boot=1000, seed=1)
        out.append({"side": side, "price": str(pb), "bars": len(x), "games": ci.n_clusters, "ret_%": round(100 * ci.point, 2), "lo": round(100 * ci.lo, 2), "hi": round(100 * ci.hi, 2)})
    print("\n--- naive in-game taker (buy at next bar's print, 7% fee), all sports"); print(pd.DataFrame(out).to_string(index=False))
    out = []
    hi_fav = z[(z.side == "yes") & (z.px >= 0.9)]
    for sp, x in hi_fav.groupby("sport"):
        for lo_, hi_ in ((0.9, 0.95), (0.95, 0.98), (0.98, 0.995)):
            w = x[(x.px > lo_) & (x.px <= hi_)]
            if w.g.nunique() < 50:
                continue
            ci = stats.cluster_bootstrap_ratio(w.pnl.values, w.cost.values, w.g.values, n_boot=1000, seed=1)
            out.append({"sport": sp, "price": f"({lo_},{hi_}]", "bars": len(w), "games": ci.n_clusters, "ret_%": round(100 * ci.point, 2), "lo": round(100 * ci.lo, 2), "hi": round(100 * ci.hi, 2)})
    print("\n--- naive in-game taker, buy YES favourites by sport"); print(pd.DataFrame(out).to_string(index=False))


if __name__ == "__main__":
    cols = "b.ticker, b.series, b.bucket, b.px_close, b.vwap, b.ask_px, b.bid_px, b.dollars, b.next_bucket, b.next_ask, b.next_bid, b.t_start, b.t_end, b.milestone_id, b.milestone_type, b.mins_in, b.pre_close, b.usd_rb_yes, b.usd_rb_no, b.usd_fx_yes, b.usd_fx_no, b.usd_inl_yes, b.usd_inl_no"
    tables(load_train(cols))
