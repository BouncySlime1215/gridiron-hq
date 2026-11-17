#!/usr/bin/env python3
"""Discovery tables on TRAIN only (starts before 2026-09-01). Never reads validation or holdout rows.

Usage: python scripts/discover.py [--h 10] [--split train]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from kalshi_edge import backtest as bt  # noqa: E402
from kalshi_edge import stats  # noqa: E402

DATA = ROOT / "data"
FRACTIONAL_ERA = pd.Timestamp("2026-04-20", tz="UTC")   # first full week with fractional (dollar) orders on the tape

pd.set_option("display.width", 250)
pd.set_option("display.max_columns", 40)


def load(h: int, split: str) -> pd.DataFrame:
    df = pd.read_parquet(DATA / "analysis" / f"h{h}.parquet")
    assert set(df.split.unique()) <= {"train", "validation"}, "analysis table must not contain holdout rows"
    return df[df.split == split].copy()


def quoted(df: pd.DataFrame, max_age: int) -> pd.DataFrame:
    """Rows with a usable reference price per the pre-registration: both quotes fresh, sane spread."""
    ok = (df.ask0_age_min <= max_age) & (df.bid0_age_min <= max_age) & ((df.ask0 - df.bid0).between(0, 0.10))
    return df[ok & df.p0.between(0.005, 0.995)].copy()


def calib_table(d: pd.DataFrame, by=None, bins=(0, .05, .1, .2, .3, .4, .5, .6, .7, .8, .9, .95, 1.0)) -> pd.DataFrame:
    d = d.assign(pb=pd.cut(d.p0, bins, include_lowest=True))
    keys = ([by] if by else []) + ["pb"]
    g = d.groupby(keys, observed=True)
    out = g.agg(n=("y", "size"), games=("milestone_id", "nunique"), p0=("p0", "mean"), y=("y", "mean"), usd=("usd", "sum"))
    out["resid_c"] = (out.y - out.p0) * 100
    # game-clustered standard error of the mean residual
    def se(x):
        r = (x.y - x.p0)
        c = r.groupby(x.milestone_id).sum()
        return np.sqrt((c ** 2).sum()) / len(x) * 100 if len(c) > 1 else np.nan
    out["se_c"] = g.apply(se, include_groups=False)
    out["t"] = out.resid_c / out.se_c
    return out.round({"p0": 3, "y": 3, "resid_c": 2, "se_c": 2, "t": 1, "usd": 0})


def slope_table(d: pd.DataFrame, by: str, min_n: int = 2000) -> pd.DataFrame:
    rows = []
    for k, x in [("ALL", d)] + list(d.groupby(by, observed=True)):
        if len(x) < min_n or x.y.nunique() < 2:
            continue
        f = stats.calibration_slope(x.y.values, x.p0.values, x.milestone_id.values)
        rows.append({by: k, "n": f.n, "games": f.n_clusters, "slope": round(f.slope, 3), "se": round(f.slope_se, 3),
                     "intercept": round(f.intercept, 3), "p(slope<=1)": f"{f.p_slope_gt_1:.2g}"})
    return pd.DataFrame(rows)


def naive_taker(d: pd.DataFrame) -> pd.DataFrame:
    """Return of blindly buying each side at the entry print, net of fees, by price of the side bought."""
    rows = []
    for side in ("yes", "no"):
        px = d.e1_ask.fillna(d.e2_ask) if side == "yes" else 1 - d.e1_bid.fillna(d.e2_bid)
        x = d[px.between(0.01, 0.99)].assign(px=px)
        win = x.y if side == "yes" else 1 - x.y
        cost = x.px + x.taker_rate * x.px * (1 - x.px)
        x = x.assign(pnl=win - cost, cost=cost, side=side)
        rows.append(x[["milestone_id", "px", "pnl", "cost", "side", "family", "sport"]])
    z = pd.concat(rows)
    z["pb"] = pd.cut(z.px, [0, .05, .1, .2, .3, .4, .5, .6, .7, .8, .9, .95, 1.0])
    out = []
    for (side, pb), x in z.groupby(["side", "pb"], observed=True):
        if x.milestone_id.nunique() < 30:
            continue
        ci = stats.cluster_bootstrap_ratio(x.pnl.values, x.cost.values, x.milestone_id.values, n_boot=2000, seed=1)
        out.append({"side": side, "price": str(pb), "n": len(x), "games": ci.n_clusters, "ret_%": round(100 * ci.point, 2),
                    "lo": round(100 * ci.lo, 2), "hi": round(100 * ci.hi, 2)})
    return pd.DataFrame(out)


def flow_regression(d: pd.DataFrame) -> None:
    d = d[(d.t_start >= FRACTIONAL_ERA) & d.rp.notna() & d.lp.notna()]
    x = np.log(d.p0 / (1 - d.p0)).values
    bins = pd.get_dummies(pd.cut(d.p0, np.linspace(0, 1, 21), include_lowest=True), drop_first=True, dtype=float)
    X = np.column_stack([np.ones(len(d)), x, d.rp.values, d.lp.values, bins.values])
    names = ["const", "logit_p0", "rp", "lp"] + [f"b{i}" for i in range(bins.shape[1])]
    keep = X.std(axis=0) > 0
    keep[0] = True
    f = stats.logit_fit(d.y.values, X[:, keep], [n for n, k in zip(names, keep) if k], d.milestone_id.values)
    print(f"flow regression (fractional era, n={f.n}, games={f.n_clusters}):")
    for n in ("logit_p0", "rp", "lp"):
        print(f"   {n:9s} coef {f.coef(n):+.4f}  se {f.stderr(n):.4f}  z {f.z(n):+.2f}")
    print("   rp quantiles:", d.rp.quantile([.05, .25, .5, .75, .95]).round(3).tolist(), " lp:", d.lp.quantile([.05, .25, .5, .75, .95]).round(3).tolist())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--h", type=int, default=10)
    ap.add_argument("--split", default="train", choices=["train", "validation"])
    a = ap.parse_args()
    df = load(a.h, a.split)
    max_age = 30 if a.h == 10 else 120
    print(f"=== {a.split}, h={a.h}: {len(df)} markets with results, {df.milestone_id.nunique()} games, "
          f"{df.t_start.min():%Y-%m-%d} to {df.t_start.max():%Y-%m-%d}")
    q = quoted(df[df.binary], max_age)
    print(f"quoted + binary: {len(q)} markets, {q.milestone_id.nunique()} games, pre-game taker $ {q.usd.sum()/1e9:.2f}bn")
    print(q.groupby(["family"]).agg(n=("y", "size"), games=("milestone_id", "nunique"), usd_m=("usd", lambda s: round(s.sum() / 1e6))).to_string())
    print(q.groupby(["sport"]).agg(n=("y", "size"), games=("milestone_id", "nunique"), usd_m=("usd", lambda s: round(s.sum() / 1e6))).sort_values("n", ascending=False).to_string())
    print("\n--- calibration, all quoted binary markets"); print(calib_table(q).to_string())
    print("\n--- slope by family"); print(slope_table(q, "family").to_string(index=False))
    print("\n--- slope by sport"); print(slope_table(q, "sport").to_string(index=False))
    q["era"] = np.where(q.t_start >= FRACTIONAL_ERA, "2026-04-20+", "before")
    print("\n--- slope by era"); print(slope_table(q, "era").to_string(index=False))
    q["half"] = q.t_start.dt.strftime("%Y-%m")
    print("\n--- slope by month"); print(slope_table(q, "half", min_n=1500).to_string(index=False))
    print("\n--- calibration by family")
    print(calib_table(q, by="family", bins=(0, .1, .25, .4, .6, .75, .9, 1.0)).to_string())
    print()
    flow_regression(q)
    print("\n--- naive taker: buy every market at the entry print, net of fees")
    print(naive_taker(q).to_string(index=False))


if __name__ == "__main__":
    main()
