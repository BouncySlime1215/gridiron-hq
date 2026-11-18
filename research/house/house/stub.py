"""The cheapest order that earns a reward: one target-size bid at a very low price.

Kalshi's formula pays by contracts resting at or above a side's reference price, not by dollars
at risk. On a side with no meaningful bids, a full-size bid at the lowest price IS the reference
level, earns the side's whole share, and can never lose more than its own cost. This module finds
such orders in a recorded book and refuses the ones that could not rest.

An order can rest only if it does not meet the other side's best bid: a YES bid at p and a NO bid
at q trade against each other when p + q >= 1.
"""
from __future__ import annotations

from dataclasses import dataclass

from house import lip
from house.grid import UNIT, Grid

YES, NO = 1, 0


@dataclass(frozen=True)
class Stub:
    side: int
    price: int          # 1/10000 dollar
    contracts: float
    cost: float         # dollars tied up, which is also the most the order can lose
    per_day: float      # reward per day while the book stays as it is


def can_rest(price: int, other_levels) -> bool:
    best_other = max((int(p) for p, s in other_levels if float(s) > 0), default=0)
    return price + best_other < UNIT


def candidates(levels, grid: Grid, max_price: int) -> list[int]:
    """Prices worth trying: the lowest tick, and every existing level at or under ``max_price``."""
    floor = grid.ranges[0][0] + grid.ranges[0][2]
    return sorted({floor} | {int(p) for p, s in levels if float(s) > 0 and int(p) <= max_price})


def best(yes, no, side: int, per_day: float, target: float, discount: float, grid: Grid,
         max_price: int = 200, contracts: float | None = None) -> Stub | None:
    """The restable order on ``side`` with the highest reward per dollar, or None if nothing earns."""
    mine, other = (yes, no) if side == YES else (no, yes)
    if not lip.qualify(other, target, discount, grid).ok:
        return None                                  # without the other side no snapshot counts
    size = float(contracts or target)
    found = None
    for price in candidates(mine, grid, max_price):
        if price > max_price or not can_rest(price, other):
            continue
        share = lip.share(mine, price, size, target, discount, grid)
        if share <= 0:
            continue
        stub = Stub(side, price, size, size * price / UNIT, 0.5 * per_day * share)
        if found is None or stub.per_day / stub.cost > found.per_day / found.cost:
            found = stub
    return found
