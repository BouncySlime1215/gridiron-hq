"""The frozen rules named in PREREGISTRATION.md Amendment 1.

One code path for validation, the holdout and the live scanner. The parameters live in
the two dicts below and nowhere else.
"""
from __future__ import annotations

import numpy as np
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


# S11: one resting offer set shortly before the start and left until the window closes.
STATIC_LONGSHOT_OFFER = {
    "ask_lo": 0.03,        # the underdog's YES offer, taken from the last YES-taker print before the decision
    "ask_hi": 0.10,
    "minutes": 45,         # the order rests until this many minutes after the scheduled start
    "max_quote_age": 30,   # both the last YES-taker and NO-taker prints must be this fresh
    "max_spread": 0.10,
    "fill": "through",
    "stake": 100.0,
}


def static_longshot_offer(df: pd.DataFrame, fill: str | None = None) -> pd.DataFrame:
    """Settled positions of the before-kickoff offer on a pre-game snapshot table.

    `df` is the h = 10 snapshot table with one extra column, `hi_in`: the highest price
    the market traded at during the first `minutes` of the game (NaN if it did not trade).
    The order is an offer at the last YES-taker price, moved up to a whole cent. It is
    filled when the market trades above it (`through`) or at it (`touch`) at any point
    between the decision and the end of the window. The position is NO at one minus the
    offer. One position per game: of the offers that filled, the market with the most
    pre-game dollars. `.attrs["posted"]` is the number of orders that were placed.
    """
    s = STATIC_LONGSHOT_OFFER
    fill = fill or s["fill"]
    if fill not in ("through", "touch"):
        raise ValueError(f"fill must be 'through' or 'touch', got {fill!r}")
    d = df[(df.family == "winner") & (~df.period.astype(bool))]
    ok = ((d.ask0_age_min <= s["max_quote_age"]) & (d.bid0_age_min <= s["max_quote_age"])
          & ((d.ask0 - d.bid0).between(0, s["max_spread"])) & d.ask0.between(s["ask_lo"] - 1e-9, s["ask_hi"] + 1e-9))
    d = d[ok]
    ask = d.ask0.to_numpy(dtype=float)
    offer = np.ceil(np.rint(ask * 1000.0) / 10.0 - 1e-9) / 100.0
    top = np.fmax(d.w_high.fillna(-1.0).to_numpy(dtype=float), d.hi_in.fillna(-1.0).to_numpy(dtype=float))
    hit = np.rint(top * 1000.0) > np.rint(offer * 1000.0) if fill == "through" else np.rint(top * 1000.0) >= np.rint(offer * 1000.0)
    e = d[hit].copy()
    e["side"], e["price"] = "no", 1.0 - offer[hit]
    e = e.sort_values("usd", ascending=False).groupby("milestone_id", sort=False).head(1)
    out = ingame.settle(e, stake=s["stake"], rate_col="maker_rate")
    out.attrs["posted"] = int(len(d))
    return out


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
