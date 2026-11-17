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


def test_tickets_are_written_before_the_start_only_by_default():
    # The holdout result: re-offering minute by minute once a game is under way (rule A2) lost money.
    # The version that held up in every split places ONE order before the start and leaves it.
    assert len(tickets([game(start_in_min=61)], [market()])) == 0                      # too early
    assert len(tickets([game(start_in_min=60)], [market()])) == 1
    assert len(tickets([game(start_in_min=0.5)], [market()])) == 1
    assert len(tickets([game(start_in_min=-1, status="live")], [market()])) == 0       # already started: no new order
    assert len(tickets([game(start_in_min=30)], [market()], lead_minutes=20)) == 0
    assert tickets([game(start_in_min=10)], [market()])[0]["phase_at_placement"] == "pre"


def test_in_game_tickets_are_an_explicit_opt_in_and_are_labelled():
    t = tickets([game(start_in_min=-44, status="live")], [market()], include_in_game=True)
    assert len(t) == 1 and t[0]["phase_at_placement"] == "in-game"
    assert len(tickets([game(start_in_min=-45, status="live")], [market()], include_in_game=True)) == 0   # the window has closed


def test_wide_spread_is_not_a_market_to_join():
    assert len(tickets([game()], [market(ask=0.06, bid=0.03)])) == 1                   # 3c spread: the default limit
    assert len(tickets([game()], [market(ask=0.08, bid=0.03)])) == 0                   # 5c: the offer is not a real price
    assert len(tickets([game()], [market(ask=0.08, bid=0.03)], max_spread=0.05)) == 1


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


# --- the forward ledger: one order per market, however often the scanner sees it ---------------

def led(ticker="KXA-1-X", placed="2026-11-17T19:00:00Z", expires="2026-11-17T20:15:00Z", limit=0.93, **kw):
    base = {"ticker": ticker, "placed_at": placed, "start": "2026-11-17T19:30:00Z", "expires": expires, "limit_price": limit,
            "yes_offer": round(1 - limit, 2), "contracts": 10.75, "max_loss": 10.0, "max_gain": 0.75, "maker_fee": 0.0, "mins_to_start": 30.0}
    base.update(kw)
    return base


def test_ledger_keeps_one_order_per_market_at_its_first_price():
    rows = [led(limit=0.93), led(placed="2026-11-17T19:10:00Z", limit=0.92)]      # the scanner saw it again at a new quote
    out = live.collapse_ledger(rows)
    assert len(out) == 1
    assert out[0]["placed_at"] == "2026-11-17T19:00:00Z" and out[0]["limit_price"] == 0.93     # the resting order is not re-priced


def test_ledger_follows_a_start_time_that_slips():
    # a tennis match scheduled for 19:30 actually goes on at 20:00: the order must rest until 45 minutes after the real start
    rows = [led(expires="2026-11-17T20:15:00Z"), led(placed="2026-11-17T19:20:00Z", expires="2026-11-17T20:45:00Z", start="2026-11-17T20:00:00Z")]
    out = live.collapse_ledger(rows)
    assert len(out) == 1 and out[0]["expires"] == "2026-11-17T20:45:00Z" and out[0]["start"] == "2026-11-17T20:00:00Z"
    assert out[0]["placed_at"] == "2026-11-17T19:00:00Z"
    assert out[0]["times_seen"] == 2


def test_ledger_does_not_extend_an_order_after_its_window_has_closed():
    # a later row that was written after the first window had already shut is a new sighting of a dead order, not an extension
    rows = [led(expires="2026-11-17T20:15:00Z"), led(placed="2026-11-17T20:30:00Z", expires="2026-11-17T21:15:00Z")]
    out = live.collapse_ledger(rows)
    assert len(out) == 1 and out[0]["expires"] == "2026-11-17T20:15:00Z"


def test_ledger_keeps_markets_apart_and_in_first_seen_order():
    rows = [led("KXB-2-Y", placed="2026-11-17T18:00:00Z"), led("KXA-1-X"), led("KXB-2-Y", placed="2026-11-17T18:10:00Z")]
    assert [r["ticker"] for r in live.collapse_ledger(rows)] == ["KXB-2-Y", "KXA-1-X"]
