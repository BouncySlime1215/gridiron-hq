"""Pretend orders against the recorded book.

The pretend trader is a newcomer who keeps a fixed dollar amount resting at the
reference price of one side of one market, and re-posts there at every sweep.

Reward: Kalshi's formula applied to the recorded book with the newcomer's order
added on top of everyone else's score. Two versions, because our sweeps are
minutes apart and theirs are a second apart:
  reward     credited for the whole interval at the share held at its start
  reward_lo  nothing for an interval in which the reference price moved or the
             snapshot stopped counting before the next sweep
Fills: the pessimistic rule. Any public trade that hits the newcomer's side at
their price or worse fills them, as if they were first in the queue.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from house.grid import UNIT

YES, NO = 1, 0


def intervals(scores: pd.DataFrame, max_gap: float = 900.0) -> pd.DataFrame:
    """Pair every sweep of a side-market with the next one. A side-market's last sweep, and any
    sweep followed by a gap longer than ``max_gap`` seconds, starts no interval."""
    s = scores.sort_values(["ticker", "side", "ts"]).reset_index(drop=True)
    g = s.groupby(["ticker", "side"], sort=False)
    s["dt"] = g["ts"].shift(-1) - s["ts"]
    s["next_ref"] = g["ref"].shift(-1)
    s["next_valid"] = g["valid"].shift(-1)
    s = s[s["dt"].notna() & (s["dt"] <= max_gap)].copy()
    s["next_valid"] = s["next_valid"].astype(bool)
    return s


def joiner(iv: pd.DataFrame, dollars: float = 25.0) -> pd.DataFrame:
    """What ``dollars`` resting at the reference price would have earned over each interval."""
    out = iv.copy()
    price = out["ref"] / UNIT
    resting = out["ok"] & (out["ref"] > 0)
    out["contracts"] = np.where(resting, dollars / price.where(resting, 1.0), 0.0)
    share = np.where(resting & out["valid"], out["contracts"] / (out["score"] + out["contracts"]), 0.0)
    days = out["dt"] / 86_400.0
    out["share"] = share
    out["reward"] = out["perday"] * days * 0.5 * share
    steady = out["next_valid"] & (out["next_ref"] == out["ref"])
    out["reward_lo"] = np.where(steady, out["reward"], 0.0)
    out["collateral_days"] = np.where(resting, dollars * days, 0.0)
    return out


def fills(pos: pd.DataFrame, trades: pd.DataFrame) -> pd.DataFrame:
    """Pessimistic fills. ``pos`` is joiner() output; ``trades`` has ticker, ts, taker_yes, yes_px (1/10000 $), contracts.

    A resting YES bid is hit when a taker sells YES (buys NO) at or below it. A resting NO bid at
    price p is hit when a taker buys YES at or above 1 - p. Each interval's order fills at most once,
    for at most its own size, at its own price."""
    p = pos[pos["contracts"] > 0].copy()
    if p.empty or trades.empty:
        return pd.DataFrame(columns=["ticker", "side", "ts", "trade_ts", "price", "filled", "cost"])
    p["t_end"] = p["ts"] + p["dt"]
    t = trades.sort_values("ts").rename(columns={"ts": "trade_ts"})
    hits = []
    for side in (YES, NO):
        book = p[p["side"] == side].sort_values("ts")
        flow = t[t["taker_yes"] == (side == NO)]
        if book.empty or flow.empty:
            continue
        m = pd.merge_asof(flow, book[["ticker", "side", "ts", "t_end", "ref", "contracts"]],
                          left_on="trade_ts", right_on="ts", by="ticker", direction="backward")
        m = m[m["ts"].notna() & (m["trade_ts"] < m["t_end"])]
        through = m["yes_px"] <= m["ref"] if side == YES else (UNIT - m["yes_px"]) <= m["ref"]
        m = m[through]
        if m.empty:
            continue
        agg = m.groupby(["ticker", "side", "ts"], as_index=False).agg(
            trade_ts=("trade_ts", "min"), ref=("ref", "first"), size=("contracts_y", "first"), hit=("contracts_x", "sum"))
        agg["filled"] = np.minimum(agg["size"], agg["hit"])
        agg["price"] = agg["ref"]
        agg["cost"] = agg["filled"] * agg["price"] / UNIT
        hits.append(agg[["ticker", "side", "ts", "trade_ts", "price", "filled", "cost"]])
    if not hits:
        return pd.DataFrame(columns=["ticker", "side", "ts", "trade_ts", "price", "filled", "cost"])
    return pd.concat(hits, ignore_index=True)


def mark(f: pd.DataFrame, value_yes: pd.Series) -> pd.DataFrame:
    """Profit on each fill given what YES turned out to be worth (dollars, indexed like ``f``).
    A YES bid bought YES at its price; a NO bid bought NO at its price."""
    out = f.copy()
    worth = np.where(out["side"] == YES, value_yes, 1.0 - value_yes)
    out["pnl"] = out["filled"] * (worth - out["price"] / UNIT)
    return out
