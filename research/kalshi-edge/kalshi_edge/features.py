"""Model features from a snapshot table. Shared by training, the holdout run and the live scanner.

Everything here is computable at the decision time: columns built by
kalshi_edge.snapshots from bars that had finished, plus static labels (family, sport).
The w_* and e*_ columns (what happened after the decision) are never read.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

FAMILIES = ("winner", "spread", "total", "team_total", "prop")
SPORTS = ("basketball", "football", "baseball", "tennis", "soccer", "hockey", "esports", "mma")
FORBIDDEN_PREFIXES = ("w_", "e1_", "e2_")
FORBIDDEN = {"y", "result", "split"}


def _logit(p):
    p = np.clip(np.asarray(p, dtype=float), 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def build(df: pd.DataFrame) -> pd.DataFrame:
    """Return the feature frame (same index as df). Raises if a post-decision column is requested."""
    out = pd.DataFrame(index=df.index)
    lp = _logit(df.p0)
    out["lp0"] = lp
    out["lp0_cu"] = lp ** 3 / 10.0                      # lets the tails bend away from a straight line
    out["abs_lp0"] = np.abs(lp)
    out["spread"] = (df.ask0 - df.bid0).clip(0, 0.2)
    out["log_usd"] = np.log1p(df.usd.clip(lower=0))
    out["log_usd_60"] = np.log1p(df.usd_60.clip(lower=0))
    out["period"] = df.period.astype(float)
    tot = df.usd.where(df.usd > 0)
    out["retail_share"] = ((df.usd_rb_yes + df.usd_rb_no) / tot).fillna(0.0)
    out["rp"] = ((df.usd_rb_yes - df.usd_rb_no) / tot).fillna(0.0)
    out["lp"] = ((df.usd_inl_yes - df.usd_inl_no) / tot).fillna(0.0)
    out["fxp"] = ((df.usd_fx_yes - df.usd_fx_no) / tot).fillna(0.0)
    out["insp"] = ((df.usd_ins_yes - df.usd_ins_no) / tot).fillna(0.0)
    tot60 = df.usd_60.where(df.usd_60 > 0)
    out["rp_60"] = ((df.usd_rb_yes_60 - df.usd_rb_no_60) / tot60).fillna(0.0)
    out["lp_60"] = ((df.usd_inl_yes_60 - df.usd_inl_no_60) / tot60).fillna(0.0)
    for m in (60, 360, 1440):
        prev = df[f"p_m{m}"]
        out[f"mom_{m}"] = (df.p0 - prev).fillna(0.0).clip(-0.5, 0.5)
        out[f"mom_{m}_na"] = prev.isna().astype(float)
    # event-level: how this market's retail dollars compare with its siblings and with its price
    g = df.groupby("event_ticker", sort=False)
    ev_rb = g.usd_rb_yes.transform("sum")
    ev_p = g.p0.transform("sum")
    ev_n = g.p0.transform("size")
    rb_share = (df.usd_rb_yes / ev_rb.where(ev_rb > 0)).fillna(0.0)
    p_share = (df.p0 / ev_p.where(ev_p > 0)).fillna(0.0)
    multi = (ev_n >= 2) & (ev_rb > 0)
    out["ev_n"] = ev_n.clip(upper=10).astype(float)
    out["ev_overround"] = np.where(ev_n >= 2, ev_p - 1.0, 0.0).clip(-0.3, 0.3)
    out["retail_overweight"] = np.where(multi, rb_share - p_share, 0.0)
    ev_inl = g.usd_inl_yes.transform("sum")
    inl_share = (df.usd_inl_yes / ev_inl.where(ev_inl > 0)).fillna(0.0)
    out["large_overweight"] = np.where((ev_n >= 2) & (ev_inl > 0), inl_share - p_share, 0.0)
    n_tot = (df.n_rb_yes + df.n_rb_no).where((df.n_rb_yes + df.n_rb_no) > 0)
    out["ticket_skew"] = ((df.n_rb_yes - df.n_rb_no) / n_tot).fillna(0.0) - out["rp"]   # bets % minus money %
    for f in FAMILIES:
        out[f"fam_{f}"] = (df.family == f).astype(float)
        out[f"fam_{f}_x_lp0"] = out[f"fam_{f}"] * lp
    for s in SPORTS:
        out[f"sport_{s}"] = (df.sport == s).astype(float)
    bad = [c for c in out.columns if c in FORBIDDEN or c.startswith(FORBIDDEN_PREFIXES)]
    if bad:
        raise AssertionError(f"post-decision columns leaked into features: {bad}")
    return out


LINEAR_BASE = ["lp0", "lp0_cu"] + [f"fam_{f}" for f in FAMILIES[1:]] + [f"fam_{f}_x_lp0" for f in FAMILIES[1:]]
LINEAR_FLOW = LINEAR_BASE + ["rp", "lp", "fxp", "retail_share", "retail_overweight", "large_overweight", "ticket_skew",
                             "mom_60", "mom_360", "ev_overround", "period"]
