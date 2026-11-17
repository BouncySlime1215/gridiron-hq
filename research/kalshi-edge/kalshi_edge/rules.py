"""The frozen rules named in PREREGISTRATION.md Amendment 1.

One code path for validation, the holdout and the live scanner. The parameters live in
the two dicts below and nowhere else.
"""
from __future__ import annotations

import pandas as pd

from kalshi_edge import ingame

# A2: rest an offer on the longshot early in the game; pessimistic (traded-through) fills.
EARLY_LONGSHOT_OFFER = {
    "kind": "offer_longshot",
    "lo": 0.90,            # NO price band (the longshot's YES offer is 3c to 10c)
    "hi": 0.97,
    "max_mins_in": 45,     # minutes since the scheduled start, exclusive
    "fill": "through",
    "stake": 100.0,
}

# S8: buy the heavy favourite with a marketable order; expected to be about zero after fees.
FAVOURITE_CARRY = {
    "lo": 0.95,
    "hi": 0.98,
    "stake": 100.0,
}


def early_longshot_offer(df: pd.DataFrame, fill: str | None = None, every_minute: bool = False) -> pd.DataFrame:
    """Settled positions of the early longshot offer on an in-game minute table.

    `fill="touch"` gives the optimistic bound; `every_minute=True` keeps every fill
    instead of the first per game (for the clustered every-minute summary only).
    """
    s = EARLY_LONGSHOT_OFFER
    early = df[df.mins_in < s["max_mins_in"]]
    e = ingame.maker_entries(early, kind=s["kind"], lo=s["lo"], hi=s["hi"], fill=fill or s["fill"])
    if not every_minute:
        e = ingame.first_entry_per_game(e)
    return ingame.settle(e, stake=s["stake"], rate_col="maker_rate")


def favourite_carry(df: pd.DataFrame) -> pd.DataFrame:
    """Settled positions of the favourite-carry taker rule: first qualifying minute per game, either side."""
    s = FAVOURITE_CARRY
    e = pd.concat([ingame.taker_entries(df, side=side, lo=s["lo"], hi=s["hi"]) for side in ("yes", "no")])
    return ingame.settle(ingame.first_entry_per_game(e), stake=s["stake"])
