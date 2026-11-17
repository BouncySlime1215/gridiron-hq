"""Kalshi fee model.

Kalshi charges a quadratic fee, rate * contracts * price * (1 - price). The base
taker rate is 7%; series marked "quadratic_with_maker_fees" also charge resting
(maker) orders a quarter of that. A per-series multiplier scales both (for
example 0.5 on some prop series). The fee is largest at 50c and vanishes at the
extremes, which is where a favourite-longshot bias would live.

Balances move in whole cents for ordinary (non-direct-member) accounts, so the
amount actually charged on an order is rounded up to the next cent.
"""
from __future__ import annotations

import math

TAKER_BASE = 0.07
MAKER_BASE = 0.0175


def _check(count: float, price: float) -> None:
    if count < 0:
        raise ValueError(f"negative contract count: {count}")
    if not 0.0 <= price <= 1.0:
        raise ValueError(f"price outside [0, 1]: {price}")


def _ceil_cent(x: float) -> float:
    return math.ceil(x * 100 - 1e-9) / 100


def taker_fee(count: float, price: float, rate: float = TAKER_BASE, round_up: bool = True) -> float:
    """Fee in dollars for taking `count` contracts at `price` (dollars per contract)."""
    _check(count, price)
    fee = rate * count * price * (1.0 - price)
    return _ceil_cent(fee) if round_up else fee


def taker_cost_per_contract(price: float, rate: float = TAKER_BASE) -> float:
    """All-in cost of one contract bought as a taker, ignoring cent rounding.

    A buy is +EV only if the true probability exceeds this number.
    """
    _check(1, price)
    return price + rate * price * (1.0 - price)


def series_rates(series: dict) -> tuple[float, float]:
    """(taker_rate, maker_rate) for a series record from GET /series."""
    mult = series.get("fee_multiplier")
    mult = 1.0 if mult is None else float(mult)
    fee_type = series.get("fee_type")
    if fee_type == "quadratic":
        return TAKER_BASE * mult, 0.0
    if fee_type == "quadratic_with_maker_fees":
        return TAKER_BASE * mult, MAKER_BASE * mult
    raise ValueError(f"unknown fee_type {fee_type!r}: refusing to price it at zero")
