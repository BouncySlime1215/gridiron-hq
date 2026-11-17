"""Strategy simulation over a snapshot table (vectorised).

Decision rules, from PREREGISTRATION.md section 5:
  * quotes must be fresh on both sides and the spread sane, or the market is not bet;
  * the edge is judged at the quote seen at decision time, after the taker fee;
  * each event gets at most one bet, the largest edge, chosen BEFORE the fill is known;
  * the order is a limit at the price where the edge would shrink to tau, filled at the
    first same-side taker print at or under it in the two entry bars, or not at all.

tests/test_strategy.py checks this bet for bet against kalshi_edge.backtest.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from kalshi_edge import stats

PASS_THROUGH = ("series", "family", "sport", "period", "league", "t_start", "split", "usd", "p0", "h_min")


def _valid(p: np.ndarray) -> np.ndarray:
    return np.isfinite(p) & (p > 0.0) & (p <= 1.0)


def _cost(p: np.ndarray, rate: np.ndarray) -> np.ndarray:
    return p + rate * p * (1.0 - p)


def _limit(q: np.ndarray, tau: float, rate: np.ndarray) -> np.ndarray:
    target = q - tau
    safe_rate = np.where(rate > 0, rate, 1.0)
    disc = np.clip((1.0 + rate) ** 2 - 4.0 * rate * np.clip(target, 0.0, 1.0), 0.0, None)
    root = np.minimum(1.0, ((1.0 + rate) - np.sqrt(disc)) / (2.0 * safe_rate))
    lim = np.where(rate > 0, root, target)
    lim = np.where(target >= 1.0, 1.0, lim)
    return np.where(target <= 0.0, np.nan, lim)


def simulate(df: pd.DataFrame, q, tau: float, stake: float = 100.0, max_quote_age: int = 30,
             max_spread: float = 0.10) -> pd.DataFrame:
    """Return one row per filled bet. `q` is the modelled probability of YES for each row of df."""
    q = np.asarray(q, dtype=float)
    if len(q) != len(df):
        raise ValueError("q must have one value per row")
    ask = df.ask0.to_numpy(dtype=float)
    bid = df.bid0.to_numpy(dtype=float)
    rate = df.taker_rate.to_numpy(dtype=float)
    spread = ask - bid
    fresh = (_valid(ask) & _valid(1.0 - bid) & np.isfinite(q)
             & (df.ask0_age_min.to_numpy(dtype=float) <= max_quote_age)
             & (df.bid0_age_min.to_numpy(dtype=float) <= max_quote_age)
             & (spread >= 0.0) & (spread <= max_spread + 1e-12))
    with np.errstate(invalid="ignore"):
        e_yes = q - _cost(ask, rate)
        e_no = (1.0 - q) - _cost(1.0 - bid, rate)
    is_yes = e_yes >= e_no
    edge = np.where(is_yes, e_yes, e_no)
    cand = fresh & np.isfinite(edge) & (edge >= tau)
    if not cand.any():
        return _empty()
    idx = np.flatnonzero(cand)
    pick = pd.DataFrame({"i": idx, "event": df.event_ticker.to_numpy()[idx], "edge": edge[idx]})
    chosen = pick.loc[pick.groupby("event", sort=False).edge.idxmax(), "i"].to_numpy()

    side_yes = is_yes[chosen]
    qq = np.where(side_yes, q[chosen], 1.0 - q[chosen])
    r = rate[chosen]
    lim = _limit(qq, tau, r)
    sub = df.iloc[chosen]
    p1 = np.where(side_yes, sub.e1_ask.to_numpy(dtype=float), 1.0 - sub.e1_bid.to_numpy(dtype=float))
    p2 = np.where(side_yes, sub.e2_ask.to_numpy(dtype=float), 1.0 - sub.e2_bid.to_numpy(dtype=float))
    with np.errstate(invalid="ignore"):
        f1 = _valid(p1) & (p1 <= lim + 1e-12)
        f2 = ~f1 & _valid(p2) & (p2 <= lim + 1e-12)
    filled = f1 | f2
    if not filled.any():
        return _empty()
    price = np.where(f1, p1, p2)[filled]
    r = r[filled]
    side_yes = side_yes[filled]
    sub = sub[filled]
    bar = np.where(f1[filled], 1, 2)
    cap = np.where(bar == 1,
                   np.where(side_yes, sub.e1_usd_yes.to_numpy(dtype=float), sub.e1_usd_no.to_numpy(dtype=float)),
                   np.where(side_yes, sub.e2_usd_yes.to_numpy(dtype=float), sub.e2_usd_no.to_numpy(dtype=float)))

    n = np.floor(stake / _cost(price, r) * 100.0 + 1e-9) / 100.0
    for _ in range(50):
        fee = np.ceil(r * n * price * (1.0 - price) * 100.0 - 1e-9) / 100.0
        cost = n * price + fee
        over = (cost > stake + 1e-9) & (n > 0)
        if not over.any():
            break
        n = np.where(over, np.round(n - 0.01, 2), n)
    y = sub.y.to_numpy(dtype=float)
    payout = n * np.where(side_yes, y, 1.0 - y)
    out = pd.DataFrame({
        "ticker": sub.ticker.to_numpy(), "event_ticker": sub.event_ticker.to_numpy(), "milestone_id": sub.milestone_id.to_numpy(),
        "side": np.where(side_yes, "yes", "no"), "q_side": qq[filled], "edge0": edge[chosen][filled], "limit": lim[filled],
        "price": price, "fill_bar": bar, "capacity_usd": cap, "contracts": n, "fee": fee, "cost": cost,
        "payout": payout, "pnl": payout - cost, "y": y,
    })
    for c in PASS_THROUGH:
        if c in sub.columns:
            out[c] = sub[c].to_numpy()
    return out


def _empty() -> pd.DataFrame:
    return pd.DataFrame(columns=["ticker", "event_ticker", "milestone_id", "side", "q_side", "edge0", "limit", "price",
                                 "fill_bar", "capacity_usd", "contracts", "fee", "cost", "payout", "pnl", "y"])


def summarize(bets: pd.DataFrame, n_boot: int = 10000, seed: int = 0) -> dict:
    """Return on dollars staked with a game-clustered bootstrap interval."""
    if len(bets) == 0:
        return {"bets": 0, "games": 0, "staked": 0.0, "pnl": 0.0, "roi": float("nan"), "lo": float("nan"),
                "hi": float("nan"), "p_le_zero": float("nan")}
    games = bets.milestone_id.nunique()
    out = {"bets": int(len(bets)), "games": int(games), "staked": float(bets.cost.sum()), "pnl": float(bets.pnl.sum()),
           "roi": float(bets.pnl.sum() / bets.cost.sum()), "win_rate": float((bets.pnl > 0).mean()),
           "avg_price": float(bets.price.mean()), "median_capacity_usd": float(bets.capacity_usd.median()),
           "fees": float(bets.fee.sum())}
    if games >= 2:
        ci = stats.cluster_bootstrap_ratio(bets.pnl.to_numpy(), bets.cost.to_numpy(), bets.milestone_id.to_numpy(),
                                           n_boot=n_boot, seed=seed)
        out.update(lo=ci.lo, hi=ci.hi, p_le_zero=ci.p_le_zero)
    else:
        out.update(lo=float("nan"), hi=float("nan"), p_le_zero=float("nan"))
    return out
