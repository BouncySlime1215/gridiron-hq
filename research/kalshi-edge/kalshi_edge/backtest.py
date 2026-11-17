"""Bet accounting: the limit a model edge implies, whether it fills, and what it pays.

All prices are dollars per contract for the side being bought. A YES buy pays the
yes price; a NO buy pays one minus the yes price at which a NO taker printed.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from kalshi_edge import fees


@dataclass(frozen=True)
class Settled:
    side: str
    price: float
    contracts: float
    fee: float
    cost: float
    payout: float
    pnl: float


def _valid_price(x) -> bool:
    return x is not None and not (isinstance(x, float) and math.isnan(x)) and 0.0 < float(x) <= 1.0


def limit_price(q: float, tau: float, rate: float = fees.TAKER_BASE) -> float | None:
    """Highest price at which buying a side with win probability q still leaves an edge of tau after the fee.

    Solves price + rate * price * (1 - price) = q - tau. None when no price qualifies.
    """
    target = q - tau
    if target <= 0.0:
        return None
    if target >= 1.0:
        return 1.0
    if rate == 0.0:
        return target
    disc = (1.0 + rate) ** 2 - 4.0 * rate * target
    return min(1.0, ((1.0 + rate) - math.sqrt(disc)) / (2.0 * rate))


def fill_price(limit: float | None, prints) -> float | None:
    """Price of the first print at or under the limit; None when the order would not have filled."""
    if limit is None:
        return None
    for p in prints:
        if _valid_price(p) and float(p) <= limit + 1e-12:
            return float(p)
    return None


def edges(q: float, ask, bid, rate: float = fees.TAKER_BASE) -> tuple[float | None, float | None]:
    """(edge buying YES at the ask, edge buying NO against the bid), each None if that quote is missing."""
    e_yes = q - fees.taker_cost_per_contract(float(ask), rate) if _valid_price(ask) else None
    no_price = 1.0 - float(bid) if _valid_price(bid) else None
    e_no = (1.0 - q) - fees.taker_cost_per_contract(no_price, rate) if _valid_price(no_price) else None
    return e_yes, e_no


def settle(side: str, price: float, settle_yes: float, rate: float = fees.TAKER_BASE, stake: float = 100.0) -> Settled:
    """Buy as many contracts of `side` at `price` as `stake` covers including the fee, then settle.

    `settle_yes` is what a YES contract paid (1, 0, or a fair value on a void).
    The contract count is floored to 0.01 and reduced until cost + fee fits the stake.
    """
    if side not in ("yes", "no"):
        raise ValueError(f"side must be 'yes' or 'no', got {side!r}")
    if not _valid_price(price):
        raise ValueError(f"price must be in (0, 1], got {price!r}")
    if not 0.0 <= settle_yes <= 1.0:
        raise ValueError(f"settlement value outside [0, 1]: {settle_yes!r}")
    per_contract = fees.taker_cost_per_contract(price, rate)
    n = math.floor(stake / per_contract * 100 + 1e-9) / 100
    while n > 0:
        fee = fees.taker_fee(n, price, rate)
        cost = n * price + fee
        if cost <= stake + 1e-9:
            break
        n = round(n - 0.01, 2)
    else:
        fee, cost = 0.0, 0.0
    payout = n * (settle_yes if side == "yes" else 1.0 - settle_yes)
    return Settled(side, price, n, fee, cost, payout, payout - cost)
