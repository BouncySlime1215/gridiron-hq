"""Live order tickets from current quotes. Pure: no network, no orders.

The rule is kalshi_edge.rules.EARLY_LONGSHOT_OFFER: in a game-winner market, when the
underdog's YES is offered between 3c and 10c, join that offer (which is the same as
bidding for NO at one minus the offer) from shortly before the start until 45 minutes
in. A ticket says what to type: buy NO, limit price, size, good-until time.
"""
from __future__ import annotations

import datetime as dt
import math

from kalshi_edge import fees, rules, taxonomy

OPEN_STATUSES = {"active", "open"}
DEAD_GAME_STATUSES = {"completed", "closed", "final", "cancelled", "canceled", "postponed"}


def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) else v


def longshot_tickets(games: list[dict], markets: list[dict], now: dt.datetime, bankroll: float,
                     risk_per_position: float = 0.01, lead_minutes: int = 60, include_in_game: bool = False,
                     max_spread: float = 0.03) -> list[dict]:
    """One buy-NO ticket per qualifying game.

    games:   {id, title, start (aware datetime), event_ticker, sport, status}
    markets: {ticker, event_ticker, series, status, yes_ask, yes_bid, volume, maker_rate, ...}
    A game qualifies from `lead_minutes` before its scheduled start until the start:
    one order, placed before the game and left to rest until 45 minutes in. That is the
    form that was positive on train, validation and the holdout (S11). Writing new
    tickets once a game is under way (`include_in_game=True`) is the A2 form, which lost
    on the holdout; it is kept only so that form can be tracked separately.
    When several markets of a game qualify, the most traded one is used.
    """
    spec = rules.EARLY_LONGSHOT_OFFER
    by_event: dict[str, list[dict]] = {}
    for m in markets:
        by_event.setdefault(m["event_ticker"], []).append(m)
    out = []
    for g in games:
        if str(g.get("status") or "").lower() in DEAD_GAME_STATUSES:
            continue
        if taxonomy.family_of(g["event_ticker"].split("-")[0]) != "winner":
            continue
        mins_to_start = (g["start"] - now).total_seconds() / 60.0
        if mins_to_start > lead_minutes or -mins_to_start >= spec["max_mins_in"]:
            continue
        if mins_to_start <= 0 and not include_in_game:
            continue
        best = None
        for m in by_event.get(g["event_ticker"], []):
            ask, bid = _num(m.get("yes_ask")), _num(m.get("yes_bid"))
            if str(m.get("status") or "").lower() not in OPEN_STATUSES or ask is None or bid is None:
                continue
            if not (0.0 < bid < ask < 1.0) or ask - bid > max_spread + 1e-9:
                continue
            offer = math.ceil(round(ask * 1000) / 10.0 - 1e-9) / 100.0
            no_price = round(1.0 - offer, 4)
            if not (spec["lo"] - 1e-9 <= no_price <= spec["hi"] + 1e-9):
                continue
            if best is None or (_num(m.get("volume")) or 0.0) > (_num(best[0].get("volume")) or 0.0):
                best = (m, offer, no_price)
        if best is None:
            continue
        m, offer, no_price = best
        stake = bankroll * risk_per_position
        contracts = math.floor(stake / no_price * 100 + 1e-9) / 100
        maker_rate = _num(m.get("maker_rate")) or 0.0
        out.append({
            "ticker": m["ticker"], "event_ticker": g["event_ticker"], "game_id": g["id"], "game": g.get("title"), "sport": g.get("sport"),
            "market": m.get("title"), "action": "buy", "side": "no", "limit_price": no_price, "yes_offer": offer,
            "yes_bid": _num(m.get("yes_bid")), "stake": round(stake, 2), "contracts": contracts,
            "max_loss": round(contracts * no_price, 2), "max_gain": round(contracts * offer, 2),
            "maker_fee": fees.taker_fee(contracts, no_price, rate=maker_rate) if maker_rate > 0 else 0.0,
            "start": g["start"], "expires": g["start"] + dt.timedelta(minutes=spec["max_mins_in"]),
            "mins_to_start": round(mins_to_start, 1), "volume": _num(m.get("volume")),
            "phase_at_placement": "pre" if mins_to_start > 0 else "in-game",
        })
    return out


def collapse_ledger(rows: list[dict]) -> list[dict]:
    """One order per market from an append-only ledger, in first-seen order.

    The scanner may see the same market many times. The order it stands for is placed
    once: it keeps its first price and its first placement time. If the scheduled start
    slips while the order is still resting, a later row moves the start and the
    good-until time; a row written after the window had already closed changes nothing.
    Timestamps are ISO-8601 UTC strings of one format, so they compare as text.
    """
    out: dict[str, dict] = {}
    for r in rows:
        cur = out.get(r["ticker"])
        if cur is None:
            out[r["ticker"]] = dict(r, times_seen=1)
            continue
        cur["times_seen"] += 1
        if r["placed_at"] <= cur["expires"] and r["expires"] != cur["expires"]:
            cur["expires"], cur["start"] = r["expires"], r["start"]
    return list(out.values())
