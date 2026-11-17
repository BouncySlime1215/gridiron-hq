"""Kalshi price grids.

Prices are integers in 1/10000 of a dollar, so 0.901 is 9010 and nothing is
compared as a float. A market's grid comes from its ``price_ranges``: most are
one cent everywhere; "tapered" markets step a tenth of a cent below 10c and
above 90c.
"""
from __future__ import annotations

from dataclasses import dataclass

UNIT = 10_000
CENT = ((0, UNIT, 100),)


def to_units(price) -> int:
    """'0.9010' or 0.901 -> 9010."""
    return int(round(float(price) * UNIT))


@dataclass(frozen=True)
class Grid:
    ranges: tuple[tuple[int, int, int], ...] = CENT  # (start, end, step), ascending

    @classmethod
    def from_market(cls, price_ranges) -> "Grid":
        if not price_ranges:
            return cls()
        rs = sorted((to_units(r["start"]), to_units(r["end"]), to_units(r["step"])) for r in price_ranges)
        if any(step <= 0 or end <= start for start, end, step in rs):
            raise ValueError(f"bad price ranges: {price_ranges}")
        return cls(tuple(rs))

    def ticks_between(self, lo: int, hi: int) -> int:
        """Whole ticks from ``lo`` up to ``hi``. Both must be on the grid."""
        if hi < lo:
            raise ValueError("ticks_between wants lo <= hi")
        n = 0
        for start, end, step in self.ranges:
            a, b = max(lo, start), min(hi, end)
            if b > a:
                q, rem = divmod(b - a, step)
                if rem:
                    raise ValueError(f"{lo} or {hi} is off the grid")
                n += q
        return n

    def step_at(self, price: int, going_up: bool) -> int:
        """The tick size for a move away from ``price`` in the given direction."""
        for start, end, step in self.ranges:
            if (start <= price < end) if going_up else (start < price <= end):
                return step
        raise ValueError(f"{price} has no tick {'above' if going_up else 'below'} it")

    def up(self, price: int, n: int = 1) -> int:
        for _ in range(n):
            price += self.step_at(price, True)
        return price

    def down(self, price: int, n: int = 1) -> int:
        for _ in range(n):
            price -= self.step_at(price, False)
        return price
