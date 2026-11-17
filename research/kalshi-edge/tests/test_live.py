"""Live order tickets: the frozen early-longshot-offer rule applied to current quotes.

A ticket is an instruction a person could type into the app: buy NO at a limit, good
until a stated time. Nothing here places an order.
"""
import datetime as dt

import pytest

from kalshi_edge import live, rules

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 11, 17, 23, 50, tzinfo=UTC)


def game(start_in_min=10, event="KXNBAGAME-26NOV17AAABBB", gid="g1", status="unplayed"):
    return {"id": gid, "title": "AAA at BBB", "start": NOW + dt.timedelta(minutes=start_in_min), "event_ticker": event,
            "sport": "basketball", "status": status}


def market(team="AAA", ask=0.06, bid=0.05, event="KXNBAGAME-26NOV17AAABBB", **kw):
    base = {"ticker": f"{event}-{team}", "event_ticker": event, "series": event.split("-")[0], "status": "active",
            "yes_ask": ask, "yes_bid": bid, "yes_ask_size": 5000.0, "yes_bid_size": 4000.0, "volume": 100000.0,
            "title": f"{team} wins", "maker_rate": 0.0}
    base.update(kw)
    return base


def tickets(games, markets, **kw):
    return live.longshot_tickets(games, markets, now=NOW, bankroll=1000.0, risk_per_position=0.01, **kw)


def test_underdog_inside_the_band_before_the_start_gets_a_buy_no_ticket_at_one_minus_the_ask():
    t = tickets([game()], [market("AAA", 0.06, 0.05), market("BBB", 0.95, 0.94)])
    assert len(t) == 1
    k = t[0]
    assert k["ticker"].endswith("-AAA") and k["action"] == "buy" and k["side"] == "no"
    assert k["limit_price"] == pytest.approx(0.94)             # join the offer: sell YES at 6c = buy NO at 94c
    assert k["yes_offer"] == pytest.approx(0.06)
    assert k["expires"] == NOW + dt.timedelta(minutes=10 + 45)   # 45 minutes after the scheduled start
    assert k["stake"] == pytest.approx(10.0)                   # 1% of a $1,000 bankroll
    assert k["contracts"] == pytest.approx(10.63, abs=0.01)    # 10 / 0.94, floored to 0.01
    assert k["max_loss"] == pytest.approx(k["contracts"] * 0.94, abs=0.01)
    assert k["max_gain"] == pytest.approx(k["contracts"] * 0.06, abs=0.01)


def test_band_edges_follow_the_frozen_rule():
    lo, hi = rules.EARLY_LONGSHOT_OFFER["lo"], rules.EARLY_LONGSHOT_OFFER["hi"]
    assert (lo, hi) == (0.90, 0.97)
    assert len(tickets([game()], [market(ask=0.10, bid=0.09)])) == 1     # NO 0.90
    assert len(tickets([game()], [market(ask=0.11, bid=0.10)])) == 0     # NO 0.89
    assert len(tickets([game()], [market(ask=0.03, bid=0.02)])) == 1     # NO 0.97
    assert len(tickets([game()], [market(ask=0.02, bid=0.01)])) == 0     # NO 0.98


def test_time_window_is_shortly_before_the_start_until_45_minutes_in():
    assert len(tickets([game(start_in_min=61)], [market()])) == 0                      # too early
    assert len(tickets([game(start_in_min=60)], [market()])) == 1
    assert len(tickets([game(start_in_min=-44, status="live")], [market()])) == 1      # 44 minutes in
    assert len(tickets([game(start_in_min=-45, status="live")], [market()])) == 0      # the window has closed
    assert len(tickets([game(start_in_min=30)], [market()], lead_minutes=20)) == 0


def test_one_ticket_per_game_the_most_traded_market():
    ms = [market("AAA", 0.06, 0.05, volume=100.0), market("TIE", 0.08, 0.07, volume=900.0)]
    t = tickets([game()], ms)
    assert len(t) == 1 and t[0]["ticker"].endswith("-TIE")


def test_unusable_quotes_give_no_ticket():
    assert tickets([game()], [market(ask=None)]) == []
    assert tickets([game()], [market(ask=0.06, bid=0.07)]) == []            # crossed
    assert tickets([game()], [market(ask=0.06, bid=0.0)]) == []             # no bid: a one-sided book is not a market
    assert tickets([game()], [market(status="closed")]) == []
    assert tickets([game(status="completed")], [market()]) == []


def test_only_game_winner_markets_are_considered():
    assert tickets([game(event="KXNBASPREAD-26NOV17AAABBB")], [market(event="KXNBASPREAD-26NOV17AAABBB")]) == []


def test_maker_fee_is_shown_when_the_series_charges_one():
    t = tickets([game()], [market(maker_rate=0.0175)])[0]
    assert t["maker_fee"] > 0
    assert tickets([game()], [market()])[0]["maker_fee"] == 0.0
