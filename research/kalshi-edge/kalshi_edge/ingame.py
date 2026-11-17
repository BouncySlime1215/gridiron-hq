"""In-game execution on the one-minute table (see scripts/build_ingame_min.py).

An order is decided at the end of minute m from that minute's last prints and sent as
a marketable limit. The earliest thing it can meet is the first same-side taker print
of the next traded minute, so that is the fill, if it is at or under the limit and the
next traded minute is close. The decision minute's own prices are never a fill.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

KEEP = ("ticker", "event_ticker", "milestone_id", "bucket", "mins_in", "taker_rate", "y", "nx_usd")


def taker_entries(df: pd.DataFrame, side: str, lo: float = 0.0, hi: float = 1.0, pay_up: float = 0.0,
                  max_gap: int = 2) -> pd.DataFrame:
    """Rows where a marketable limit for `side` placed at the end of the minute would have filled.

    The band [lo, hi] applies to the decision-time price of the side being bought:
    ask_last for YES, 1 - bid_last for NO. `pay_up` raises the limit above that price.
    Output adds side, quote (decision-time price), limit and price (the fill).
    """
    if side not in ("yes", "no"):
        raise ValueError(f"side must be 'yes' or 'no', got {side!r}")
    if side == "yes":
        quote = df.ask_last.to_numpy(dtype=float)
        nxt = df.nx_ask_first.to_numpy(dtype=float)
    else:
        quote = 1.0 - df.bid_last.to_numpy(dtype=float)
        nxt = 1.0 - df.nx_bid_first.to_numpy(dtype=float)
    limit = quote + pay_up
    with np.errstate(invalid="ignore"):
        ok = (np.isfinite(quote) & np.isfinite(nxt) & (quote >= lo - 1e-12) & (quote <= hi + 1e-12)
              & (nxt > 0) & (nxt <= limit + 1e-12)
              & (df.nx_gap_min.to_numpy(dtype=float) <= max_gap))
    cols = [c for c in df.columns if c in KEEP or c in ("sport", "league", "series", "t_start", "split")]
    out = df.loc[ok, cols].copy()
    out["side"] = side
    out["quote"] = quote[ok]
    out["limit"] = limit[ok]
    out["price"] = nxt[ok]
    return out


def _ticks(x) -> np.ndarray:
    """Prices as integer tenths of a cent, so equal prices compare equal whatever their float width."""
    return np.rint(np.asarray(x, dtype=float) * 1000.0)


def maker_entries(df: pd.DataFrame, kind: str, lo: float = 0.0, hi: float = 1.0, offset: float = 0.0,
                  fill: str = "through", max_gap: int = 2) -> pd.DataFrame:
    """Rows where an order resting for the next traded minute would have been filled.

    kind "bid_favourite": bid for YES at bid_last - offset. Filled when the next minute
        trades below the bid ("through") or at it ("touch"). Holds YES at the bid.
    kind "offer_longshot": offer YES at ask_last + offset. Filled when the next minute
        trades above the offer ("through") or at it ("touch"). Holds NO at 1 - offer.

    "through" is the pessimistic rule: it assumes the order sat at the back of the queue,
    so it is filled only once the whole level has gone, which is exactly when the price
    is moving against it. The band [lo, hi] applies to the price of the side held.
    The fill price is always the resting price, never the better price the market reached.
    """
    if fill not in ("through", "touch"):
        raise ValueError(f"fill must be 'through' or 'touch', got {fill!r}")
    if kind == "bid_favourite":
        rest = df.bid_last.to_numpy(dtype=float) - offset
        held = rest
        ext = df.nx_low.to_numpy(dtype=float)
        hit = _ticks(ext) < _ticks(rest) if fill == "through" else _ticks(ext) <= _ticks(rest)
        side = "yes"
    elif kind == "offer_longshot":
        rest = df.ask_last.to_numpy(dtype=float) + offset
        held = 1.0 - rest
        ext = df.nx_high.to_numpy(dtype=float)
        hit = _ticks(ext) > _ticks(rest) if fill == "through" else _ticks(ext) >= _ticks(rest)
        side = "no"
    else:
        raise ValueError(f"unknown maker kind {kind!r}")
    with np.errstate(invalid="ignore"):
        ok = (np.isfinite(rest) & np.isfinite(ext) & hit & (held > 0) & (held < 1)
              & (held >= lo - 1e-12) & (held <= hi + 1e-12)
              & (df.nx_gap_min.to_numpy(dtype=float) <= max_gap))
    cols = [c for c in df.columns if c in KEEP or c in ("sport", "league", "series", "t_start", "split", "maker_rate")]
    out = df.loc[ok, cols].copy()
    out["side"] = side
    out["quote"] = held[ok]
    out["limit"] = held[ok]
    out["price"] = held[ok]
    return out


def first_entry_per_game(entries: pd.DataFrame) -> pd.DataFrame:
    """Keep the earliest entry of each game: one position per game, no stacking."""
    if len(entries) == 0:
        return entries
    idx = entries.sort_values(["bucket", "ticker"]).groupby("milestone_id", sort=False).head(1).index
    return entries.loc[idx]


def settle(entries: pd.DataFrame, stake: float = 100.0, rate_col: str = "taker_rate") -> pd.DataFrame:
    """Add contracts, fee, cost, payout and pnl for a fixed stake per entry (same rules as backtest.settle).

    `rate_col` names the fee-rate column: taker_rate for marketable orders, maker_rate for resting ones.
    """
    out = entries.copy()
    price = out.price.to_numpy(dtype=float)
    rate = out[rate_col].to_numpy(dtype=float)
    n = np.floor(stake / (price + rate * price * (1.0 - price)) * 100.0 + 1e-9) / 100.0
    for _ in range(50):
        fee = np.ceil(rate * n * price * (1.0 - price) * 100.0 - 1e-9) / 100.0
        cost = n * price + fee
        over = (cost > stake + 1e-9) & (n > 0)
        if not over.any():
            break
        n = np.where(over, np.round(n - 0.01, 2), n)
    y = out.y.to_numpy(dtype=float)
    payout = n * np.where(out.side.to_numpy() == "yes", y, 1.0 - y)
    out["contracts"], out["fee"], out["cost"], out["payout"], out["pnl"] = n, fee, cost, payout, payout - cost
    return out
