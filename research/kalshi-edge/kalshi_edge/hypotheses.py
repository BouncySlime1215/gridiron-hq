"""The pre-registered parameter tests P1-P3 (PREREGISTRATION.md section 6).

Each takes a snapshot table already restricted to one split and returns a plain dict.
They fit nothing that is carried anywhere: the regression is the test.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats as sps

from kalshi_edge import stats

FRACTIONAL_ERA = pd.Timestamp("2026-04-20", tz="UTC")


def quoted(df: pd.DataFrame, max_age: int = 30, max_spread: float = 0.10) -> pd.DataFrame:
    """Rows with a usable reference price: both quotes fresh, spread sane, 0/1 outcome."""
    ok = ((df.ask0_age_min <= max_age) & (df.bid0_age_min <= max_age) & ((df.ask0 - df.bid0).between(0, max_spread))
          & df.p0.between(0.005, 0.995) & df.binary)
    return df[ok]


def p1_slope(df: pd.DataFrame) -> dict:
    """P1: slope > 1 in logit P(y) = a + b logit(p0)."""
    q = quoted(df)
    f = stats.calibration_slope(q.y.to_numpy(), q.p0.to_numpy(), q.milestone_id.to_numpy())
    return {"n": f.n, "games": f.n_clusters, "slope": f.slope, "se": f.slope_se, "intercept": f.intercept, "p_one_sided": f.p_slope_gt_1}


def p2_p3_flow(df: pd.DataFrame) -> dict:
    """P2: coefficient on retail pressure < 0. P3: coefficient on large-order pressure > 0.

    logit P(y) = 20 five-cent price-bin dummies + logit(p0) + rp + lp, fractional era only
    (before 2026-04-20 the tape has no dollar-denominated orders, so rp is identically zero).
    """
    q = quoted(df)
    q = q[(q.t_start >= FRACTIONAL_ERA) & q.rp.notna() & q.lp.notna()]
    x = np.log(q.p0 / (1 - q.p0)).to_numpy()
    bins = pd.get_dummies(pd.cut(q.p0, np.linspace(0, 1, 21), include_lowest=True), drop_first=True, dtype=float)
    X = np.column_stack([np.ones(len(q)), x, q.rp.to_numpy(), q.lp.to_numpy(), bins.to_numpy()])
    names = ["const", "logit_p0", "rp", "lp"] + [f"bin{i}" for i in range(bins.shape[1])]
    keep = X.std(axis=0) > 0
    keep[0] = True
    f = stats.logit_fit(q.y.to_numpy(), X[:, keep], [n for n, k in zip(names, keep) if k], q.milestone_id.to_numpy())
    z_rp, z_lp = f.z("rp"), f.z("lp")
    return {"n": f.n, "games": f.n_clusters,
            "rp_coef": f.coef("rp"), "rp_se": f.stderr("rp"), "p2_one_sided": float(sps.norm.cdf(z_rp)),
            "lp_coef": f.coef("lp"), "lp_se": f.stderr("lp"), "p3_one_sided": float(sps.norm.sf(z_lp))}
