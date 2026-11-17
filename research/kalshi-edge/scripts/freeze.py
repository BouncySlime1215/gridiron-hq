#!/usr/bin/env python3
"""Freeze everything the holdout run needs into frozen/model.json (committed before the holdout is opened).

P4's strategy is the pre-registered fallback: no rung of the ladder beat the market on
validation, so it is M1 (ridge logistic on price terms, fit on TRAIN) at tau = 1c.
The in-game rules have no fitted parameters; their constants are copied from
kalshi_edge.rules so the file is a complete record.
"""
from __future__ import annotations

import datetime as dt
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from kalshi_edge import features, hypotheses, rules  # noqa: E402
import fit_pregame  # noqa: E402

DATA = ROOT / "data"


def main() -> None:
    import duckdb

    df = fit_pregame.load(10)
    df = df[fit_pregame.quoted(df, 30)].copy()
    X = features.build(df)
    tr = ((df.split == "train") & df.binary).to_numpy()
    cols = features.LINEAR_BASE
    m = fit_pregame.fit_linear(X[tr], df.y.to_numpy()[tr], cols, C=0.05)
    scaler, lr = m[0], m[-1]
    n_markets, n_series = duckdb.connect().execute(
        f"select count(*), count(distinct series) from read_parquet('{DATA}/meta/markets/*/*.parquet')").fetchall()[0]
    out = {
        "frozen_at_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "code_commit": subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=ROOT).stdout.strip(),
        "p4": {
            "model": "M1 ridge logistic on price terms by family (fallback: nothing beat the market on validation)",
            "horizon_min": 10, "tau": 0.01, "stake": 100.0, "max_quote_age": 30, "max_spread": 0.10,
            "features": cols, "scaler_mean": scaler.mean_.tolist(), "scaler_scale": scaler.scale_.tolist(),
            "coef": lr.coef_[0].tolist(), "intercept": float(lr.intercept_[0]),
            "train_rows": int(tr.sum()), "train_games": int(df.milestone_id[tr].nunique()),
        },
        "a1": {"claim": "in-game pre-fee taker return, integer-count orders minus retail dollar-buy orders > 0",
               "universe": "holdout games with retail dollar-buy flow", "bootstrap": "games, 10000 draws"},
        "a2": dict(rules.EARLY_LONGSHOT_OFFER, one_position_per_game=True, bootstrap="games, 10000 draws",
                   maker_fee="0.0175 * p * (1 - p) on quadratic_with_maker_fees series, else 0"),
        "s8": rules.FAVOURITE_CARRY,
        "fractional_era_start": str(hypotheses.FRACTIONAL_ERA.date()),
        "results_snapshot": {"markets": int(n_markets), "series": int(n_series)},
    }
    path = ROOT / "frozen" / "model.json"
    path.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
    print("wrote", path, "| train rows", out["p4"]["train_rows"], "| results markets", n_markets)


def predict(frozen: dict, X: pd.DataFrame) -> np.ndarray:
    """Probability of YES from the frozen M1 coefficients."""
    p4 = frozen["p4"]
    z = (X[p4["features"]].to_numpy() - np.asarray(p4["scaler_mean"])) / np.asarray(p4["scaler_scale"])
    return 1.0 / (1.0 + np.exp(-(z @ np.asarray(p4["coef"]) + p4["intercept"])))


if __name__ == "__main__":
    main()
