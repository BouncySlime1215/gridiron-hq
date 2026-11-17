"""Does a reward last? One newcomer order, valued against any book.

`newcomer` answers: with these two sides of a book, what does `dollars` resting at `price`
on `side` earn per day, as a fraction of the dollars? Called on the book the order was
placed into it gives the entry yield; called on a later book with the same price and size
it gives what the order, never moved, is earning then.
"""
from __future__ import annotations

from house import lip
from house.grid import UNIT, Grid

YES, NO = 1, 0


def newcomer(yes, no, side: int, dollars: float, per_day: float, target: float, discount: float, grid: Grid,
             price: int | None = None) -> tuple[float, int | None, float]:
    """(yield per day, price, contracts). The price defaults to the side's own reference price."""
    mine, other = (yes, no) if side == YES else (no, yes)
    if not lip.qualify(other, target, discount, grid).ok:
        return 0.0, price, 0.0                       # the snapshot does not count without the other side
    if price is None:
        here = lip.qualify(mine, target, discount, grid)
        if not here.ok:
            return 0.0, None, 0.0                    # no reference price to rest at
        price = here.reference
    if price <= 0:
        return 0.0, price, 0.0
    contracts = dollars / (price / UNIT)
    share = lip.share(mine, price, contracts, target, discount, grid)
    return 0.5 * per_day * share / dollars, price, contracts
