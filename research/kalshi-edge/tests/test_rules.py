"""The frozen rules, as named in PREREGISTRATION.md Amendment 1. One code path for validation, holdout and live."""
import datetime as dt

import numpy as np
import pandas as pd
import pytest

from kalshi_edge import ingame, rules

UTC = dt.timezone.utc
T0 = dt.datetime(2026, 11, 16, 19, 0, tzinfo=UTC)


def m(minute, game="g1", ticker="KXA-1-X", **kw):
    base = dict(ticker=ticker, event_ticker="KXA-1", milestone_id=game, bucket=T0 + dt.timedelta(minutes=minute), mins_in=minute,
                ask_last=0.06, bid_last=0.05, nx_ask_first=0.06, nx_bid_first=0.05, nx_gap_min=1, nx_low=0.05, nx_high=0.08,
                nx_usd=300.0, taker_rate=0.07, maker_rate=0.0, y=0.0)
    base.update(kw)
    return base


def test_early_longshot_offer_takes_the_first_traded_through_offer_in_the_first_45_minutes():
    rows = [m(50, nx_high=0.09),                       # too late in the game
            m(30, nx_high=0.06),                       # only touched: not a pessimistic fill
            m(40),                                     # qualifies
            m(20, game="g2", ask_last=0.20, nx_high=0.30),   # NO price 0.80: outside the band
            m(10, game="g3", ask_last=0.02, nx_high=0.05)]   # NO price 0.98: outside the band
    b = rules.early_longshot_offer(pd.DataFrame(rows))
    assert b.milestone_id.tolist() == ["g1"] and b.mins_in.tolist() == [40]
    assert b.side.iloc[0] == "no" and b.price.iloc[0] == pytest.approx(0.94)
    assert b.cost.iloc[0] <= 100.0 and b.pnl.iloc[0] > 0


def test_early_longshot_offer_keeps_one_position_per_game_and_pays_the_maker_fee():
    rows = [m(5), m(6), m(7, ticker="KXA-1-Y"), m(8, game="g2", maker_rate=0.0175, y=1.0)]
    b = rules.early_longshot_offer(pd.DataFrame(rows)).set_index("milestone_id")
    assert len(b) == 2 and b.loc["g1"].mins_in == 5
    assert b.loc["g1"].fee == 0.0 and b.loc["g2"].fee > 0
    assert b.loc["g2"].pnl == pytest.approx(-b.loc["g2"].cost)        # the longshot won: the NO position is lost


def test_touch_variant_is_the_optimistic_bound_not_the_default():
    rows = [m(30, nx_high=0.06)]
    assert len(rules.early_longshot_offer(pd.DataFrame(rows))) == 0
    assert len(rules.early_longshot_offer(pd.DataFrame(rows), fill="touch")) == 1


def test_spec_is_the_single_source_of_the_rule_parameters():
    s = rules.EARLY_LONGSHOT_OFFER
    assert (s["kind"], s["lo"], s["hi"], s["max_mins_in"], s["fill"], s["stake"]) == ("offer_longshot", 0.90, 0.97, 45, "through", 100.0)
    # a row exactly at the edges
    assert len(rules.early_longshot_offer(pd.DataFrame([m(44, ask_last=0.10, nx_high=0.11)]))) == 1     # NO 0.90, minute 44
    assert len(rules.early_longshot_offer(pd.DataFrame([m(45, ask_last=0.10, nx_high=0.11)]))) == 0     # minute 45 is out
    assert len(rules.early_longshot_offer(pd.DataFrame([m(10, ask_last=0.03, nx_high=0.04)]))) == 1     # NO 0.97
    assert len(rules.early_longshot_offer(pd.DataFrame([m(10, ask_last=0.11, nx_high=0.12)]))) == 0     # NO 0.89


def test_favourite_carry_taker_rule_is_one_marketable_order_per_game_in_its_band():
    rows = [m(10, ask_last=0.96, bid_last=0.95, nx_ask_first=0.96, nx_bid_first=0.95, y=1.0),
            m(12, ask_last=0.97, bid_last=0.96, nx_ask_first=0.97, nx_bid_first=0.96, y=1.0),
            m(15, game="g2", ask_last=0.90, bid_last=0.89, nx_ask_first=0.90, nx_bid_first=0.89, y=1.0)]   # below the band
    b = rules.favourite_carry(pd.DataFrame(rows))
    assert b.milestone_id.tolist() == ["g1"] and b.mins_in.tolist() == [10] and b.side.iloc[0] == "yes"
    assert b.fee.iloc[0] > 0                                                                               # takers pay
