"""Kalshi's Liquidity Incentive Program, as filed with the CFTC on 2026-10-14
(Appendix B, section 5; effective 2026-10-28).

One side of one book, per snapshot:
  1. Start at the best bid and walk down. At each price add ALL bids there.
  2. The reference price is the first level at which a fifth of the target size
     has accumulated.
  3. Stop at the level where the target size has accumulated. If the bids run
     out first, the side has no qualifying bids.
  4. A bid scores size * discount ** N, N = ticks below the reference price
     (zero at or above it). Scores are divided by the side's total.
A snapshot counts only if both sides reach the target. A user's payout is
reward * (sum of their normalised scores over valid snapshots) / (2 * snapshots),
paid if at least $1.00 and rounded down to the cent.

Sizes are compared in hundredths of a contract and prices in 1/10000 dollar, so
neither a fractional fill nor a float can move a boundary.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from house.grid import UNIT, Grid

Level = tuple[int, float]  # (price in 1/10000 dollar, contracts)


@dataclass(frozen=True)
class SideScore:
    ok: bool
    reference: int | None
    levels: tuple[tuple[int, float, float], ...]  # (price, size, multiplier), best first
    total: float                                   # sum of size * multiplier
    size: float                                    # contracts in qualifying bids
    collateral: float                              # dollars those bids tie up

    @property
    def full_credit_size(self) -> float:
        return sum(s for _, s, m in self.levels if m == 1.0)


NOTHING = SideScore(False, None, (), 0.0, 0.0, 0.0)


def _hundredths(size) -> int:
    return int(round(float(size) * 100))


def qualify(levels, target: float, discount: float, grid: Grid) -> SideScore:
    book = sorted(((int(p), float(s)) for p, s in levels if _hundredths(s) > 0), reverse=True)
    want = _hundredths(target)
    have, reference, chosen = 0, None, []
    for price, size in book:
        have += _hundredths(size)
        chosen.append((price, size))
        if reference is None and 5 * have >= want:
            reference = price
        if have >= want:
            break
    else:
        return NOTHING
    scored = tuple(
        (p, s, 1.0 if p >= reference else discount ** grid.ticks_between(p, reference)) for p, s in chosen
    )
    return SideScore(
        ok=True,
        reference=reference,
        levels=scored,
        total=sum(s * m for _, s, m in scored),
        size=sum(s for _, s, _ in scored),
        collateral=sum(s * p for p, s, _ in scored) / UNIT,
    )


def with_order(levels, price: int, size: float) -> list[Level]:
    out, placed = [], False
    for p, s in levels:
        if int(p) == price:
            out.append((price, float(s) + size))
            placed = True
        else:
            out.append((int(p), float(s)))
    if not placed:
        out.append((price, float(size)))
    return out


def share(levels, price: int, size: float, target: float, discount: float, grid: Grid) -> float:
    """The fraction of this side's score a new order of ``size`` at ``price`` would hold."""
    if size <= 0:
        return 0.0
    side = qualify(with_order(levels, price, size), target, discount, grid)
    for p, _, m in side.levels:
        if p == price:
            return size * m / side.total
    return 0.0


def snapshot_valid(yes, no, target: float, discount: float, grid: Grid) -> bool:
    return qualify(yes, target, discount, grid).ok and qualify(no, target, discount, grid).ok


def payout(reward: float, seconds: int, shares) -> float:
    """``shares`` is one (yes share, no share, snapshot valid) per second observed."""
    earned = reward * sum(y + n for y, n, valid in shares if valid) / (2 * seconds)
    if earned < 1.0 - 1e-12:
        return 0.0
    return math.floor(earned * 100 + 1e-9) / 100
