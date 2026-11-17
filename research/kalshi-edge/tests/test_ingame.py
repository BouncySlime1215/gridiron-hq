"""In-game execution: an order sent at the end of minute m meets the FIRST print of the next minute.

The fill never uses a price from the decision minute itself and never looks further
than the next traded minute. One position per game: the first qualifying minute.
"""
import datetime as dt

import numpy as np
import pandas as pd
import pytest

from kalshi_edge import backtest as bt
from kalshi_edge import ingame

UTC = dt.timezone.utc
T0 = dt.datetime(2026, 11, 16, 19, 0, tzinfo=UTC)


def row(minute=10, **kw):
    base = dict(ticker="KXA-1-X", event_ticker="KXA-1", milestone_id="g1", bucket=T0 + dt.timedelta(minutes=minute),
                mins_in=minute, ask_last=0.95, bid_last=0.94, nx_ask_first=0.95, nx_bid_first=0.94, nx_gap_min=1,
                nx_usd=500.0, taker_rate=0.07, y=1.0)
    base.update(kw)
    return base


def test_yes_order_fills_at_the_next_minutes_first_print_when_it_is_at_or_under_the_limit():
    e = ingame.taker_entries(pd.DataFrame([row(nx_ask_first=0.94)]), side="yes")
    assert len(e) == 1
    assert e.limit.iloc[0] == pytest.approx(0.95) and e.price.iloc[0] == pytest.approx(0.94)


def test_yes_order_does_not_fill_when_the_price_has_run_away():
    assert len(ingame.taker_entries(pd.DataFrame([row(nx_ask_first=0.96)]), side="yes")) == 0
    e = ingame.taker_entries(pd.DataFrame([row(nx_ask_first=0.96)]), side="yes", pay_up=0.01)
    assert len(e) == 1 and e.price.iloc[0] == pytest.approx(0.96) and e.limit.iloc[0] == pytest.approx(0.96)


def test_no_fill_without_a_same_side_print_next_minute_or_when_the_next_minute_is_far():
    nan = float("nan")
    assert len(ingame.taker_entries(pd.DataFrame([row(nx_ask_first=nan)]), side="yes")) == 0
    assert len(ingame.taker_entries(pd.DataFrame([row(nx_gap_min=3)]), side="yes")) == 0
    assert len(ingame.taker_entries(pd.DataFrame([row(nx_gap_min=3)]), side="yes", max_gap=3)) == 1
    assert len(ingame.taker_entries(pd.DataFrame([row(ask_last=nan)]), side="yes")) == 0      # no quote to price off


def test_no_side_buys_against_the_bid():
    # YES bid 0.06 -> NO costs 0.94. Next minute's first NO taker hits 0.07 -> NO costs 0.93 (better): fill
    e = ingame.taker_entries(pd.DataFrame([row(ask_last=0.07, bid_last=0.06, nx_bid_first=0.07, nx_ask_first=0.08, y=0.0)]), side="no")
    assert len(e) == 1
    assert e.limit.iloc[0] == pytest.approx(0.94) and e.price.iloc[0] == pytest.approx(0.93)
    # bid drops to 0.05 -> NO would cost 0.95 > limit: no fill
    assert len(ingame.taker_entries(pd.DataFrame([row(ask_last=0.07, bid_last=0.06, nx_bid_first=0.05)]), side="no")) == 0


def test_price_band_is_applied_to_the_price_of_the_side_being_bought_at_decision_time():
    rows = [row(minute=1, ask_last=0.89), row(minute=2, ask_last=0.95), row(minute=3, ask_last=0.995, nx_ask_first=0.995)]
    e = ingame.taker_entries(pd.DataFrame(rows), side="yes", lo=0.90, hi=0.99)
    assert e.mins_in.tolist() == [2]
    rows = [row(minute=1, bid_last=0.04, nx_bid_first=0.04), row(minute=2, bid_last=0.20, nx_bid_first=0.20)]
    e = ingame.taker_entries(pd.DataFrame(rows), side="no", lo=0.90, hi=0.99)      # NO price 0.96 qualifies, 0.80 does not
    assert e.mins_in.tolist() == [1]


def test_first_entry_per_game_is_the_earliest_and_later_ones_are_dropped():
    rows = [row(minute=30, ticker="KXA-1-X"), row(minute=12, ticker="KXA-1-Y", nx_ask_first=0.95),
            row(minute=20, ticker="KXB-2-X", milestone_id="g2", event_ticker="KXB-2")]
    e = ingame.first_entry_per_game(ingame.taker_entries(pd.DataFrame(rows), side="yes"))
    assert sorted(zip(e.milestone_id, e.mins_in)) == [("g1", 12), ("g2", 20)]


def test_settlement_matches_the_scalar_money_function_on_both_sides():
    rng = np.random.default_rng(5)
    rows = [row(minute=i, milestone_id=f"g{i}", ask_last=0.9 + i / 1000, nx_ask_first=0.9 + i / 1000,
                taker_rate=rng.choice([0.07, 0.035]), y=float(rng.choice([0.0, 1.0, 0.5]))) for i in range(60)]
    e = ingame.settle(ingame.taker_entries(pd.DataFrame(rows), side="yes"))
    for r in e.itertuples():
        ref = bt.settle("yes", r.price, r.y, r.taker_rate, 100.0)
        assert r.pnl == pytest.approx(ref.pnl) and r.cost == pytest.approx(ref.cost) and r.contracts == pytest.approx(ref.contracts)
    rows = [row(minute=i, milestone_id=f"g{i}", bid_last=0.05, nx_bid_first=0.05, y=float(i % 7 == 0)) for i in range(30)]
    e = ingame.settle(ingame.taker_entries(pd.DataFrame(rows), side="no"))
    for r in e.itertuples():
        ref = bt.settle("no", r.price, r.y, r.taker_rate, 100.0)
        assert r.pnl == pytest.approx(ref.pnl)


def test_the_decision_minute_is_never_the_fill():
    # the decision minute printed 0.90 but the next minute opens at 0.97: the order (limit 0.90) must not fill at 0.90
    e = ingame.taker_entries(pd.DataFrame([row(ask_last=0.90, nx_ask_first=0.97)]), side="yes")
    assert len(e) == 0


# --- resting (maker) orders in-game ---------------------------------------------------------------

def mrow(minute=10, **kw):
    base = row(minute, nx_low=0.94, nx_high=0.95, maker_rate=0.0)
    base.update(kw)
    return base


def test_bid_for_the_favourite_fills_only_when_the_next_minute_trades_through_it():
    # bid 0.94 rests for the next minute
    assert len(ingame.maker_entries(pd.DataFrame([mrow(nx_low=0.94)]), kind="bid_favourite")) == 0      # touched, not through
    e = ingame.maker_entries(pd.DataFrame([mrow(nx_low=0.93)]), kind="bid_favourite")
    assert len(e) == 1 and e.side.iloc[0] == "yes" and e.price.iloc[0] == pytest.approx(0.94)            # bought at the bid, not at 0.93
    assert len(ingame.maker_entries(pd.DataFrame([mrow(nx_low=0.94)]), kind="bid_favourite", fill="touch")) == 1


def test_touch_and_through_are_exact_on_the_tick_grid_even_with_single_precision_prices():
    r = mrow(nx_low=float(np.float32(0.94)))      # 0.9399999976..., a tick-equal price that is "less than" 0.94 in floating point
    assert len(ingame.maker_entries(pd.DataFrame([r]), kind="bid_favourite")) == 0
    assert len(ingame.maker_entries(pd.DataFrame([r]), kind="bid_favourite", fill="touch")) == 1
    r = mrow(ask_last=0.06, bid_last=0.05, nx_high=float(np.float32(0.06)), nx_low=0.05)
    assert len(ingame.maker_entries(pd.DataFrame([r]), kind="offer_longshot")) == 0
    assert len(ingame.maker_entries(pd.DataFrame([r]), kind="offer_longshot", fill="touch")) == 1


def test_offer_of_the_longshot_is_a_long_no_position_at_one_minus_the_offer():
    r = mrow(ask_last=0.06, bid_last=0.05, nx_high=0.08, nx_low=0.05, y=0.0)
    e = ingame.maker_entries(pd.DataFrame([r]), kind="offer_longshot")
    assert len(e) == 1 and e.side.iloc[0] == "no"
    assert e.price.iloc[0] == pytest.approx(0.94)        # sold YES at 0.06 = bought NO at 0.94
    s = ingame.settle(e, rate_col="maker_rate")
    assert s.pnl.iloc[0] == pytest.approx(bt.settle("no", 0.94, 0.0, 0.0, 100.0).pnl)
    assert s.fee.iloc[0] == 0.0


def test_offset_moves_the_resting_price_away_from_the_market():
    r = mrow(nx_low=0.92)
    e = ingame.maker_entries(pd.DataFrame([r]), kind="bid_favourite", offset=0.01)       # bid 0.93, low 0.92: through
    assert len(e) == 1 and e.price.iloc[0] == pytest.approx(0.93)
    assert len(ingame.maker_entries(pd.DataFrame([r]), kind="bid_favourite", offset=0.02)) == 0   # bid 0.92: only touched
    r = mrow(ask_last=0.06, bid_last=0.05, nx_high=0.09)
    e = ingame.maker_entries(pd.DataFrame([r]), kind="offer_longshot", offset=0.02)      # offer 0.08, high 0.09: through
    assert len(e) == 1 and e.price.iloc[0] == pytest.approx(0.92)


def test_maker_band_applies_to_the_price_of_the_side_held_and_the_gap_rule_holds():
    rows = [mrow(minute=1, bid_last=0.85, nx_low=0.80), mrow(minute=2, bid_last=0.94, nx_low=0.90),
            mrow(minute=3, bid_last=0.94, nx_low=0.90, nx_gap_min=5)]
    e = ingame.maker_entries(pd.DataFrame(rows), kind="bid_favourite", lo=0.90, hi=0.99)
    assert e.mins_in.tolist() == [2]


def test_maker_fee_is_charged_from_its_own_column():
    r = mrow(nx_low=0.90, maker_rate=0.0175)
    s = ingame.settle(ingame.maker_entries(pd.DataFrame([r]), kind="bid_favourite"), rate_col="maker_rate")
    ref = bt.settle("yes", 0.94, 1.0, 0.0175, 100.0)
    assert s.fee.iloc[0] == pytest.approx(ref.fee) and s.fee.iloc[0] > 0 and s.pnl.iloc[0] == pytest.approx(ref.pnl)


def test_unknown_maker_kind_or_fill_rule_raises():
    with pytest.raises(ValueError):
        ingame.maker_entries(pd.DataFrame([mrow()]), kind="both_sides")
    with pytest.raises(ValueError):
        ingame.maker_entries(pd.DataFrame([mrow()]), kind="bid_favourite", fill="maybe")
