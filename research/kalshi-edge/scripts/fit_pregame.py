#!/usr/bin/env python3
"""Pre-game model ladder: fit on TRAIN, compare on VALIDATION. Never reads the holdout.

M0 market mid; M1 recalibration (ridge logistic on price terms by family); M2 M1 + flow;
M3 gradient-boosted trees starting from logit(p0).

Usage: python scripts/fit_pregame.py [--h 10]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from kalshi_edge import features, stats, strategy  # noqa: E402

DATA = ROOT / "data"
FRACTIONAL_ERA = pd.Timestamp("2026-04-20", tz="UTC")
pd.set_option("display.width", 250)


def load(h: int) -> pd.DataFrame:
    df = pd.read_parquet(DATA / "analysis" / f"h{h}.parquet")
    assert set(df.split.unique()) <= {"train", "validation"}
    return df


def quoted(df: pd.DataFrame, max_age: int) -> pd.Series:
    return ((df.ask0_age_min <= max_age) & (df.bid0_age_min <= max_age) & ((df.ask0 - df.bid0).between(0, 0.10))
            & df.p0.between(0.005, 0.995))


def logloss(y, q):
    q = np.clip(q, 1e-6, 1 - 1e-6)
    return -(y * np.log(q) + (1 - y) * np.log(1 - q))


def paired_ll(y, q_a, q_b, clusters, n_boot=2000, seed=0):
    """Mean log-loss difference a - b (negative = a better) with a game-cluster bootstrap interval."""
    d = logloss(y, q_a) - logloss(y, q_b)
    uniq, inv = np.unique(clusters, return_inverse=True)
    s = np.bincount(inv, weights=d)
    n = np.bincount(inv)
    rng = np.random.default_rng(seed)
    w = rng.multinomial(len(uniq), np.full(len(uniq), 1 / len(uniq)), size=n_boot)
    boots = (w @ s) / (w @ n)
    return float(d.mean()), float(np.quantile(boots, 0.05)), float(np.quantile(boots, 0.95))


def fit_linear(X: pd.DataFrame, y: np.ndarray, cols: list[str], C: float):
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    m = make_pipeline(StandardScaler(), LogisticRegression(C=C, max_iter=2000))
    m.fit(X[cols].to_numpy(), y)
    return m


def fit_gbm(X: pd.DataFrame, y: np.ndarray, lp0: np.ndarray, cols: list[str], X_es, y_es, lp_es, seed=0):
    import lightgbm as lgb

    params = dict(objective="binary", learning_rate=0.02, num_leaves=8, min_data_in_leaf=400, feature_fraction=0.7,
                  bagging_fraction=0.7, bagging_freq=1, lambda_l2=20.0, verbose=-1, seed=seed)
    dtr = lgb.Dataset(X[cols].to_numpy(), y, init_score=lp0, feature_name=cols)
    des = lgb.Dataset(X_es[cols].to_numpy(), y_es, init_score=lp_es, reference=dtr)
    booster = lgb.train(params, dtr, num_boost_round=600, valid_sets=[des], callbacks=[lgb.early_stopping(40, verbose=False)])
    return booster


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--h", type=int, default=10)
    a = ap.parse_args()
    max_age = 30 if a.h == 10 else 120
    df = load(a.h)
    df = df[quoted(df, max_age)].copy()
    X = features.build(df)
    is_bin = df.binary.to_numpy()
    tr = (df.split == "train").to_numpy() & is_bin
    va = (df.split == "validation").to_numpy()
    va_bin = va & is_bin
    y = df.y.to_numpy()
    g = df.milestone_id.to_numpy()
    print(f"h={a.h}: train {tr.sum()} markets / {len(set(g[tr]))} games; validation {va_bin.sum()} / {len(set(g[va_bin]))} games")

    preds = {"M0": df.p0.to_numpy()}
    for name, cols, C in (("M1", features.LINEAR_BASE, 0.05), ("M2", features.LINEAR_FLOW, 0.05)):
        fit_mask = tr if name == "M1" else tr & (df.t_start >= FRACTIONAL_ERA).to_numpy()
        m = fit_linear(X[fit_mask], y[fit_mask], cols, C)
        preds[name] = m.predict_proba(X[cols].to_numpy())[:, 1]
        coef = dict(zip(cols, np.round(m[-1].coef_[0], 4)))
        print(name, "standardised coefficients:", coef)
    # GBM: fractional era train, last 5 weeks of train as the early-stopping slice
    era = tr & (df.t_start >= FRACTIONAL_ERA).to_numpy()
    cut = pd.Timestamp("2026-07-27", tz="UTC")
    fit_m = era & (df.t_start < cut).to_numpy()
    es_m = era & (df.t_start >= cut).to_numpy()
    gcols = [c for c in X.columns]
    lp0 = X.lp0.to_numpy()
    booster = fit_gbm(X[fit_m], y[fit_m], lp0[fit_m], gcols, X[es_m], y[es_m], lp0[es_m])
    raw = booster.predict(X[gcols].to_numpy(), raw_score=True) + lp0
    preds["M3"] = 1 / (1 + np.exp(-raw))
    imp = pd.Series(booster.feature_importance("gain"), index=gcols).sort_values(ascending=False)
    print("M3 trees:", booster.best_iteration, " top gain:", imp.head(12).round(0).to_dict())

    print("\n--- validation log loss vs the market (negative = better than the market), 90% game-cluster interval")
    for name in ("M1", "M2", "M3"):
        d, lo, hi = paired_ll(y[va_bin], preds[name][va_bin], preds["M0"][va_bin], g[va_bin])
        print(f"  {name}: {d*1e4:+.2f} e-4  [{lo*1e4:+.2f}, {hi*1e4:+.2f}]   mean ll market {logloss(y[va_bin], preds['M0'][va_bin]).mean():.5f}")
    for name in ("M1", "M2", "M3"):
        d, lo, hi = paired_ll(y[tr], preds[name][tr], preds["M0"][tr], g[tr])
        print(f"  (train) {name}: {d*1e4:+.2f} e-4  [{lo*1e4:+.2f}, {hi*1e4:+.2f}]")

    print("\n--- strategy on validation (taker, limit fill, one bet per event, $100 stakes)")
    rows = []
    for name in ("M0", "M1", "M2", "M3"):
        for tau in (0.005, 0.01, 0.02, 0.03, 0.05):
            for split, mask in (("train", (df.split == "train").to_numpy()), ("validation", va)):
                b = strategy.simulate(df[mask], preds[name][mask], tau=tau, max_quote_age=max_age)
                s = strategy.summarize(b, n_boot=1000)
                rows.append({"model": name, "tau": tau, "split": split, "bets": s["bets"], "games": s["games"],
                             "roi_%": round(100 * s["roi"], 2) if s["bets"] else None,
                             "lo": round(100 * s["lo"], 2) if s["bets"] else None, "hi": round(100 * s["hi"], 2) if s["bets"] else None,
                             "win%": round(100 * s.get("win_rate", np.nan), 1), "avg_px": round(s.get("avg_price", np.nan), 3),
                             "yes_share": round((b.side == "yes").mean(), 2) if len(b) else None})
    out = pd.DataFrame(rows)
    print(out.pivot_table(index=["model", "tau"], columns="split", values=["bets", "roi_%", "lo", "hi"], aggfunc="first").to_string())
    json.dump({k: v.tolist() for k, v in preds.items()} | {"index": df.index.tolist()}, open(DATA / "analysis" / f"preds_h{a.h}.json", "w"))


if __name__ == "__main__":
    main()
